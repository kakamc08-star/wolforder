-- WolfOrder / Instagram only / 2026-09-30
-- Apply AFTER 2026-09-05-instagram-shipping-pending-reservation.sql.
-- Existing shipping_delivery_status values are reused: pending / delivered.
-- No normal orders, company accounts, or delivery workflows are changed.
begin;

-- Finish existing pending reservations before retiring approval. The previous
-- idempotent helper subtracts ONLY the missing reservation, never twice.
-- A shortage aborts this entire migration, preserving all previous data.
do $$
declare v_id uuid;
begin
  if to_regclass('public.instagram_inventory_summary') is null then
    raise exception 'INSTAGRAM_SCHEMA_MISSING: جدول ملخص الجرد الحالي غير موجود';
  end if;
  for v_id in
    select id from public.instagram_orders
    where order_type = 'شحن' and coalesce(shipping_approval_status, 'pending') = 'pending'
      and coalesce(is_archived, false) = false and status in ('قيد المتابعة', 'مؤجل', 'تم')
    order by created_at, id
  loop
    perform public.reserve_instagram_shipping_order_stock(v_id, 'reservation', 'تثبيت حجز الشحن عند إلغاء الموافقة');
  end loop;
end;
$$;

-- Keep the old approval column as a compatibility marker for earlier stock
-- functions; it no longer controls visibility, actions, or delivery status.
update public.instagram_orders
set shipping_approval_status = 'accepted'
where order_type = 'شحن' and shipping_approval_status is distinct from 'accepted';
update public.instagram_orders
set shipping_delivery_status = 'pending'
where order_type = 'شحن' and (shipping_delivery_status is null or shipping_delivery_status = '');

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.instagram_orders'::regclass and conname = 'instagram_shipping_two_delivery_states_check') then
    alter table public.instagram_orders add constraint instagram_shipping_two_delivery_states_check
      check (order_type <> 'شحن' or shipping_delivery_status in ('pending', 'delivered'));
  end if;
end;
$$;

create or replace function public.instagram_shipping_direct_entry_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.order_type = 'شحن' then
    new.shipping_approval_status := 'accepted';
    new.shipping_delivery_status := coalesce(nullif(new.shipping_delivery_status, ''), 'pending');
    if new.shipping_delivery_status not in ('pending', 'delivered') then
      raise exception 'طلبات الشحن تستخدم تم التسليم أو لم يتم التسليم فقط';
    end if;
    if tg_op = 'UPDATE' then
      if old.order_type = 'شحن' and new.status is distinct from old.status then
        raise exception 'طلبات الشحن تستخدم حالة التسليم فقط';
      end if;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists instagram_shipping_direct_entry_guard on public.instagram_orders;
create trigger instagram_shipping_direct_entry_guard before insert or update on public.instagram_orders
for each row execute function public.instagram_shipping_direct_entry_guard();

-- Supplement the existing inventory view without dropping or changing it.
-- Shipping changes buckets on delivery; variant availability stays unchanged.
-- Released legacy rows retain their old inventory treatment and historical data.
create or replace view public.instagram_inventory_delivery_totals with (security_invoker = true) as
select product.company_id, product.id as product_id, variant.color, variant.size,
  coalesce(sum(item.quantity) filter (where ord.order_type = 'شحن'
    and coalesce(ord.shipping_delivery_status, 'pending') = 'pending'
    and ord.status in ('قيد المتابعة', 'مؤجل', 'تم')), 0)::bigint as reserved_shipping,
  coalesce(sum(item.quantity) filter (where ord.order_type = 'شحن'
    and ord.shipping_delivery_status = 'delivered'
    and ord.status in ('قيد المتابعة', 'مؤجل', 'تم')), 0)::bigint as shipping_delivered,
  coalesce(sum(item.quantity) filter (where coalesce(ord.order_type, 'توصيل') = 'توصيل'
    and ord.status = 'تم'), 0)::bigint as sold_delivery
from public.instagram_variants variant
join public.instagram_products product on product.id = variant.product_id
left join public.instagram_order_items item on item.variant_id = variant.id
left join public.instagram_orders ord on ord.id = item.order_id
group by product.company_id, product.id, variant.color, variant.size;
revoke all on public.instagram_inventory_delivery_totals from public, anon, authenticated;
grant select on public.instagram_inventory_delivery_totals to service_role;

