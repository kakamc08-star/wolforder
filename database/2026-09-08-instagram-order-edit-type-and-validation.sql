-- WolfOrder / Instagram order editing, type transitions and input validation
--
-- Apply after:
--   2026-09-04-instagram-shipping-workflow.sql
--   2026-09-05-instagram-inventory-release-fix.sql
--   2026-09-05-instagram-shipping-pending-reservation.sql
--
-- The internal order status remains one of the existing stable values. The
-- shipping handoff text is a derived UI value, so recording company delivery
-- never releases or re-reserves inventory.

begin;

create extension if not exists pgcrypto;

-- The old edit migration installed a trigger that blocked shipping orders.
-- Shipping orders are now a supported type, while the driver invariant stays.
drop trigger if exists instagram_orders_delivery_only_guard on public.instagram_orders;
drop function if exists public.instagram_orders_delivery_only_guard();

create or replace function public.instagram_orders_shipping_driver_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if coalesce(new.order_type, 'توصيل') = 'شحن' and new.driver_id is not null then
    raise exception 'لا يمكن تعيين سائق لطلب شحن' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists instagram_orders_shipping_driver_guard on public.instagram_orders;
create trigger instagram_orders_shipping_driver_guard
before insert or update of order_type, driver_id on public.instagram_orders
for each row execute function public.instagram_orders_shipping_driver_guard();

-- Existing orders are not rewritten. New rows, and explicitly changed fields,
-- must use the public form's canonical values.
create or replace function public.validate_instagram_order_contact_fields()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if coalesce(new.customer_number, '') !~ '^0[0-9]{9}$' then
      raise exception 'رقم العميل يجب أن يتكون من 10 أرقام ويبدأ بالرقم 0' using errcode = 'P0001';
    end if;
    if char_length(btrim(coalesce(new.address, ''))) < 3 then
      raise exception 'العنوان مطلوب ويجب أن يتكون من 3 محارف على الأقل' using errcode = 'P0001';
    end if;
    if char_length(coalesce(new.note, '')) > 85 then
      raise exception 'الملاحظة يجب ألا تتجاوز 85 محرفاً' using errcode = 'P0001';
    end if;
  else
    if new.customer_number is distinct from old.customer_number
       and coalesce(new.customer_number, '') !~ '^0[0-9]{9}$' then
      raise exception 'رقم العميل يجب أن يتكون من 10 أرقام ويبدأ بالرقم 0' using errcode = 'P0001';
    end if;
    if new.address is distinct from old.address
       and char_length(btrim(coalesce(new.address, ''))) not between 3 and 300 then
      raise exception 'العنوان مطلوب ويجب أن يتكون من 3 محارف على الأقل' using errcode = 'P0001';
    end if;
    if new.note is distinct from old.note and char_length(coalesce(new.note, '')) > 85 then
      raise exception 'الملاحظة يجب ألا تتجاوز 85 محرفاً' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists instagram_orders_contact_validation on public.instagram_orders;
create trigger instagram_orders_contact_validation
before insert or update of customer_number, address, note on public.instagram_orders
for each row execute function public.validate_instagram_order_contact_fields();

-- The previous migration intentionally removed the legacy five-character
-- address minimum. Keep the maximum constraint and enforce the new minimum in
-- the trigger above, so old short records remain readable and editable.
do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conrelid = 'public.instagram_orders'::regclass
      and conname = 'instagram_orders_address_check'
  ) then
    alter table public.instagram_orders drop constraint instagram_orders_address_check;
  end if;

  alter table public.instagram_orders
    add constraint instagram_orders_address_check
    check (char_length(coalesce(address, '')) <= 300) not valid;
end
$$;

