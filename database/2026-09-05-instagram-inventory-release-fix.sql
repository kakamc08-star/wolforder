-- WolfOrder / Instagram inventory release fix
--
-- Apply this migration after 2026-09-04-instagram-shipping-workflow.sql.
-- Older Instagram orders can have order_items without a matching inventory
-- movement. Stock release must therefore use the order items as the source of
-- truth, with movement history kept as a fallback for legacy item-less rows.

begin;

-- =========================================================
-- Status changes: release/reserve the quantity represented by the order,
-- even when an older order has incomplete movement history.
-- =========================================================
create or replace function public.change_instagram_order_status_atomic(
  p_order_id uuid,
  p_new_status text,
  p_actor_user_id uuid,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.instagram_orders%rowtype;
  v_actor_role text;
  v_type text;
  v_old_active boolean;
  v_new_active boolean;
  v_stock_order boolean;
  v_item record;
  v_stock_available integer;
  v_stock_total integer;
  v_stock_delta integer;
  v_old_quantity integer;
  v_new_quantity integer;
  v_product_name text;
  v_color text;
  v_size text;
begin
  if p_new_status not in ('قيد المتابعة', 'تم', 'مؤجل', 'مرتجع', 'إلغاء') then
    raise exception 'حالة الطلب غير صالحة' using errcode = 'P0001';
  end if;

  select role into v_actor_role
  from public.users
  where id = p_actor_user_id;
  if not found then
    raise exception 'المستخدم غير موجود' using errcode = 'P0001';
  end if;

  select * into v_order
  from public.instagram_orders
  where id = p_order_id and is_archived = false
  for update;
  if not found then
    raise exception 'طلب Instagram غير موجود' using errcode = 'P0001';
  end if;

  v_type := coalesce(v_order.order_type, 'توصيل');
  if v_type = 'شحن' and coalesce(v_order.shipping_approval_status, 'pending') <> 'accepted' then
    raise exception 'طلب الشحن بانتظار موافقة الشركة' using errcode = 'P0001';
  end if;

  if v_actor_role = 'driver' then
    if v_type <> 'توصيل' or v_order.driver_id <> p_actor_user_id then
      raise exception 'الطلب غير معيّن لهذا السائق' using errcode = 'P0001';
    end if;
  elsif v_actor_role <> 'admin' then
    raise exception 'غير مصرح بتغيير حالة طلب Instagram' using errcode = 'P0001';
  end if;

  if v_order.status = p_new_status then
    return jsonb_build_object(
      'success', true,
      'duplicate', true,
      'id', p_order_id,
      'status', p_new_status
    );
  end if;

  v_old_active := v_order.status in ('قيد المتابعة', 'مؤجل', 'تم');
  v_new_active := p_new_status in ('قيد المتابعة', 'مؤجل', 'تم');
  v_stock_order := v_type = 'توصيل'
    or (v_type = 'شحن' and coalesce(v_order.shipping_approval_status, 'pending') = 'accepted');

  -- The quantity delta is derived from the actual order items, not from the
  -- audit table. This repairs old orders created before movement logging was
  -- complete and keeps later status transitions idempotent.
  for v_item in
    select affected.variant_id,
           coalesce(item_totals.item_quantity, 0)::integer as item_quantity
    from (
      select oi.variant_id
      from public.instagram_order_items oi
      where oi.order_id = p_order_id and oi.variant_id is not null
      union
      select movement.variant_id
      from public.instagram_inventory_movements movement
      where movement.order_id = p_order_id and movement.variant_id is not null
    ) affected
    left join (
      select oi.variant_id, sum(oi.quantity)::integer as item_quantity
      from public.instagram_order_items oi
      where oi.order_id = p_order_id
      group by oi.variant_id
    ) item_totals on item_totals.variant_id = affected.variant_id
    order by affected.variant_id
  loop
    v_old_quantity := case
      when v_old_active and v_stock_order then v_item.item_quantity
      else 0
    end;
    v_new_quantity := case
      when v_new_active and v_stock_order then v_item.item_quantity
      else 0
    end;
    v_stock_delta := v_old_quantity - v_new_quantity;

    if v_stock_delta = 0 then
      continue;
    end if;

    select stock_available, stock_total
    into v_stock_available, v_stock_total
    from public.instagram_variants
    where id = v_item.variant_id
    for update;
    if not found then
      raise exception 'تركيبة المخزون المرتبطة بالطلب غير موجودة' using errcode = 'P0001';
    end if;

    if v_stock_delta > 0 and v_stock_available + v_stock_delta > v_stock_total then
      raise exception 'تعذر تصحيح مخزون الصنف' using errcode = 'P0001';
    end if;
    if v_stock_delta < 0 and v_stock_available < abs(v_stock_delta) then
      raise exception 'الكمية المطلوبة غير متوفرة حالياً' using errcode = 'P0001';
    end if;

    update public.instagram_variants
    set stock_available = stock_available + v_stock_delta,
        updated_at = now()
    where id = v_item.variant_id;

    select product_name, color, size
    into v_product_name, v_color, v_size
    from public.instagram_order_items
    where order_id = p_order_id and variant_id = v_item.variant_id
    order by id
    limit 1;

    insert into public.instagram_inventory_movements (
      variant_id, order_id, order_item_id, movement_type, quantity,
      stock_total_delta, stock_available_delta, product_name, color, size,
      status_from, status_to, created_by_user_id, event_key, note
    ) values (
      v_item.variant_id,
      p_order_id,
      (select id from public.instagram_order_items
       where order_id = p_order_id and variant_id = v_item.variant_id
       order by id limit 1),
      case when v_stock_delta > 0 and p_new_status = 'مرتجع'
        then 'return_release'
        when v_stock_delta > 0 then 'cancellation_release'
        else 'reopen_reservation'
      end,
      abs(v_stock_delta),
      0,
      v_stock_delta,
      v_product_name,
      v_color,
      v_size,
      v_order.status,
      p_new_status,
      p_actor_user_id,
      gen_random_uuid()::text,
      coalesce(nullif(btrim(p_note), ''), 'تحرير مخزون تغيير حالة طلب Instagram')
    );
  end loop;

  update public.instagram_orders
  set status = p_new_status,
      note = case when p_note is null then note else btrim(p_note) end,
      updated_at = now()
  where id = p_order_id
  returning * into v_order;

  return jsonb_build_object(
    'success', true,
    'duplicate', false,
    'id', v_order.id,
    'status', v_order.status
  );
end;
$$;

-- =========================================================
-- Hard deletion: restore the active reservation from order_items. If an old
-- row has no item record, reverse its negative movement as a safe fallback.
-- =========================================================
create or replace function public.delete_instagram_order_atomic(
  p_order_id uuid,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.instagram_orders%rowtype;
  v_item record;
  v_stock_available integer;
  v_stock_total integer;
  v_restore integer;
  v_stock_order boolean;
  v_active_order boolean;
begin
  if not exists (
    select 1 from public.users
    where id = p_actor_user_id and role = 'admin'
  ) then
    raise exception 'غير مصرح بحذف طلب Instagram' using errcode = 'P0001';
  end if;

  select * into v_order
  from public.instagram_orders
  where id = p_order_id
  for update;
  if not found then
    raise exception 'طلب Instagram غير موجود' using errcode = 'P0001';
  end if;

  v_active_order := v_order.status in ('قيد المتابعة', 'مؤجل', 'تم');
  v_stock_order := coalesce(v_order.order_type, 'توصيل') = 'توصيل'
    or (coalesce(v_order.order_type, 'توصيل') = 'شحن'
      and coalesce(v_order.shipping_approval_status, 'pending') = 'accepted');

  for v_item in
    select affected.variant_id,
           coalesce(item_totals.item_quantity, 0)::integer as item_quantity,
           coalesce(movement_totals.net_delta, 0)::integer as movement_net_delta
    from (
      select oi.variant_id
      from public.instagram_order_items oi
      where oi.order_id = p_order_id and oi.variant_id is not null
      union
      select movement.variant_id
      from public.instagram_inventory_movements movement
      where movement.order_id = p_order_id and movement.variant_id is not null
    ) affected
    left join (
      select oi.variant_id, sum(oi.quantity)::integer as item_quantity
      from public.instagram_order_items oi
      where oi.order_id = p_order_id
      group by oi.variant_id
    ) item_totals on item_totals.variant_id = affected.variant_id
    left join (
      select movement.variant_id, sum(movement.stock_available_delta)::integer as net_delta
      from public.instagram_inventory_movements movement
      where movement.order_id = p_order_id and movement.variant_id is not null
      group by movement.variant_id
    ) movement_totals on movement_totals.variant_id = affected.variant_id
    order by affected.variant_id
  loop
    -- Active delivery/approved-shipping orders reserve their item quantity.
    -- For item-less legacy rows, a negative movement is the only available
    -- evidence that stock is still reserved.
    v_restore := case
      when v_item.item_quantity > 0 and v_active_order and v_stock_order
        then v_item.item_quantity
      when v_item.item_quantity = 0 and v_item.movement_net_delta < 0
        then abs(v_item.movement_net_delta)
      when v_item.item_quantity > 0 and not (v_active_order and v_stock_order)
        then greatest(-v_item.movement_net_delta, 0)
      else 0
    end;

    if v_restore = 0 then
      continue;
    end if;

    select stock_available, stock_total
    into v_stock_available, v_stock_total
    from public.instagram_variants
    where id = v_item.variant_id
    for update;
    if not found then
      raise exception 'تركيبة المخزون المرتبطة بالطلب غير موجودة' using errcode = 'P0001';
    end if;
    if v_stock_available + v_restore > v_stock_total then
      raise exception 'تعذر تصحيح المخزون عند حذف الطلب' using errcode = 'P0001';
    end if;

    update public.instagram_variants
    set stock_available = stock_available + v_restore,
        updated_at = now()
    where id = v_item.variant_id;
  end loop;

  -- The live Instagram schema may not have the optional status-history table.
  -- Inventory release does not depend on that audit table, so cleanup is
  -- intentionally limited to tables guaranteed by the active schema.
  delete from public.instagram_inventory_movements where order_id = p_order_id;
  delete from public.instagram_order_items where order_id = p_order_id;
  delete from public.instagram_orders where id = p_order_id;

  return jsonb_build_object(
    'success', true,
    'deleted_order_id', p_order_id,
    'deleted_order_number', v_order.order_number
  );
end;
$$;

-- =========================================================
-- Public catalog: only active products/variants with available stock are
-- returned. Once deletion or restocking increases stock_available, the same
-- link exposes the variant again on its next refresh.
-- =========================================================
create or replace function public.get_instagram_storefront_catalog_filtered(
  p_slug text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id uuid;
  v_company_name text;
  v_catalog jsonb;
begin
  select link.company_id,
         coalesce(nullif(btrim(company.name), ''), nullif(btrim(company.username), ''), '')
  into v_company_id, v_company_name
  from public.instagram_company_links link
  join public.users company
    on company.id = link.company_id
   and company.role = 'company'
  where link.slug = btrim(coalesce(p_slug, ''))
    and link.is_active = true
  limit 1;

  if not found then
    raise exception 'رابط غير موجود أو متوقف' using errcode = 'P0001';
  end if;

  select jsonb_build_object(
    'company_name', v_company_name,
    'products', coalesce(
      jsonb_agg(
        jsonb_build_object(
          'product_id', catalog.product_id,
          'name', catalog.name,
          'unit_price', catalog.unit_price,
          'currency', catalog.currency,
          'variants', catalog.variants
        )
        order by catalog.created_at, catalog.product_id
      ),
      '[]'::jsonb
    )
  )
  into v_catalog
  from (
    select product.id as product_id,
           product.name,
           product.unit_price,
           coalesce(product.currency, 'ل.س') as currency,
           product.created_at,
           (
             select coalesce(
               jsonb_agg(
                 jsonb_build_object(
                   'size', variant.size,
                   'color', variant.color,
                   'variant_id', variant.id,
                   'stock_available', variant.stock_available
                 )
                 order by variant.created_at, variant.id
               ),
               '[]'::jsonb
             )
             from public.instagram_variants variant
             where variant.product_id = product.id
               and variant.is_active = true
               and variant.stock_available > 0
           ) as variants
    from public.instagram_products product
    where product.company_id = v_company_id
      and product.status = 'active'
      and exists (
        select 1
        from public.instagram_variants available_variant
        where available_variant.product_id = product.id
          and available_variant.is_active = true
          and available_variant.stock_available > 0
      )
  ) catalog;

  return v_catalog;
end;
$$;

revoke all on function public.change_instagram_order_status_atomic(uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function public.delete_instagram_order_atomic(uuid, uuid) from public, anon, authenticated;
revoke all on function public.get_instagram_storefront_catalog_filtered(text) from public, anon, authenticated;

grant execute on function public.change_instagram_order_status_atomic(uuid, text, uuid, text) to service_role;
grant execute on function public.delete_instagram_order_atomic(uuid, uuid) to service_role;
grant execute on function public.get_instagram_storefront_catalog_filtered(text) to service_role;

commit;