create or replace function public.create_instagram_order_atomic(
  p_slug text,
  p_customer_name text,
  p_customer_number text,
  p_address text,
  p_order_type text,
  p_items jsonb,
  p_idempotency_key uuid,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order_type text;
  v_company_id uuid;
  v_company_name text;
  v_order_number bigint;
  v_existing public.instagram_orders%rowtype;
  v_order public.instagram_orders%rowtype;
  v_items jsonb;
  v_item record;
  v_item_id uuid;
  v_product_id uuid;
  v_product_name text;
  v_color text;
  v_size text;
  v_unit_price numeric;
  v_currency text;
  v_selected_currency text;
  v_stock_available integer;
  v_items_total numeric := 0;
  v_shipping_fee numeric := 0;
  v_name_parts integer;
  v_movement_event text;
  v_movement_note text;
begin
  select link.company_id, company.name, link.next_order_number
  into v_company_id, v_company_name, v_order_number
  from public.instagram_company_links link
  join public.users company
    on company.id = link.company_id
   and company.role = 'company'
  where link.slug = btrim(coalesce(p_slug, ''))
    and link.is_active = true
  for update of link;

  if not found then
    raise exception 'رابط Instagram غير صالح أو متوقف' using errcode = 'P0001';
  end if;

  if p_idempotency_key is null then
    raise exception 'مفتاح الطلب غير صالح' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  select * into v_existing
  from public.instagram_orders
  where idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object(
      'id', v_existing.id,
      'order_number', v_existing.order_number,
      'duplicate', true,
      'order_type', coalesce(v_existing.order_type, 'توصيل'),
      'items_total', coalesce(v_existing.items_total, v_existing.total_price, 0),
      'shipping_fee', coalesce(v_existing.shipping_fee, 0),
      'total_price', coalesce(v_existing.total_price, 0),
      'currency', coalesce(v_existing.currency, 'ل.س'),
      'shipping_delivery_status', coalesce(v_existing.shipping_delivery_status, 'pending')
    );
  end if;

  v_order_type := case lower(btrim(coalesce(p_order_type, '')))
    when 'delivery' then 'توصيل'
    when 'shipping' then 'شحن'
    else btrim(coalesce(p_order_type, ''))
  end;
  if v_order_type not in ('توصيل', 'شحن') then
    raise exception 'نوع الطلب غير صالح' using errcode = 'P0001';
  end if;

  if char_length(btrim(coalesce(p_customer_name, ''))) not between 2 and 100 then
    raise exception 'الاسم مطلوب ويجب أن يتكون من حرفين على الأقل' using errcode = 'P0001';
  end if;
  if v_order_type = 'شحن' then
    select count(*) into v_name_parts
    from regexp_split_to_table(btrim(p_customer_name), '\s+') as part
    where btrim(part) <> '';
    if v_name_parts < 3 then
      raise exception 'لطلبات الشحن يجب إدخال الاسم الثلاثي (3 أجزاء على الأقل)' using errcode = 'P0001';
    end if;
  end if;
  if coalesce(p_customer_number, '') !~ '^[0-9]{10}$' then
    raise exception 'رقم العميل يجب أن يتكون من 10 أرقام' using errcode = 'P0001';
  end if;
  if char_length(coalesce(p_address, '')) > 300 then
    raise exception 'العنوان طويل جداً' using errcode = 'P0001';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'قائمة الأصناف غير صالحة' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 50 then
    raise exception 'يجب اختيار صنف واحد على الأقل' using errcode = 'P0001';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_items) as raw(item)
    where jsonb_typeof(raw.item) <> 'object'
       or coalesce(raw.item->>'variant_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or coalesce(raw.item->>'quantity', '') !~ '^[0-9]+$'
  ) then
    raise exception 'الصنف أو الكمية غير صالحة' using errcode = 'P0001';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_items) as raw(item)
    where (raw.item->>'quantity')::integer < 1
       or (raw.item->>'quantity')::integer > 1000
  ) then
    raise exception 'الكمية يجب أن تكون بين 1 و1000' using errcode = 'P0001';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object('variant_id', variant_id, 'quantity', quantity)
      order by variant_id
    ), '[]'::jsonb
  )
  into v_items
  from (
    select
      (raw.item->>'variant_id')::uuid as variant_id,
      sum((raw.item->>'quantity')::integer)::integer as quantity
    from jsonb_array_elements(p_items) as raw(item)
    group by (raw.item->>'variant_id')::uuid
  ) merged;

  if exists (
    select 1 from jsonb_array_elements(v_items) as raw(item)
    where (raw.item->>'quantity')::integer > 1000
  ) then
    raise exception 'إجمالي كمية الصنف الواحد يتجاوز الحد المسموح' using errcode = 'P0001';
  end if;

  -- Both order types reserve immediately. This prevents a pending shipping
  -- order from allowing the same piece to be ordered twice.
  for v_item in
    select
      (raw.item->>'variant_id')::uuid as variant_id,
      (raw.item->>'quantity')::integer as quantity
    from jsonb_array_elements(v_items) as raw(item)
    order by 1
  loop
    select v.product_id, v.color, v.size, v.stock_available,
           product.name, product.unit_price, product.currency
    into v_product_id, v_color, v_size, v_stock_available,
         v_product_name, v_unit_price, v_currency
    from public.instagram_variants v
    join public.instagram_products product on product.id = v.product_id
    where v.id = v_item.variant_id
      and v.is_active = true
      and product.company_id = v_company_id
      and product.status = 'active'
    for update;

    if not found then
      raise exception 'الصنف المحدد غير موجود أو متوقف' using errcode = 'P0001';
    end if;
    if v_selected_currency is null then
      v_selected_currency := coalesce(v_currency, 'ل.س');
    elsif v_selected_currency <> coalesce(v_currency, 'ل.س') then
      raise exception 'لا يمكن جمع عملات مختلفة في طلب واحد' using errcode = 'P0001';
    end if;
    v_items_total := v_items_total + coalesce(v_unit_price, 0) * v_item.quantity;
    if v_stock_available < v_item.quantity then
      raise exception 'الكمية المطلوبة غير متوفرة حالياً' using errcode = 'P0001';
    end if;
  end loop;

  if v_order_type = 'شحن' then
    if coalesce(v_selected_currency, 'ل.س') <> 'ل.س' then
      raise exception 'أجور الشحن متاحة مع المنتجات المسعرة بالليرة السورية فقط' using errcode = 'P0001';
    end if;
    v_shipping_fee := 10000;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('instagram:order-number', 0));
  if coalesce(v_order_number, 0) < 1 then
    select coalesce(max(order_number), 0) + 1
    into v_order_number
    from public.instagram_orders
    where company_id = v_company_id;
    v_order_number := greatest(coalesce(v_order_number, 1), 1);
  end if;
  while exists (
    select 1 from public.instagram_orders
    where order_number = v_order_number
  ) loop
    v_order_number := v_order_number + 1;
  end loop;

  update public.instagram_company_links
  set next_order_number = v_order_number + 1,
      updated_at = now()
  where company_id = v_company_id;

  insert into public.instagram_orders (
    order_number, company_id, company_name, customer_name, customer_number,
    address, order_type, order_source, total_price, currency, ratio, status,
    note, driver_id, driver_name, shipping_approval_status, shipping_fee,
    items_total, shipping_delivery_status, idempotency_key, is_archived
  ) values (
    v_order_number, v_company_id, coalesce(v_company_name, ''),
    btrim(p_customer_name), p_customer_number, btrim(p_address), v_order_type,
    'instagram', v_items_total + v_shipping_fee, coalesce(v_selected_currency, 'ل.س'),
    0, 'قيد المتابعة', btrim(coalesce(p_note, '')), null, '',
    case when v_order_type = 'شحن' then 'accepted' else 'not_required' end,
    v_shipping_fee, v_items_total, 'pending', p_idempotency_key, false
  ) returning * into v_order;

  v_movement_event := case
    when v_order_type = 'شحن' then 'instagram:shipping-reservation:'
    else 'instagram:delivery-reservation:'
  end;
  v_movement_note := case
    when v_order_type = 'شحن' then 'حجز طلب Instagram للشحن'
    else 'حجز طلب Instagram للتوصيل'
  end;

  for v_item in
    select
      (raw.item->>'variant_id')::uuid as variant_id,
      (raw.item->>'quantity')::integer as quantity
    from jsonb_array_elements(v_items) as raw(item)
    order by 1
  loop
    select v.product_id, v.color, v.size, product.name, product.unit_price
    into v_product_id, v_color, v_size, v_product_name, v_unit_price
    from public.instagram_variants v
    join public.instagram_products product on product.id = v.product_id
    where v.id = v_item.variant_id
      and product.company_id = v_company_id;

    insert into public.instagram_order_items (
      order_id, product_id, variant_id, product_name, color, size,
      unit_price, quantity
    ) values (
      v_order.id, v_product_id, v_item.variant_id, v_product_name, v_color,
      v_size, v_unit_price, v_item.quantity
    ) returning id into v_item_id;

    update public.instagram_variants
    set stock_available = stock_available - v_item.quantity,
        updated_at = now()
    where id = v_item.variant_id
      and stock_available >= v_item.quantity;
    if not found then
      raise exception 'الكمية المطلوبة غير متوفرة حالياً' using errcode = 'P0001';
    end if;

    insert into public.instagram_inventory_movements (
      variant_id, order_id, order_item_id, movement_type, quantity,
      stock_total_delta, stock_available_delta, product_name, color, size,
      status_from, status_to, created_by_user_id, event_key, note
    ) values (
      v_item.variant_id, v_order.id, v_item_id, 'reservation', v_item.quantity,
      0, -v_item.quantity, v_product_name, v_color, v_size,
      null, 'قيد المتابعة', null,
      format('%s%s:%s', v_movement_event, v_order.id, v_item.variant_id),
      v_movement_note
    );
  end loop;

  return jsonb_build_object(
    'id', v_order.id,
    'order_number', v_order.order_number,
    'duplicate', false,
    'order_type', v_order.order_type,
    'items_total', v_order.items_total,
    'shipping_fee', v_order.shipping_fee,
    'total_price', v_order.total_price,
    'currency', v_order.currency,
    'shipping_delivery_status', v_order.shipping_delivery_status
  );