-- =========================================================
-- Atomic manager edit. The function supports both order types and computes
-- one net stock change per affected variant while all variants are locked in a
-- stable order. PostgreSQL rolls the whole function back if any validation or
-- stock check fails.
-- =========================================================
drop function if exists public.update_instagram_order_atomic(
  uuid, uuid, bigint, text, text, text, numeric, numeric, text, text,
  uuid, uuid, jsonb, boolean
);
drop function if exists public.update_instagram_order_atomic(
  uuid, uuid, bigint, text, text, text, numeric, numeric, text, text,
  uuid, uuid, jsonb, boolean, text
);

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
  p_recalculate_total_price boolean default false,
  p_order_type text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.instagram_orders%rowtype;
  v_company_id uuid;
  v_company_name text;
  v_driver_name text;
  v_customer_name text;
  v_customer_number text;
  v_address text;
  v_note text;
  v_old_type text;
  v_new_type text;
  v_old_approval text;
  v_new_approval text;
  v_new_status text;
  v_total_price numeric;
  v_items_total numeric := 0;
  v_computed_total numeric := 0;
  v_shipping_fee numeric := 0;
  v_ratio numeric;
  v_currency text;
  v_selected_currency text;
  v_desired_items jsonb;
  v_desired_item record;
  v_variant_id uuid;
  v_product_id uuid;
  v_product_name text;
  v_color text;
  v_size text;
  v_unit_price numeric;
  v_variant_currency text;
  v_item_count integer;
  v_old_quantity integer;
  v_desired_quantity integer;
  v_old_net_delta integer;
  v_old_hold integer;
  v_new_hold integer;
  v_stock_delta integer;
  v_movement_delta integer;
  v_stock_available integer;
  v_stock_total integer;
  v_new_available integer;
  v_old_active boolean;
  v_new_active boolean;
  v_new_driver_id uuid;
  v_new_delivery_status text;
  v_new_approved_at timestamptz;
  v_new_approved_by uuid;
  v_new_delivered_at timestamptz;
  v_new_delivered_by uuid;
  v_new_delivered_to_name text;