end;
$$;

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
  if v_type = 'شحن' then
    raise exception 'طلبات الشحن تستخدم تم التسليم أو لم يتم التسليم فقط' using errcode = 'P0001';
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

create or replace function public.set_instagram_shipping_delivery_status_atomic(
  p_order_ids uuid[], p_delivery_status text, p_actor_user_id uuid
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid; v_order public.instagram_orders%rowtype; v_company_name text;
  v_changed integer := 0; v_duplicate integer := 0; v_skipped integer := 0;
  v_changed_ids uuid[] := array[]::uuid[];
begin
  if not exists (select 1 from public.users where id = p_actor_user_id and role = 'admin') then
    raise exception 'غير مصرح بتغيير حالة تسليم الشحن';
  end if;
  if p_delivery_status is null or p_delivery_status not in ('pending', 'delivered') then
    raise exception 'حالة تسليم الشحن غير صالحة';
  end if;
  if p_order_ids is null or cardinality(p_order_ids) not between 1 and 500 then
    raise exception 'لم يتم تحديد طلبات صالحة';
  end if;
  for v_id in select distinct value from unnest(p_order_ids) as selected(value) order by value
  loop
    select * into v_order from public.instagram_orders where id = v_id for update;
    if not found or v_order.order_type <> 'شحن' or coalesce(v_order.is_archived, false) then
      v_skipped := v_skipped + 1; continue;
    end if;
    if coalesce(v_order.shipping_delivery_status, 'pending') = p_delivery_status then
      v_duplicate := v_duplicate + 1; continue;
    end if;
    select coalesce(nullif(btrim(name), ''), nullif(btrim(username), '')) into v_company_name
    from public.users where id = v_order.company_id and role = 'company';
    v_company_name := coalesce(v_company_name, nullif(btrim(v_order.company_name), ''), 'غير معروف');
    update public.instagram_orders
    set shipping_delivery_status = p_delivery_status,
        shipping_delivered_at = case when p_delivery_status = 'delivered' then now() else null end,
        shipping_delivered_by = case when p_delivery_status = 'delivered' then p_actor_user_id else null end,
        shipping_delivered_to_name = case when p_delivery_status = 'delivered' then v_company_name else null end,
        updated_at = now()
    where id = v_id;
    v_changed := v_changed + 1; v_changed_ids := array_append(v_changed_ids, v_id);
  end loop;
  return jsonb_build_object('success', true, 'changed_count', v_changed, 'duplicate_count', v_duplicate,
    'skipped_count', v_skipped, 'changed_ids', to_jsonb(v_changed_ids));
end;
$$;

create or replace function public.mark_instagram_shipping_delivered_atomic(p_order_ids uuid[], p_actor_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_result jsonb;
begin
  v_result := public.set_instagram_shipping_delivery_status_atomic(p_order_ids, 'delivered', p_actor_user_id);
  return v_result || jsonb_build_object('delivered_count', v_result->'changed_count', 'delivered_ids', v_result->'changed_ids');
end;
$$;


create or replace function public.update_instagram_order_atomic(
  p_order_id uuid,
  p_actor_user_id uuid,
  p_order_number bigint default null,
  p_customer_name text default null,
  p_customer_number text default null,
  p_address text default null,
  p_total_price numeric default null,
  p_ratio numeric default null,
  p_note text default null,
  p_status text default null,
  p_driver_id uuid default null,
  p_company_id uuid default null,
  p_items jsonb default null,
  p_recalculate_total_price boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.instagram_orders%rowtype;
  v_is_shipping boolean;
  v_company_id uuid;
  v_company_name text;
  v_driver_name text;
  v_customer_name text;
  v_customer_number text;
  v_address text;
  v_new_status text;
  v_total_price numeric;
  v_computed_total numeric := 0;
  v_ratio numeric;
  v_desired_items jsonb;
  v_variant_id uuid;
  v_item_count integer;
  v_old_active boolean;
  v_new_active boolean;
  v_old_item record;
  v_desired_item record;
  v_product_name text;
  v_product_id uuid;
  v_color text;
  v_size text;
  v_unit_price numeric;
  v_currency text;
  v_stock_available integer;
  v_stock_total integer;
  v_desired_quantity integer;
  v_existing_net_delta integer;
  v_target_net_delta integer;
  v_movement_delta integer;
begin
  if not exists (
    select 1
    from public.users
    where id = p_actor_user_id and role = 'admin'
  ) then
    raise exception 'غير مصرح بتعديل طلب Instagram';
  end if;

  select *
  into v_order
  from public.instagram_orders
  where id = p_order_id and is_archived = false
  for update;

  if not found then
    raise exception 'طلب Instagram غير موجود';
  end if;
  v_is_shipping := coalesce(v_order.order_type, 'توصيل') = 'شحن';
  if v_is_shipping and (p_driver_id is not null
    or (p_company_id is not null and p_company_id <> v_order.company_id)
    or (p_status is not null and p_status <> v_order.status)) then
    raise exception 'لا يمكن تغيير الشركة أو السائق أو الحالة العامة لطلب الشحن';
  end if;

  v_company_id := coalesce(p_company_id, v_order.company_id);
  select name
  into v_company_name
  from public.users
  where id = v_company_id and role = 'company';
  if not found then
    raise exception 'الشركة المحددة غير موجودة';
  end if;

  if p_driver_id is not null then
    select name
    into v_driver_name
    from public.users
    where id = p_driver_id and role = 'driver';
    if not found then
      raise exception 'السائق المحدد غير موجود';
    end if;
  else
    v_driver_name := '';
  end if;

  if p_order_number is not null and p_order_number < 1 then
    raise exception 'رقم الطلب غير صالح';
  end if;

  if (p_order_number is not null and p_order_number is distinct from v_order.order_number) and exists (
    select 1
    from public.instagram_orders
    where order_number = coalesce(p_order_number, v_order.order_number)
      and (not v_is_shipping or company_id = v_company_id)
      and id <> p_order_id
  ) then
    raise exception 'رقم الطلب مستخدم مسبقاً';
  end if;

  v_customer_name := coalesce(p_customer_name, v_order.customer_name);
  v_customer_number := coalesce(p_customer_number, v_order.customer_number);
  v_address := coalesce(p_address, v_order.address);
  v_new_status := coalesce(nullif(btrim(p_status), ''), v_order.status);
  v_total_price := coalesce(p_total_price, v_order.total_price, 0);
  v_ratio := coalesce(p_ratio, v_order.ratio, 0);

  if char_length(btrim(v_customer_name)) not between 2 and 100 then
    raise exception 'اسم العميل مطلوب ويجب أن يتكون من حرفين على الأقل';
  end if;
  if (not v_is_shipping and char_length(btrim(v_address)) < 5) or char_length(btrim(v_address)) > 300 then
    raise exception 'العنوان مطلوب ويجب أن يكون واضحاً';
  end if;
  if v_total_price < 0 or v_ratio < 0 then
    raise exception 'السعر أو النسبة غير صالح';
  end if;
  if v_new_status not in ('قيد المتابعة', 'تم', 'مؤجل', 'مرتجع', 'إلغاء') then
    raise exception 'حالة الطلب غير صالحة';
  end if;

  if v_is_shipping and (
    (select count(*) from regexp_split_to_table(btrim(v_customer_name), '\s+') as part where part <> '') < 3
    or v_customer_number !~ '^[0-9]{10}$'
    or (p_total_price is not null and p_total_price < coalesce(v_order.shipping_fee, 0))
  ) then
    raise exception 'بيانات الشحن أو السعر النهائي غير صالحة';
  end if;

  -- Metadata-only shipping edits do not rewrite items or touch inventory.
  if v_is_shipping and p_items is null then
    update public.instagram_orders
    set order_number = coalesce(p_order_number, v_order.order_number),
        customer_name = v_customer_name, customer_number = v_customer_number,
        address = v_address, total_price = v_total_price,
        items_total = greatest(v_total_price - coalesce(shipping_fee, 0), 0),
        ratio = v_ratio, note = coalesce(p_note, v_order.note), updated_at = now()
    where id = p_order_id returning * into v_order;
    return to_jsonb(v_order);
  end if;

  -- إذا لم تُرسل الأصناف، نعيد استخدام الأصناف الحالية مع تطبيق تغيير الحالة.
  if p_items is null then
    select coalesce(
      jsonb_agg(
        jsonb_build_object('variant_id', variant_id, 'quantity', quantity)
        order by variant_id
      ),
      '[]'::jsonb
    )
    into v_desired_items
    from (
      select variant_id, sum(quantity)::integer as quantity
      from public.instagram_order_items
      where order_id = p_order_id
      group by variant_id
    ) current_items;
  else
    if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0
      or jsonb_array_length(p_items) > 50 then
      raise exception 'يجب أن يحتوي الطلب على صنف واحد على الأقل';
    end if;

    if exists (
      select 1
      from jsonb_array_elements(p_items) as item
      where jsonb_typeof(item) <> 'object'
        or coalesce(item->>'variant_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or coalesce(item->>'quantity', '') !~ '^[0-9]+$'
    ) then
      raise exception 'الصنف أو الكمية غير صالحة';
    end if;

    if exists (
      select 1
      from jsonb_array_elements(p_items) as item
      where (item->>'quantity')::numeric < 1
         or (item->>'quantity')::numeric > 1000
    ) then
      raise exception 'الكمية يجب أن تكون بين 1 و1000';
    end if;

    select coalesce(
      jsonb_agg(
        jsonb_build_object('variant_id', variant_id, 'quantity', quantity)
        order by variant_id
      ),
      '[]'::jsonb
    )
    into v_desired_items
    from (
      select
        (item->>'variant_id')::uuid as variant_id,
        sum((item->>'quantity')::integer)::integer as quantity
      from jsonb_array_elements(p_items) as item
      group by (item->>'variant_id')::uuid
    ) merged_items;
  end if;

  v_item_count := jsonb_array_length(v_desired_items);
  if v_item_count < 1 then
    raise exception 'لا يمكن حفظ طلب بدون أصناف';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_desired_items) as item
    where (item->>'quantity')::integer < 1
       or (item->>'quantity')::integer > 1000
  ) then
    raise exception 'الكمية يجب أن تكون بين 1 و1000';
  end if;

  -- قفل كل التركيبات القديمة والجديدة بترتيب ثابت لمنع تعارض التعديلات المتزامنة.
  for v_variant_id in
    select distinct variant_id
    from (
      select oi.variant_id
      from public.instagram_order_items oi
      where oi.order_id = p_order_id
      union
      select movement.variant_id
      from public.instagram_inventory_movements movement
      where movement.order_id = p_order_id
      union
      select (item->>'variant_id')::uuid
      from jsonb_array_elements(v_desired_items) as item
    ) locked_variants
    where variant_id is not null
    order by variant_id
  loop
    perform 1
    from public.instagram_variants
    where id = v_variant_id
    for update;
    if not found then
      raise exception 'تركيبة الصنف غير موجودة';
    end if;
  end loop;

  -- التحقق من الأصناف وحساب الإجمالي من السعر الموجود في إدارة الأصناف.
  for v_desired_item in
    select (item->>'variant_id')::uuid as variant_id,
           (item->>'quantity')::integer as quantity
    from jsonb_array_elements(v_desired_items) as item
  loop
    select v.product_id, v.color, v.size, p.name, p.unit_price, p.currency
    into v_product_id, v_color, v_size, v_product_name, v_unit_price, v_currency
    from public.instagram_variants v
    join public.instagram_products p on p.id = v.product_id
    where v.id = v_desired_item.variant_id
      and p.company_id = v_company_id;

    if not found then
      raise exception 'الصنف المحدد غير موجود ضمن الشركة';
    end if;

    if v_is_shipping and coalesce(v_currency, 'ل.س') <> 'ل.س' then
      raise exception 'طلبات الشحن متاحة بالليرة السورية فقط';
    end if;

    v_computed_total := v_computed_total + (coalesce(v_unit_price, 0) * v_desired_item.quantity);
  end loop;

  if p_recalculate_total_price then
    v_total_price := v_computed_total + case when v_is_shipping then coalesce(v_order.shipping_fee, 0) else 0 end;
  end if;

  v_old_active := v_order.status in ('قيد المتابعة', 'مؤجل', 'تم');
  v_new_active := v_new_status in ('قيد المتابعة', 'مؤجل', 'تم');

  -- تحرير حجز/بيع الأصناف القديمة عند الحاجة.
  if v_old_active then
    for v_old_item in
      select variant_id, sum(quantity)::integer as quantity
      from public.instagram_order_items
      where order_id = p_order_id
      group by variant_id
    loop
      select stock_available, stock_total
      into v_stock_available, v_stock_total
      from public.instagram_variants
      where id = v_old_item.variant_id
      for update;

      if not found or v_stock_available + v_old_item.quantity > v_stock_total then
        raise exception 'تعذر تصحيح مخزون الصنف القديم';
      end if;

      update public.instagram_variants
      set stock_available = stock_available + v_old_item.quantity,
          updated_at = now()
      where id = v_old_item.variant_id;
    end loop;
  end if;

  -- حجز الأصناف الجديدة إذا كانت الحالة تحتسب ضمن المخزون المشغول.
  if v_new_active then
    for v_desired_item in
      select (item->>'variant_id')::uuid as variant_id,
             (item->>'quantity')::integer as quantity
      from jsonb_array_elements(v_desired_items) as item
    loop
      select stock_available
      into v_stock_available
      from public.instagram_variants
      where id = v_desired_item.variant_id
      for update;

      if not found or v_stock_available < v_desired_item.quantity then
        raise exception 'الكمية المطلوبة غير متوفرة حالياً';
      end if;

      update public.instagram_variants
      set stock_available = stock_available - v_desired_item.quantity,
          updated_at = now()
      where id = v_desired_item.variant_id;
    end loop;
  end if;

  delete from public.instagram_order_items
  where order_id = p_order_id;

  for v_desired_item in
    select (item->>'variant_id')::uuid as variant_id,
           (item->>'quantity')::integer as quantity
    from jsonb_array_elements(v_desired_items) as item
  loop
    select v.product_id, v.color, v.size, p.name, p.unit_price
    into v_product_id, v_color, v_size, v_product_name, v_unit_price
    from public.instagram_variants v
    join public.instagram_products p on p.id = v.product_id
    where v.id = v_desired_item.variant_id
      and p.company_id = v_company_id;

    insert into public.instagram_order_items (
      order_id,
      product_id,
      variant_id,
      product_name,
      color,
      size,
      unit_price,
      quantity
    ) values (
      p_order_id,
      v_product_id,
      v_desired_item.variant_id,
      v_product_name,
      v_color,
      v_size,
      v_unit_price,
      v_desired_item.quantity
    );
  end loop;

  -- احتفظ بسجل صافي أثر هذا الطلب على المخزون حتى تبقى عمليات تغيير الحالة
  -- والحذف اللاحقة قادرة على عكس أثر التعديل. لا نضيف حركة إذا لم يتغير الأثر.
  for v_variant_id in
    select distinct variant_id
    from (
      select oi.variant_id
      from public.instagram_order_items oi
      where oi.order_id = p_order_id
      union
      select movement.variant_id
      from public.instagram_inventory_movements movement
      where movement.order_id = p_order_id
      union
      select (item->>'variant_id')::uuid
      from jsonb_array_elements(v_desired_items) as item
    ) affected_variants
    where variant_id is not null
    order by variant_id
  loop
    select coalesce(sum(stock_available_delta), 0)::integer
    into v_existing_net_delta
    from public.instagram_inventory_movements
    where order_id = p_order_id
      and variant_id = v_variant_id;

    select coalesce(sum((item->>'quantity')::integer), 0)::integer
    into v_desired_quantity
    from jsonb_array_elements(v_desired_items) as item
    where (item->>'variant_id')::uuid = v_variant_id;

    v_target_net_delta := case when v_new_active then -v_desired_quantity else 0 end;
    v_movement_delta := v_target_net_delta - v_existing_net_delta;

    if v_movement_delta <> 0 then
      select v.color, v.size, p.name
      into v_color, v_size, v_product_name
      from public.instagram_variants v
      join public.instagram_products p on p.id = v.product_id
      where v.id = v_variant_id;

      insert into public.instagram_inventory_movements (
        variant_id,
        order_id,
        movement_type,
        quantity,
        stock_total_delta,
        stock_available_delta,
        product_name,
        color,
        size,
        status_from,
        status_to,
        created_by_user_id,
        event_key,
        note
      ) values (
        v_variant_id,
        p_order_id,
        'adjustment',
        abs(v_movement_delta),
        0,
        v_movement_delta,
        v_product_name,
        v_color,
        v_size,
        v_order.status,
        v_new_status,
        p_actor_user_id,
        'instagram:order-edit:' || p_order_id::text || ':' || gen_random_uuid()::text,
        'تعديل أصناف طلب Instagram'
      );
    end if;
  end loop;

  update public.instagram_orders
  set order_number = coalesce(p_order_number, v_order.order_number),
      company_id = v_company_id,
      company_name = v_company_name,
      customer_name = v_customer_name,
      customer_number = v_customer_number,
      address = v_address,
      total_price = v_total_price,
      items_total = case when v_is_shipping then greatest(v_total_price - coalesce(shipping_fee, 0), 0) else items_total end,
      ratio = v_ratio,
      status = v_new_status,
      note = coalesce(p_note, v_order.note),
      driver_id = p_driver_id,
      driver_name = coalesce(v_driver_name, ''),
      updated_at = now()
  where id = p_order_id
  returning * into v_order;

  return to_jsonb(v_order) || jsonb_build_object(
    'items', coalesce(
      (
        select jsonb_agg(to_jsonb(item) order by item.created_at, item.id)
        from public.instagram_order_items item
        where item.order_id = p_order_id
      ),
      '[]'::jsonb
    )
  );
end;
$$;

-- Edit-request approval is independent of the two shipping delivery states.
create table if not exists public.instagram_order_edit_requests (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.instagram_orders(id) on delete cascade,
  company_id uuid not null references public.users(id) on delete cascade,
  requested_by_user_id uuid references public.users(id) on delete set null,
  requested_by_name text not null default '',
  requested_changes jsonb not null check (jsonb_typeof(requested_changes) = 'object'),
  original_values jsonb not null,
  original_items jsonb not null default '[]'::jsonb,
  proposed_items jsonb not null default '[]'::jsonb,
  reason text not null default '',
  status text not null default 'معلق' check (status in ('معلق', 'مقبول', 'مرفوض')),
  admin_note text not null default '',
  responded_by_user_id uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  responded_at timestamptz
);
create unique index if not exists instagram_one_pending_edit_per_order
  on public.instagram_order_edit_requests(order_id) where status = 'معلق';
create index if not exists instagram_edit_requests_company_created
  on public.instagram_order_edit_requests(company_id, created_at desc);
alter table public.instagram_order_edit_requests enable row level security;
revoke all on public.instagram_order_edit_requests from public, anon, authenticated;
grant select, insert, update, delete on public.instagram_order_edit_requests to service_role;

create or replace function public.instagram_order_edit_snapshot(p_order_id uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'order_number', ord.order_number, 'company_id', ord.company_id,
    'customer_name', ord.customer_name, 'customer_number', ord.customer_number,
    'address', ord.address, 'note', coalesce(ord.note, ''), 'total_price', ord.total_price,
    'status', ord.status, 'shipping_delivery_status', coalesce(ord.shipping_delivery_status, 'pending'),
    'items', coalesce((select jsonb_agg(jsonb_build_object('variant_id', items.variant_id, 'quantity', items.quantity) order by items.variant_id)
      from (select variant_id, sum(quantity)::integer as quantity from public.instagram_order_items
        where order_id = p_order_id group by variant_id) items), '[]'::jsonb)
  ) from public.instagram_orders ord where ord.id = p_order_id;
$$;

create or replace function public.create_instagram_order_edit_request_atomic(
  p_order_id uuid, p_actor_user_id uuid, p_changes jsonb, p_reason text default ''
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_company_id uuid; v_viewer_name text; v_order public.instagram_orders%rowtype;
  v_request public.instagram_order_edit_requests%rowtype;
  v_changes jsonb; v_original jsonb; v_original_items jsonb; v_proposed_items jsonb := '[]'::jsonb;
  v_key text; v_shipping boolean;
begin
  select mapping.company_id, coalesce(viewer.name, viewer.username, '') into v_company_id, v_viewer_name
  from public.instagram_viewer_companies mapping join public.users viewer on viewer.id = mapping.viewer_user_id
  where mapping.viewer_user_id = p_actor_user_id and viewer.role = 'instagram_viewer';
  if not found then raise exception 'حساب المشاهدة غير مربوط بشركة'; end if;
  select * into v_order from public.instagram_orders where id = p_order_id for update;
  if not found or v_order.company_id is distinct from v_company_id or coalesce(v_order.is_archived, false) then
    raise exception 'الطلب غير موجود أو غير مصرح';
  end if;
  if exists (select 1 from public.instagram_order_edit_requests where order_id = p_order_id and status = 'معلق') then
    raise exception 'يوجد طلب تعديل معلق لهذا الطلب';
  end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then
    raise exception 'لم يتم إرسال أي تعديل';
  end if;
  if exists (select 1 from jsonb_object_keys(p_changes) key where key not in (
    'order_number', 'customer_name', 'customer_number', 'address', 'note', 'total_price',
    'status', 'shipping_delivery_status', 'items', 'recalculate_total_price')) then
    raise exception 'يتضمن طلب التعديل حقولاً غير مسموحة';
  end if;
  v_changes := p_changes;
  v_shipping := v_order.order_type = 'شحن';
  if p_changes ? 'customer_name' then
    if jsonb_typeof(p_changes->'customer_name') <> 'string'
      or char_length(btrim(p_changes->>'customer_name')) not between 2 and 100 then
      raise exception 'اسم العميل غير صالح';
    end if;
    if v_shipping and (select count(*) from regexp_split_to_table(btrim(p_changes->>'customer_name'), '\s+') part where part <> '') < 3 then
      raise exception 'لطلبات الشحن يجب إدخال الاسم الثلاثي';
    end if;
  end if;
  if p_changes ? 'customer_number' and (jsonb_typeof(p_changes->'customer_number') <> 'string' or coalesce(p_changes->>'customer_number', '') !~ '^[0-9]{10}$') then
    raise exception 'رقم العميل يجب أن يتكون من 10 أرقام';
  end if;
  if p_changes ? 'address' and (jsonb_typeof(p_changes->'address') <> 'string'
    or char_length(p_changes->>'address') > 300 or (not v_shipping and char_length(btrim(p_changes->>'address')) < 5)) then
    raise exception 'العنوان غير صالح';
  end if;
  if p_changes ? 'note' and (jsonb_typeof(p_changes->'note') <> 'string' or char_length(p_changes->>'note') > 1000) then
    raise exception 'الملاحظة طويلة أو غير صالحة';
  end if;
  if p_changes ? 'order_number' then
    if jsonb_typeof(p_changes->'order_number') <> 'number' or (p_changes->>'order_number') !~ '^[1-9][0-9]*$'
      or (p_changes->>'order_number')::numeric > 9007199254740991 then raise exception 'رقم الطلب غير صالح'; end if;
  end if;
  if p_changes ? 'total_price' then
    if jsonb_typeof(p_changes->'total_price') <> 'number' then raise exception 'السعر غير صالح'; end if;
    if (p_changes->>'total_price')::numeric < (case when v_shipping then coalesce(v_order.shipping_fee, 0) else 0 end) then
      raise exception 'السعر النهائي يجب ألا يقل عن أجور الشحن';
    end if;
  end if;
  if p_changes ? 'status' and (v_shipping or jsonb_typeof(p_changes->'status') <> 'string'
    or (p_changes->>'status') not in ('قيد المتابعة', 'تم', 'مؤجل', 'مرتجع', 'إلغاء')) then
    raise exception 'طلبات الشحن تستخدم حالة التسليم فقط';
  end if;
  if p_changes ? 'shipping_delivery_status' and (not v_shipping or jsonb_typeof(p_changes->'shipping_delivery_status') <> 'string'
    or (p_changes->>'shipping_delivery_status') not in ('pending', 'delivered')) then
    raise exception 'حالة تسليم الشحن غير صالحة';
  end if;
  if p_changes ? 'recalculate_total_price' and (not (p_changes ? 'items') or jsonb_typeof(p_changes->'recalculate_total_price') <> 'boolean') then
    raise exception 'إعادة حساب السعر تتطلب أصنافاً صالحة';
  end if;
  if p_changes ? 'items' then
    if jsonb_typeof(p_changes->'items') <> 'array' then raise exception 'الأصناف غير صالحة'; end if;
    if jsonb_array_length(p_changes->'items') not between 1 and 50 then raise exception 'يجب اختيار من 1 إلى 50 صنفاً'; end if;
    if exists (select 1 from jsonb_array_elements(p_changes->'items') item
      where jsonb_typeof(item) <> 'object'
        or coalesce(item->>'variant_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or coalesce(item->>'quantity', '') !~ '^[1-9][0-9]*$') then raise exception 'الصنف أو الكمية غير صالحة'; end if;
    if exists (select 1 from jsonb_array_elements(p_changes->'items') item where (item->>'quantity')::numeric > 1000) then
      raise exception 'الكمية يجب ألا تتجاوز 1000';
    end if;
    select jsonb_set(v_changes, '{items}', jsonb_agg(jsonb_build_object('variant_id', variant_id, 'quantity', quantity) order by variant_id))
    into v_changes from (select (item->>'variant_id')::uuid as variant_id, sum((item->>'quantity')::integer)::integer as quantity
      from jsonb_array_elements(p_changes->'items') item group by (item->>'variant_id')::uuid) merged;
    if exists (select 1 from jsonb_array_elements(v_changes->'items') item where (item->>'quantity')::integer > 1000) then
      raise exception 'إجمالي كمية الصنف الواحد يتجاوز الحد المسموح';
    end if;
    if exists (select 1 from jsonb_array_elements(v_changes->'items') item
      left join public.instagram_variants variant on variant.id = (item->>'variant_id')::uuid
      left join public.instagram_products product on product.id = variant.product_id
      where variant.id is null or product.company_id is distinct from v_company_id
        or coalesce(product.currency, 'ل.س') <> coalesce(v_order.currency, 'ل.س')
        or ((not variant.is_active or product.status <> 'active') and not exists
          (select 1 from public.instagram_order_items old_item where old_item.order_id = p_order_id and old_item.variant_id = variant.id))) then
      raise exception 'الصنف غير متاح ضمن الشركة أو عملته مختلفة';
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('variant_id', variant.id, 'product_name', product.name,
      'color', variant.color, 'size', variant.size, 'quantity', item->'quantity') order by variant.id), '[]'::jsonb)
    into v_proposed_items from jsonb_array_elements(v_changes->'items') item
    join public.instagram_variants variant on variant.id = (item->>'variant_id')::uuid
    join public.instagram_products product on product.id = variant.product_id;
  end if;
  v_original := public.instagram_order_edit_snapshot(p_order_id);
  if not exists (select 1 from jsonb_object_keys(v_changes) key
    where key <> 'recalculate_total_price' and v_changes->key is distinct from v_original->key)
    and coalesce((v_changes->>'recalculate_total_price')::boolean, false) = false then
    raise exception 'لم يتغير أي بيان في الطلب';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('variant_id', variant_id, 'product_name', product_name,
    'color', color, 'size', size, 'quantity', quantity) order by variant_id, id), '[]'::jsonb)
  into v_original_items from public.instagram_order_items where order_id = p_order_id;
  insert into public.instagram_order_edit_requests(order_id, company_id, requested_by_user_id,
    requested_by_name, requested_changes, original_values, original_items, proposed_items, reason)
  values (p_order_id, v_company_id, p_actor_user_id, v_viewer_name, v_changes, v_original,
    v_original_items, v_proposed_items, left(btrim(coalesce(p_reason, '')), 1000)) returning * into v_request;
  return to_jsonb(v_request);
end;
$$;

create or replace function public.decide_instagram_order_edit_request_atomic(
  p_request_id uuid, p_actor_user_id uuid, p_approve boolean, p_admin_note text default ''
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_request public.instagram_order_edit_requests%rowtype; v_order public.instagram_orders%rowtype;
  v_order_id uuid; v_current jsonb; v_key text; v_result jsonb; v_changes jsonb;
begin
  if not exists (select 1 from public.users where id = p_actor_user_id and role = 'admin') or p_approve is null then
    raise exception 'غير مصرح بالبت في طلب التعديل';
  end if;
  -- Lock the order before the request, consistently with request creation and deletion.
  select order_id into v_order_id from public.instagram_order_edit_requests where id = p_request_id;
  if not found then raise exception 'طلب التعديل غير موجود'; end if;
  select * into v_order from public.instagram_orders where id = v_order_id for update;
  if not found then raise exception 'الطلب الأصلي غير موجود'; end if;
  select * into v_request from public.instagram_order_edit_requests where id = p_request_id for update;
  if not found then raise exception 'طلب التعديل غير موجود'; end if;
  if v_request.status <> 'معلق' then raise exception 'تم البت في طلب التعديل مسبقاً'; end if;
  if p_approve then
    if coalesce(v_order.is_archived, false) or v_order.company_id is distinct from v_request.company_id then
      raise exception 'تمت أرشفة الطلب أو تغيير شركته، ارفض الطلب واطلب مقترحاً جديداً';
    end if;
    v_changes := v_request.requested_changes;
    v_current := public.instagram_order_edit_snapshot(v_order.id);
    for v_key in select jsonb_object_keys(v_changes)
    loop
      if v_key = 'recalculate_total_price' then continue; end if;
      if v_current->v_key is distinct from v_request.original_values->v_key then
        raise exception 'تغيرت بيانات الطلب بعد إرسال طلب التعديل؛ ارفضه واطلب مقترحاً جديداً';
      end if;
    end loop;
    if v_changes ? 'items' and coalesce((v_changes->>'recalculate_total_price')::boolean, false)
      and v_current->'total_price' is distinct from v_request.original_values->'total_price' then
      raise exception 'تغير سعر الطلب بعد إرسال طلب التعديل';
    end if;
    -- Recheck item availability and ownership at approval time, inside this transaction.
    if v_changes ? 'items' and exists (select 1 from jsonb_array_elements(v_changes->'items') item
      left join public.instagram_variants variant on variant.id = (item->>'variant_id')::uuid
      left join public.instagram_products product on product.id = variant.product_id
      where variant.id is null or product.company_id is distinct from v_order.company_id
        or coalesce(product.currency, 'ل.س') <> coalesce(v_order.currency, 'ل.س')
        or ((not variant.is_active or product.status <> 'active') and not exists
          (select 1 from public.instagram_order_items old_item where old_item.order_id = v_order.id and old_item.variant_id = variant.id))) then
      raise exception 'الصنف لم يعد متاحاً ضمن الشركة';
    end if;
    if v_changes ? 'items' then
      v_result := public.update_instagram_order_atomic(
        p_order_id => v_order.id, p_actor_user_id => p_actor_user_id,
        p_order_number => (v_changes->>'order_number')::bigint,
        p_customer_name => v_changes->>'customer_name', p_customer_number => v_changes->>'customer_number',
        p_address => v_changes->>'address', p_total_price => (v_changes->>'total_price')::numeric,
        p_note => v_changes->>'note', p_status => v_changes->>'status',
        p_driver_id => v_order.driver_id, p_company_id => v_order.company_id,
        p_items => v_changes->'items', p_recalculate_total_price => coalesce((v_changes->>'recalculate_total_price')::boolean, false)
      );
    elsif (v_changes - array['shipping_delivery_status', 'status']) <> '{}'::jsonb then
      if v_changes ? 'order_number' and exists (select 1 from public.instagram_orders
        where company_id = v_order.company_id and order_number = (v_changes->>'order_number')::bigint and id <> v_order.id) then
        raise exception 'رقم الطلب مستخدم مسبقاً ضمن الشركة';
      end if;
      if v_order.order_type = 'شحن' and v_changes ? 'total_price'
        and (v_changes->>'total_price')::numeric < coalesce(v_order.shipping_fee, 0) then
        raise exception 'السعر النهائي يجب ألا يقل عن أجور الشحن';
      end if;
      -- Metadata requests keep item snapshots, stock, driver and company untouched.
      update public.instagram_orders
      set order_number = coalesce((v_changes->>'order_number')::bigint, order_number),
          customer_name = coalesce(v_changes->>'customer_name', customer_name),
          customer_number = coalesce(v_changes->>'customer_number', customer_number),
          address = coalesce(v_changes->>'address', address),
          note = coalesce(v_changes->>'note', note),
          total_price = coalesce((v_changes->>'total_price')::numeric, total_price),
          items_total = case when v_changes ? 'total_price' then
            greatest((v_changes->>'total_price')::numeric - coalesce(shipping_fee, 0), 0) else items_total end,
          updated_at = now()
      where id = v_order.id;
    end if;
    if v_changes ? 'status' and not (v_changes ? 'items') then
      perform public.change_instagram_order_status_atomic(v_order.id, v_changes->>'status', p_actor_user_id, null);
    end if;
    if v_changes ? 'shipping_delivery_status' then
      perform public.set_instagram_shipping_delivery_status_atomic(array[v_order.id], v_changes->>'shipping_delivery_status', p_actor_user_id);
    end if;
  end if;
  -- A stock shortage or stale request rolls back both the edit and this decision.
  update public.instagram_order_edit_requests
  set status = case when p_approve then 'مقبول' else 'مرفوض' end,
      admin_note = left(btrim(coalesce(p_admin_note, '')), 1000),
      responded_by_user_id = p_actor_user_id, responded_at = now()
  where id = p_request_id returning * into v_request;
  return jsonb_build_object('success', true, 'id', v_request.id, 'status', v_request.status);
end;
$$;

-- All authenticated browser roles remain unable to mutate directly.
revoke all on function public.approve_instagram_shipping_order_atomic(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.reject_instagram_shipping_order_atomic(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.instagram_shipping_direct_entry_guard() from public, anon, authenticated;
revoke all on function public.instagram_order_edit_snapshot(uuid) from public, anon, authenticated;
revoke all on function public.create_instagram_order_edit_request_atomic(uuid, uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.decide_instagram_order_edit_request_atomic(uuid, uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.set_instagram_shipping_delivery_status_atomic(uuid[], text, uuid) from public, anon, authenticated;
revoke all on function public.mark_instagram_shipping_delivered_atomic(uuid[], uuid) from public, anon, authenticated;
revoke all on function public.create_instagram_order_atomic(text, text, text, text, text, jsonb, uuid, text) from public, anon, authenticated;
revoke all on function public.change_instagram_order_status_atomic(uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function public.update_instagram_order_atomic(uuid, uuid, bigint, text, text, text, numeric, numeric, text, text, uuid, uuid, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.create_instagram_order_edit_request_atomic(uuid, uuid, jsonb, text) to service_role;
grant execute on function public.decide_instagram_order_edit_request_atomic(uuid, uuid, boolean, text) to service_role;
grant execute on function public.set_instagram_shipping_delivery_status_atomic(uuid[], text, uuid) to service_role;
grant execute on function public.mark_instagram_shipping_delivered_atomic(uuid[], uuid) to service_role;
grant execute on function public.create_instagram_order_atomic(text, text, text, text, text, jsonb, uuid, text) to service_role;
grant execute on function public.change_instagram_order_status_atomic(uuid, text, uuid, text) to service_role;
grant execute on function public.update_instagram_order_atomic(uuid, uuid, bigint, text, text, text, numeric, numeric, text, text, uuid, uuid, jsonb, boolean) to service_role;

notify pgrst, 'reload schema';
commit;