begin
  if not exists (
    select 1 from public.users
    where id = p_actor_user_id and role = 'admin'
  ) then
    raise exception 'غير مصرح بتعديل طلب Instagram' using errcode = 'P0001';
  end if;

  select * into v_order
  from public.instagram_orders
  where id = p_order_id and coalesce(is_archived, false) = false
  for update;
  if not found then
    raise exception 'طلب Instagram غير موجود' using errcode = 'P0001';
  end if;

  v_old_type := case
    when lower(btrim(coalesce(v_order.order_type, ''))) in ('shipping', 'شحن') then 'شحن'
    else 'توصيل'
  end;
  v_new_type := case lower(btrim(coalesce(p_order_type, v_old_type)))
    when 'shipping' then 'شحن'
    when 'شحن' then 'شحن'
    when 'delivery' then 'توصيل'
    when 'توصيل' then 'توصيل'
    else ''
  end;
  if v_new_type not in ('توصيل', 'شحن') then
    raise exception 'نوع الطلب غير صالح' using errcode = 'P0001';
  end if;

  v_company_id := coalesce(p_company_id, v_order.company_id);
  select name into v_company_name
  from public.users
  where id = v_company_id and role = 'company';
  if not found then
    raise exception 'الشركة المحددة غير موجودة' using errcode = 'P0001';
  end if;

  v_new_driver_id := case when v_new_type = 'شحن' then null else p_driver_id end;
  if v_new_driver_id is not null then
    select name into v_driver_name
    from public.users
    where id = v_new_driver_id and role = 'driver';
    if not found then
      raise exception 'السائق المحدد غير موجود' using errcode = 'P0001';
    end if;
  else
    v_driver_name := '';
  end if;

  if p_order_number is not null and p_order_number < 1 then
    raise exception 'رقم الطلب غير صالح' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.instagram_orders
    where order_number = coalesce(p_order_number, v_order.order_number)
      and id <> p_order_id
  ) then
    raise exception 'رقم الطلب مستخدم مسبقاً' using errcode = 'P0001';
  end if;

  v_customer_name := coalesce(p_customer_name, v_order.customer_name);
  v_customer_number := coalesce(p_customer_number, v_order.customer_number);
  v_address := coalesce(p_address, v_order.address);
  v_note := case when p_note is null then coalesce(v_order.note, '') else btrim(p_note) end;
  v_new_status := coalesce(nullif(btrim(p_status), ''), v_order.status);
  if v_new_status = 'ملغي' then v_new_status := 'إلغاء'; end if;
  v_total_price := coalesce(p_total_price, v_order.total_price, 0);
  v_ratio := coalesce(p_ratio, v_order.ratio, 0);

  if p_customer_name is not null
     and char_length(btrim(v_customer_name)) not between 2 and 100 then
    raise exception 'اسم العميل مطلوب ويجب أن يتكون من حرفين على الأقل' using errcode = 'P0001';
  end if;
  if p_customer_number is not null
     and v_customer_number !~ '^0[0-9]{9}$' then
    raise exception 'رقم العميل يجب أن يتكون من 10 أرقام ويبدأ بالرقم 0' using errcode = 'P0001';
  end if;
  if p_address is not null
     and char_length(btrim(v_address)) not between 3 and 300 then
    raise exception 'العنوان مطلوب ويجب أن يتكون من 3 محارف على الأقل' using errcode = 'P0001';
  end if;
  if p_note is not null and char_length(v_note) > 85 then
    raise exception 'الملاحظة يجب ألا تتجاوز 85 محرفاً' using errcode = 'P0001';
  end if;
  if v_total_price < 0 or v_ratio < 0 then
    raise exception 'السعر أو النسبة غير صالح' using errcode = 'P0001';
  end if;
  if v_new_status not in ('قيد المتابعة', 'تم', 'مؤجل', 'مرتجع', 'إلغاء') then
    raise exception 'حالة الطلب غير صالحة' using errcode = 'P0001';
  end if;

  if p_items is null then
    select coalesce(
      jsonb_agg(
        jsonb_build_object('variant_id', variant_id, 'quantity', quantity)
        order by variant_id
      ),
      '[]'::jsonb
    ) into v_desired_items
    from (
      select variant_id, sum(quantity)::integer as quantity
      from public.instagram_order_items
      where order_id = p_order_id
      group by variant_id
    ) current_items;
  else
    if jsonb_typeof(p_items) <> 'array'
       or jsonb_array_length(p_items) < 1
       or jsonb_array_length(p_items) > 50 then
      raise exception 'يجب أن يحتوي الطلب على صنف واحد على الأقل' using errcode = 'P0001';
    end if;
    if exists (
      select 1 from jsonb_array_elements(p_items) as raw(item)
      where jsonb_typeof(raw.item) <> 'object'
         or coalesce(raw.item->>'variant_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         or coalesce(raw.item->>'quantity', '') !~ '^[0-9]+$'
    ) then
      raise exception 'الصنف أو الكمية غير صالحة' using errcode = 'P0001';
    end if;
    if exists (
      select 1 from jsonb_array_elements(p_items) as raw(item)
      where (raw.item->>'quantity')::numeric < 1
         or (raw.item->>'quantity')::numeric > 1000
    ) then
      raise exception 'الكمية يجب أن تكون بين 1 و1000' using errcode = 'P0001';
    end if;
    select coalesce(
      jsonb_agg(
        jsonb_build_object('variant_id', variant_id, 'quantity', quantity)
        order by variant_id
      ),
      '[]'::jsonb
    ) into v_desired_items
    from (
      select (raw.item->>'variant_id')::uuid as variant_id,
             sum((raw.item->>'quantity')::integer)::integer as quantity
      from jsonb_array_elements(p_items) as raw(item)
      group by (raw.item->>'variant_id')::uuid
    ) merged_items;
  end if;

  v_item_count := jsonb_array_length(v_desired_items);
  if v_item_count < 1 then
    raise exception 'لا يمكن حفظ طلب بدون أصناف' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_desired_items) as raw(item)
    where (raw.item->>'quantity')::integer < 1
       or (raw.item->>'quantity')::integer > 1000
  ) then
    raise exception 'إجمالي كمية الصنف الواحد يتجاوز الحد المسموح' using errcode = 'P0001';
  end if;

  -- Lock old, historical-movement and new variants in one stable order.
  for v_variant_id in
    select distinct affected.variant_id
    from (
      select oi.variant_id
      from public.instagram_order_items oi
      where oi.order_id = p_order_id and oi.variant_id is not null
      union
      select movement.variant_id
      from public.instagram_inventory_movements movement
      where movement.order_id = p_order_id and movement.variant_id is not null
      union
      select (raw.item->>'variant_id')::uuid
      from jsonb_array_elements(v_desired_items) as raw(item)
    ) affected
    order by affected.variant_id
  loop
    perform 1 from public.instagram_variants
    where id = v_variant_id for update;
    if not found then
      raise exception 'تركيبة الصنف غير موجودة' using errcode = 'P0001';
    end if;
  end loop;

  -- Validate snapshots and calculate the new line total from current catalog
  -- prices. The order's manually entered total is preserved unless the UI
  -- explicitly requests recalculation.
  for v_desired_item in
    select (raw.item->>'variant_id')::uuid as variant_id,
           (raw.item->>'quantity')::integer as quantity
    from jsonb_array_elements(v_desired_items) as raw(item)
    order by 1
  loop
    select v.product_id, v.color, v.size, p.name, p.unit_price, p.currency
    into v_product_id, v_color, v_size, v_product_name, v_unit_price, v_variant_currency
    from public.instagram_variants v
    join public.instagram_products p on p.id = v.product_id
    where v.id = v_desired_item.variant_id
      and p.company_id = v_company_id;
    if not found then
      raise exception 'الصنف المحدد غير موجود ضمن الشركة' using errcode = 'P0001';
    end if;
    if v_selected_currency is null then
      v_selected_currency := coalesce(v_variant_currency, 'ل.س');
    elsif v_selected_currency <> coalesce(v_variant_currency, 'ل.س') then
      raise exception 'لا يمكن جمع عملات مختلفة في طلب واحد' using errcode = 'P0001';
    end if;
    v_computed_total := v_computed_total + coalesce(v_unit_price, 0) * v_desired_item.quantity;
  end loop;

  v_currency := coalesce(v_selected_currency, v_order.currency, 'ل.س');
  if v_new_type = 'شحن' then
    if v_currency <> 'ل.س' then
      raise exception 'أجور الشحن متاحة مع المنتجات المسعرة بالليرة السورية فقط' using errcode = 'P0001';
    end if;
    -- Keep a legacy shipping total that was created before the fee column was
    -- introduced. New shipping orders and delivery-to-shipping transitions
    -- use the current fee, while editing an old shipping row preserves money.
    v_shipping_fee := case
      when v_old_type = 'شحن' then coalesce(v_order.shipping_fee, 0)
      else 10000
    end;
  end if;
  if p_recalculate_total_price then
    v_total_price := v_computed_total + v_shipping_fee;
  end if;
  v_items_total := greatest(v_total_price - v_shipping_fee, 0);

  v_old_approval := case
    when v_old_type = 'شحن' then coalesce(v_order.shipping_approval_status, 'pending')
    else 'not_required'
  end;
  v_new_approval := case
    when v_new_type <> 'شحن' then 'not_required'
    when v_old_type = 'شحن'
      and v_old_approval in ('pending', 'accepted') then v_old_approval
    else 'accepted'
  end;

  v_old_active := v_order.status in ('قيد المتابعة', 'مؤجل', 'تم');
  v_new_active := v_new_status in ('قيد المتابعة', 'مؤجل', 'تم');

  -- Both shipping states hold stock. For an old pending row created before
  -- the reservation migration, use its actual negative movement first; a new
  -- edit then brings it to the canonical full reservation atomically.
  for v_variant_id in
    select distinct affected.variant_id
    from (
      select oi.variant_id
      from public.instagram_order_items oi
      where oi.order_id = p_order_id and oi.variant_id is not null
      union
      select movement.variant_id
      from public.instagram_inventory_movements movement
      where movement.order_id = p_order_id and movement.variant_id is not null
      union
      select (raw.item->>'variant_id')::uuid
      from jsonb_array_elements(v_desired_items) as raw(item)
    ) affected
    order by affected.variant_id
  loop
    select coalesce(sum(quantity), 0)::integer into v_old_quantity
    from public.instagram_order_items
    where order_id = p_order_id and variant_id = v_variant_id;

    select coalesce(sum(stock_available_delta), 0)::integer into v_old_net_delta
    from public.instagram_inventory_movements
    where order_id = p_order_id and variant_id = v_variant_id;

    select coalesce(sum((raw.item->>'quantity')::integer), 0)::integer
    into v_desired_quantity
    from jsonb_array_elements(v_desired_items) as raw(item)
    where (raw.item->>'variant_id')::uuid = v_variant_id;

    if v_old_active
       and (v_old_type = 'توصيل' or (v_old_type = 'شحن' and v_old_approval = 'accepted')) then
      v_old_hold := v_old_quantity;
    else
      v_old_hold := least(v_old_quantity, greatest(-v_old_net_delta, 0));
    end if;
    v_new_hold := case when v_new_active then v_desired_quantity else 0 end;
    v_stock_delta := v_old_hold - v_new_hold;

    select stock_available, stock_total
    into v_stock_available, v_stock_total
    from public.instagram_variants
    where id = v_variant_id
    for update;
    if not found then
      raise exception 'تركيبة المخزون المرتبطة بالطلب غير موجودة' using errcode = 'P0001';
    end if;

    v_new_available := v_stock_available + v_stock_delta;
    if v_new_available < 0 or v_new_available > v_stock_total then
      raise exception 'تعذر تحديث المخزون بأمان؛ لم يتم حفظ التعديل' using errcode = 'P0001';
    end if;
    if v_stock_delta <> 0 then
      update public.instagram_variants
      set stock_available = v_new_available, updated_at = now()
      where id = v_variant_id;
    end if;

    -- Make the audit net effect agree with the new reservation target without
    -- counting any old reservation or release twice.
    v_movement_delta := (-v_new_hold) - v_old_net_delta;
    if v_movement_delta <> 0 then
      select v.color, v.size, p.name
      into v_color, v_size, v_product_name
      from public.instagram_variants v
      join public.instagram_products p on p.id = v.product_id
      where v.id = v_variant_id;

      insert into public.instagram_inventory_movements (
        variant_id, order_id, movement_type, quantity,
        stock_total_delta, stock_available_delta, product_name, color, size,
        status_from, status_to, created_by_user_id, event_key, note
      ) values (
        v_variant_id, p_order_id, 'adjustment', abs(v_movement_delta),
        0, v_movement_delta, v_product_name, v_color, v_size,
        v_order.status, v_new_status, p_actor_user_id,
        'instagram:order-edit:' || p_order_id::text || ':' || gen_random_uuid()::text,
        'تعديل طلب Instagram وحجز الفرق فقط'
      );
    end if;
  end loop;

  -- Do not leave old movement rows pointing at deleted snapshots.
  update public.instagram_inventory_movements
  set order_item_id = null
  where order_id = p_order_id;
  delete from public.instagram_order_items where order_id = p_order_id;

  for v_desired_item in
    select (raw.item->>'variant_id')::uuid as variant_id,
           (raw.item->>'quantity')::integer as quantity
    from jsonb_array_elements(v_desired_items) as raw(item)
    order by 1
  loop
    select v.product_id, v.color, v.size, p.name, p.unit_price
    into v_product_id, v_color, v_size, v_product_name, v_unit_price
    from public.instagram_variants v
    join public.instagram_products p on p.id = v.product_id
    where v.id = v_desired_item.variant_id
      and p.company_id = v_company_id;

    insert into public.instagram_order_items (
      order_id, product_id, variant_id, product_name, color, size,
      unit_price, quantity
    ) values (
      p_order_id, v_product_id, v_desired_item.variant_id, v_product_name,
      v_color, v_size, v_unit_price, v_desired_item.quantity
    );
  end loop;

  if v_new_type = 'شحن' then
    if v_old_type = 'شحن' then
      v_new_delivery_status := case
        when v_order.shipping_delivery_status = 'delivered' then 'delivered'
        else 'pending'
      end;
      v_new_approved_at := v_order.shipping_approved_at;
      v_new_approved_by := v_order.shipping_approved_by;
      v_new_delivered_at := v_order.shipping_delivered_at;
      v_new_delivered_by := v_order.shipping_delivered_by;
      v_new_delivered_to_name := v_order.shipping_delivered_to_name;
    else
      v_new_delivery_status := 'pending';
      v_new_approved_at := now();
      v_new_approved_by := p_actor_user_id;
      v_new_delivered_at := null;
      v_new_delivered_by := null;
      v_new_delivered_to_name := null;
    end if;
  else
    v_new_delivery_status := 'pending';
    v_new_approved_at := null;
    v_new_approved_by := null;
    v_new_delivered_at := null;
    v_new_delivered_by := null;
    v_new_delivered_to_name := null;
  end if;

  update public.instagram_orders
  set order_number = coalesce(p_order_number, v_order.order_number),
      company_id = v_company_id,
      company_name = v_company_name,
      customer_name = case when p_customer_name is null then v_order.customer_name else btrim(v_customer_name) end,
      customer_number = case when p_customer_number is null then v_order.customer_number else v_customer_number end,
      address = case when p_address is null then v_order.address else btrim(v_address) end,
      order_type = v_new_type,
      total_price = v_total_price,
      items_total = v_items_total,
      shipping_fee = v_shipping_fee,
      currency = v_currency,
      ratio = v_ratio,
      status = v_new_status,
      note = case when p_note is null then v_order.note else v_note end,
      driver_id = v_new_driver_id,
      driver_name = coalesce(v_driver_name, ''),
      shipping_approval_status = v_new_approval,
      shipping_approved_at = v_new_approved_at,
      shipping_approved_by = v_new_approved_by,
      shipping_delivery_status = v_new_delivery_status,
      shipping_delivered_at = v_new_delivered_at,
      shipping_delivered_by = v_new_delivered_by,
      shipping_delivered_to_name = v_new_delivered_to_name,
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

revoke all on function public.update_instagram_order_atomic(
  uuid, uuid, bigint, text, text, text, numeric, numeric, text, text,
  uuid, uuid, jsonb, boolean, text
) from public, anon, authenticated;
grant execute on function public.update_instagram_order_atomic(
  uuid, uuid, bigint, text, text, text, numeric, numeric, text, text,
  uuid, uuid, jsonb, boolean, text
) to service_role;

revoke all on function public.validate_instagram_order_contact_fields() from public, anon, authenticated;
revoke all on function public.instagram_orders_shipping_driver_guard() from public, anon, authenticated;

commit;
