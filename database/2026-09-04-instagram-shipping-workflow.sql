-- WolfOrder / Instagram shipping workflow
--
-- This migration is written for the live Instagram schema reviewed on
-- 2026-09-04:
--   instagram_orders(company_id uuid, customer_number text, order_type text,
--     total_price numeric, currency text, shipping_delivery_status text,
--     shipping_delivered_at timestamptz, shipping_delivered_by uuid, ...)
--   instagram_order_items(variant_id uuid, unit_price numeric, line_total numeric)
--   instagram_variants(stock_total integer, stock_available integer)
--   instagram_inventory_movements(stock_available_delta integer, ...)
--
-- It does not create the old instagram_inventory or shipping-batch tables.
-- Existing orders are retained. Legacy NULL/English order types are treated as
-- delivery; legacy Arabic shipping rows are treated as already accepted so
-- they remain visible to the manager after the new workflow is deployed.

begin;

do $$
begin
  if to_regclass('public.instagram_orders') is null
    or to_regclass('public.instagram_order_items') is null
    or to_regclass('public.instagram_variants') is null
    or to_regclass('public.instagram_products') is null
    or to_regclass('public.instagram_inventory_movements') is null
    or to_regclass('public.instagram_company_links') is null then
    raise exception 'INSTAGRAM_LIVE_SCHEMA_MISSING: راجع الجداول الحية قبل تشغيل الترحيل';
  end if;
end
$$;

create extension if not exists pgcrypto;

alter table public.instagram_orders
  add column if not exists shipping_approval_status text not null default 'not_required',
  add column if not exists shipping_approved_at timestamptz,
  add column if not exists shipping_approved_by uuid,
  add column if not exists shipping_fee numeric not null default 0,
  add column if not exists items_total numeric not null default 0,
  add column if not exists shipping_delivered_to_name text;

-- The live link table already drives the per-company Instagram numbering UI.
-- Keep the allocator here as well so public order creation cannot insert a
-- NULL number or reuse a number during concurrent submissions.
alter table public.instagram_company_links
  add column if not exists next_order_number bigint not null default 1;

-- Backfill without changing the money already stored on old orders.
update public.instagram_orders
set order_type = case
  when lower(btrim(coalesce(order_type, ''))) in ('شحن', 'shipping') then 'شحن'
  else 'توصيل'
end
where order_type is null
   or lower(btrim(order_type)) not in ('توصيل', 'شحن', 'delivery', 'shipping');

update public.instagram_orders
set order_type = case
  when lower(btrim(order_type)) = 'shipping' then 'شحن'
  when lower(btrim(order_type)) = 'delivery' then 'توصيل'
  else order_type
end
where lower(btrim(order_type)) in ('delivery', 'shipping');

update public.instagram_orders
set shipping_approval_status = case
  when order_type = 'شحن' then 'accepted'
  else 'not_required'
end
where shipping_approval_status is null
   or shipping_approval_status not in ('pending', 'accepted', 'not_required')
   or (order_type = 'شحن' and shipping_approval_status = 'not_required')
   or (order_type <> 'شحن' and shipping_approval_status <> 'not_required');

update public.instagram_orders
set items_total = total_price
where coalesce(items_total, 0) = 0
  and coalesce(total_price, 0) <> 0;

update public.instagram_orders
set shipping_delivery_status = 'pending'
where shipping_delivery_status is null or btrim(shipping_delivery_status) = '';

update public.instagram_orders as o
set shipping_delivered_to_name = coalesce(
  (
    select coalesce(nullif(btrim(company.name), ''), nullif(btrim(company.username), ''))
    from public.users company
    where company.id = o.company_id and company.role = 'company'
  ),
  nullif(btrim(o.company_name), ''),
  'غير معروف'
)
where o.order_type = 'شحن'
  and o.shipping_delivery_status = 'delivered'
  and (o.shipping_delivered_to_name is null or btrim(o.shipping_delivered_to_name) = '');

-- A shipping order cannot carry a driver. The live data review found no such
-- rows, but clearing invalid legacy values makes the invariant explicit before
-- the trigger below is installed.
update public.instagram_orders
set driver_id = null,
    driver_name = '',
    updated_at = now()
where order_type = 'شحن'
  and (driver_id is not null or coalesce(driver_name, '') <> '');

update public.instagram_orders
set is_archived = false
where is_archived is null;

alter table public.instagram_orders alter column order_type set default 'توصيل';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.instagram_orders'::regclass
      and conname = 'instagram_orders_shipping_type_check'
  ) then
    alter table public.instagram_orders
      add constraint instagram_orders_shipping_type_check
      check (order_type in ('توصيل', 'شحن')) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.instagram_orders'::regclass
      and conname = 'instagram_orders_shipping_approval_check'
  ) then
    alter table public.instagram_orders
      add constraint instagram_orders_shipping_approval_check
      check (shipping_approval_status in ('pending', 'accepted', 'not_required')) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.instagram_orders'::regclass
      and conname = 'instagram_orders_shipping_fee_check'
  ) then
    alter table public.instagram_orders
      add constraint instagram_orders_shipping_fee_check
      check (shipping_fee >= 0 and items_total >= 0) not valid;
  end if;

  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.instagram_orders'::regclass
      and conname = 'instagram_orders_shipping_type_check'
      and not convalidated
  ) then
    alter table public.instagram_orders validate constraint instagram_orders_shipping_type_check;
  end if;
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.instagram_orders'::regclass
      and conname = 'instagram_orders_shipping_approval_check'
      and not convalidated
  ) then
    alter table public.instagram_orders validate constraint instagram_orders_shipping_approval_check;
  end if;
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.instagram_orders'::regclass
      and conname = 'instagram_orders_shipping_fee_check'
      and not convalidated
  ) then
    alter table public.instagram_orders validate constraint instagram_orders_shipping_fee_check;
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'instagram_orders'
      and column_name = 'order_type'
      and is_nullable = 'NO'
  ) then
    alter table public.instagram_orders alter column order_type set not null;
  end if;
end
$$;

-- Instagram addresses are free text. Remove the legacy five-character
-- minimum while retaining a safe maximum length for public submissions.
do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conrelid = 'public.instagram_orders'::regclass
      and conname = 'instagram_orders_address_check'
  ) then
    alter table public.instagram_orders
      drop constraint instagram_orders_address_check;
  end if;

  alter table public.instagram_orders
    add constraint instagram_orders_address_check
    check (char_length(coalesce(address, '')) <= 300) not valid;
end
$$;

-- The previous Instagram edit migration installed a delivery-only trigger.
-- Remove it before installing the narrower shipping-driver guard.
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

create index if not exists instagram_orders_type_approval_created_idx
  on public.instagram_orders (order_type, shipping_approval_status, created_at desc);
create index if not exists instagram_orders_company_type_created_idx
  on public.instagram_orders (company_id, order_type, created_at desc);

-- The live Instagram movement table may still have the older type check.
-- Keep existing rows untouched, but allow every movement type used by the
-- current Instagram workflow for newly-created audit rows.
do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conrelid = 'public.instagram_inventory_movements'::regclass
      and conname = 'instagram_inventory_movement_type_check'
  ) then
    alter table public.instagram_inventory_movements
      drop constraint instagram_inventory_movement_type_check;
  end if;

  alter table public.instagram_inventory_movements
    add constraint instagram_inventory_movement_type_check
    check (movement_type in (
      'initial_stock',
      'adjustment_in',
      'adjustment_out',
      'adjustment',
      'archive',
      'reservation',
      'shipping_approval',
      'return_release',
      'cancellation_release',
      'reopen_reservation',
      'sale',
      'status_rebalance'
    )) not valid;
end
$$;

-- =========================================================
-- Public creation baseline: the later pending-reservation migration replaces
-- this function so both delivery and shipping reserve stock at creation.
-- =========================================================
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
  v_stock_total integer;
  v_items_total numeric := 0;
  v_shipping_fee numeric := 0;
  v_name_parts integer;
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

  -- Serialize retries with the same idempotency key before reading/inserting.
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
      'shipping_approval_status', coalesce(v_existing.shipping_approval_status, 'not_required')
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

  -- Lock variants in a stable order. Delivery checks availability here;
  -- shipping only validates the catalog and waits for approval to reserve.
  for v_item in
    select
      (raw.item->>'variant_id')::uuid as variant_id,
      (raw.item->>'quantity')::integer as quantity
    from jsonb_array_elements(v_items) as raw(item)
    order by 1
  loop
    select v.product_id, v.color, v.size, v.stock_available, v.stock_total,
           product.name, product.unit_price, product.currency
    into v_product_id, v_color, v_size, v_stock_available, v_stock_total,
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
    if v_order_type = 'توصيل' and v_stock_available < v_item.quantity then
      raise exception 'الكمية المطلوبة غير متوفرة حالياً' using errcode = 'P0001';
    end if;
  end loop;

  if v_order_type = 'شحن' then
    if coalesce(v_selected_currency, 'ل.س') <> 'ل.س' then
      raise exception 'أجور الشحن متاحة مع المنتجات المسعرة بالليرة السورية فقط' using errcode = 'P0001';
    end if;
    v_shipping_fee := 10000;
  end if;

  -- Allocate the number while the company link row is locked. The collision
  -- loop also handles old databases where order_number is globally unique.
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
    order_number,
    company_id,
    company_name,
    customer_name,
    customer_number,
    address,
    order_type,
    order_source,
    total_price,
    currency,
    ratio,
    status,
    note,
    driver_id,
    driver_name,
    shipping_approval_status,
    shipping_fee,
    items_total,
    shipping_delivery_status,
    idempotency_key,
    is_archived
  ) values (
    v_order_number,
    v_company_id,
    coalesce(v_company_name, ''),
    btrim(p_customer_name),
    p_customer_number,
    btrim(p_address),
    v_order_type,
    'instagram',
    v_items_total + v_shipping_fee,
    coalesce(v_selected_currency, 'ل.س'),
    0,
    'قيد المتابعة',
    btrim(coalesce(p_note, '')),
    null,
    '',
    case when v_order_type = 'شحن' then 'pending' else 'not_required' end,
    v_shipping_fee,
    v_items_total,
    'pending',
    p_idempotency_key,
    false
  ) returning * into v_order;

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
      v_order.id, v_product_id, v_item.variant_id, v_product_name, v_color, v_size,
      v_unit_price, v_item.quantity
    ) returning id into v_item_id;

    if v_order_type = 'توصيل' then
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
        format('instagram:delivery-reservation:%s:%s', v_order.id, v_item.variant_id),
        'حجز طلب Instagram للتوصيل'
      );
    end if;
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
    'shipping_approval_status', v_order.shipping_approval_status
  );
end;
$$;

-- =========================================================
-- Instagram viewer approval/rejection for pending shipping orders.
-- =========================================================
create or replace function public.approve_instagram_shipping_order_atomic(
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
  v_company_id uuid;
  v_stock_available integer;
  v_stock_total integer;
  v_product_name text;
  v_color text;
  v_size text;
begin
  select mapping.company_id
  into v_company_id
  from public.instagram_viewer_companies mapping
  join public.users viewer on viewer.id = mapping.viewer_user_id
  where mapping.viewer_user_id = p_actor_user_id
    and viewer.role = 'instagram_viewer';
  if not found then
    raise exception 'غير مصرح بالموافقة على طلب الشحن' using errcode = 'P0001';
  end if;

  select * into v_order
  from public.instagram_orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'طلب Instagram غير موجود' using errcode = 'P0001';
  end if;
  if coalesce(v_order.company_id::text, '') <> coalesce(v_company_id::text, '') then
    raise exception 'لا تملك صلاحية هذا الطلب' using errcode = 'P0001';
  end if;
  if coalesce(v_order.is_archived, false) then
    raise exception 'لا يمكن معالجة طلب Instagram مؤرشف' using errcode = 'P0001';
  end if;
  if coalesce(v_order.order_type, 'توصيل') <> 'شحن' then
    raise exception 'الموافقة متاحة لطلبات الشحن فقط' using errcode = 'P0001';
  end if;
  if coalesce(v_order.shipping_approval_status, 'pending') = 'accepted' then
    return jsonb_build_object(
      'success', true,
      'duplicate', true,
      'id', v_order.id,
      'order_number', v_order.order_number,
      'shipping_approval_status', 'accepted'
    );
  end if;
  if coalesce(v_order.shipping_approval_status, '') <> 'pending' then
    raise exception 'حالة موافقة طلب الشحن غير قابلة للتنفيذ' using errcode = 'P0001';
  end if;
  if v_order.driver_id is not null then
    raise exception 'لا يمكن اعتماد طلب شحن معيّن لسائق' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.instagram_order_items where order_id = p_order_id
  ) then
    raise exception 'لا يمكن اعتماد طلب شحن بدون أصناف' using errcode = 'P0001';
  end if;

  -- First lock and validate every requested variant. Any failure rolls back
  -- the whole transaction, so an order cannot be half accepted.
  for v_item in
    select variant_id, sum(quantity)::integer as quantity
    from public.instagram_order_items
    where order_id = p_order_id
    group by variant_id
    order by variant_id
  loop
    select v.stock_available, v.stock_total
    into v_stock_available, v_stock_total
    from public.instagram_variants v
    join public.instagram_products product on product.id = v.product_id
    where v.id = v_item.variant_id
      and product.company_id = v_order.company_id
      and v.is_active = true
      and product.status = 'active'
    for update;
    if not found then
      raise exception 'تركيبة الصنف المرتبطة بالطلب غير موجودة' using errcode = 'P0001';
    end if;
    if v_stock_available < v_item.quantity then
      raise exception 'الكمية المطلوبة غير متوفرة حالياً' using errcode = 'P0001';
    end if;
  end loop;

  for v_item in
    select variant_id, sum(quantity)::integer as quantity
    from public.instagram_order_items
    where order_id = p_order_id
    group by variant_id
    order by variant_id
  loop
    update public.instagram_variants
    set stock_available = stock_available - v_item.quantity,
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
      v_item.variant_id, p_order_id,
      (select id from public.instagram_order_items
       where order_id = p_order_id and variant_id = v_item.variant_id
       order by id limit 1),
      'shipping_approval', v_item.quantity,
      0, -v_item.quantity, v_product_name, v_color, v_size,
      null, 'قيد المتابعة', p_actor_user_id,
      format('instagram:shipping-approval:%s:%s', p_order_id, v_item.variant_id),
      'اعتماد طلب الشحن وحجز المخزون'
    );
  end loop;

  update public.instagram_orders
  set shipping_approval_status = 'accepted',
      shipping_approved_at = now(),
      shipping_approved_by = p_actor_user_id,
      updated_at = now()
  where id = p_order_id
  returning * into v_order;

  return jsonb_build_object(
    'success', true,
    'duplicate', false,
    'id', v_order.id,
    'order_number', v_order.order_number,
    'shipping_approval_status', v_order.shipping_approval_status,
    'items_total', v_order.items_total,
    'shipping_fee', v_order.shipping_fee,
    'total_price', v_order.total_price
  );
end;
$$;

create or replace function public.reject_instagram_shipping_order_atomic(
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
  v_company_id uuid;
begin
  select mapping.company_id
  into v_company_id
  from public.instagram_viewer_companies mapping
  join public.users viewer on viewer.id = mapping.viewer_user_id
  where mapping.viewer_user_id = p_actor_user_id
    and viewer.role = 'instagram_viewer';
  if not found then
    raise exception 'غير مصرح برفض طلب الشحن' using errcode = 'P0001';
  end if;

  select * into v_order
  from public.instagram_orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'طلب Instagram غير موجود' using errcode = 'P0001';
  end if;
  if coalesce(v_order.company_id::text, '') <> coalesce(v_company_id::text, '') then
    raise exception 'لا تملك صلاحية هذا الطلب' using errcode = 'P0001';
  end if;
  if coalesce(v_order.is_archived, false) then
    raise exception 'لا يمكن معالجة طلب Instagram مؤرشف' using errcode = 'P0001';
  end if;
  if coalesce(v_order.order_type, 'توصيل') <> 'شحن'
    or coalesce(v_order.shipping_approval_status, 'pending') <> 'pending' then
    raise exception 'لا يمكن رفض طلب شحن تمت معالجته مسبقاً' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.instagram_inventory_movements
    where order_id = p_order_id
      and coalesce(stock_available_delta, 0) <> 0
  ) then
    raise exception 'تعذر الحذف الآمن: الطلب يحتوي على حركة مخزون' using errcode = 'P0001';
  end if;

  -- Pending shipping has no stock movement. Delete audit rows first in case
  -- an earlier implementation wrote zero-delta rows.
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
-- Driver protection: both the API and the database function accept delivery
-- only. A mixed selection fails as a whole.
-- =========================================================
create or replace function public.assign_instagram_orders_driver_atomic(
  p_order_ids uuid[],
  p_driver_id uuid,
  p_actor_user_id uuid,
  p_ratio numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order_id uuid;
  v_order_type text;
  v_driver_name text;
  v_count integer := 0;
begin
  if not exists (select 1 from public.users where id = p_actor_user_id and role = 'admin') then
    raise exception 'غير مصرح بتعيين سائق لطلبات Instagram' using errcode = 'P0001';
  end if;
  if p_order_ids is null or cardinality(p_order_ids) = 0 then
    raise exception 'لم يتم تحديد طلبات' using errcode = 'P0001';
  end if;
  select name into v_driver_name
  from public.users
  where id = p_driver_id and role = 'driver';
  if not found then
    raise exception 'السائق المحدد غير موجود' using errcode = 'P0001';
  end if;

  for v_order_id in
    select distinct value from unnest(p_order_ids) as selected(value) order by value
  loop
    select coalesce(order_type, 'توصيل') into v_order_type
    from public.instagram_orders
    where id = v_order_id and is_archived = false
    for update;
    if not found then
      raise exception 'طلب Instagram غير موجود' using errcode = 'P0001';
    end if;
    if v_order_type <> 'توصيل' then
      raise exception 'لا يمكن تعيين سائق لطلب شحن' using errcode = 'P0001';
    end if;
  end loop;

  for v_order_id in
    select distinct value from unnest(p_order_ids) as selected(value) order by value
  loop
    update public.instagram_orders
    set driver_id = p_driver_id,
        driver_name = coalesce(v_driver_name, ''),
        ratio = coalesce(p_ratio, ratio),
        updated_at = now()
    where id = v_order_id;
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('success', true, 'assigned_count', v_count);
end;
$$;

create or replace function public.unassign_instagram_orders_driver_atomic(
  p_order_ids uuid[],
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order_id uuid;
  v_order_type text;
  v_count integer := 0;
begin
  if not exists (select 1 from public.users where id = p_actor_user_id and role = 'admin') then
    raise exception 'غير مصرح بإلغاء تعيين سائق Instagram' using errcode = 'P0001';
  end if;
  if p_order_ids is null or cardinality(p_order_ids) = 0 then
    raise exception 'لم يتم تحديد طلبات' using errcode = 'P0001';
  end if;

  for v_order_id in
    select distinct value from unnest(p_order_ids) as selected(value) order by value
  loop
    select coalesce(order_type, 'توصيل') into v_order_type
    from public.instagram_orders
    where id = v_order_id and is_archived = false
    for update;
    if not found then
      raise exception 'طلب Instagram غير موجود' using errcode = 'P0001';
    end if;
    if v_order_type <> 'توصيل' then
      raise exception 'لا يمكن إلغاء تعيين سائق لطلب شحن' using errcode = 'P0001';
    end if;
  end loop;

  for v_order_id in
    select distinct value from unnest(p_order_ids) as selected(value) order by value
  loop
    update public.instagram_orders
    set driver_id = null, driver_name = '', updated_at = now()
    where id = v_order_id;
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('success', true, 'unassigned_count', v_count);
end;
$$;

-- =========================================================
-- Status transitions use the live variant stock columns. Legacy shipping rows
-- without a movement are not artificially restocked; new approved shipping
-- rows have a negative reservation movement and are restored on release.
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
  v_item record;
  v_stock_available integer;
  v_stock_total integer;
  v_net_delta integer;
  v_restore integer;
begin
  if p_new_status not in ('قيد المتابعة', 'تم', 'مؤجل', 'مرتجع', 'إلغاء') then
    raise exception 'حالة الطلب غير صالحة' using errcode = 'P0001';
  end if;
  select role into v_actor_role from public.users where id = p_actor_user_id;
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
    return jsonb_build_object('success', true, 'duplicate', true, 'id', p_order_id, 'status', p_new_status);
  end if;

  v_old_active := v_order.status in ('قيد المتابعة', 'مؤجل', 'تم');
  v_new_active := p_new_status in ('قيد المتابعة', 'مؤجل', 'تم');

  if v_old_active and not v_new_active then
    for v_item in
      select variant_id, sum(quantity)::integer as quantity
      from public.instagram_order_items
      where order_id = p_order_id
      group by variant_id
      order by variant_id
    loop
      select coalesce(sum(stock_available_delta), 0)::integer
      into v_net_delta
      from public.instagram_inventory_movements
      where order_id = p_order_id and variant_id = v_item.variant_id;
      v_restore := greatest(-v_net_delta, 0);
      if v_restore > 0 then
        select stock_available, stock_total
        into v_stock_available, v_stock_total
        from public.instagram_variants
        where id = v_item.variant_id
        for update;
        if not found or v_stock_available + v_restore > v_stock_total then
          raise exception 'تعذر تصحيح مخزون الصنف' using errcode = 'P0001';
        end if;
        update public.instagram_variants
        set stock_available = stock_available + v_restore, updated_at = now()
        where id = v_item.variant_id;
        insert into public.instagram_inventory_movements (
          variant_id, order_id, order_item_id, movement_type, quantity,
          stock_total_delta, stock_available_delta, product_name, color, size,
          status_from, status_to, created_by_user_id, event_key, note
        ) values (
          v_item.variant_id, p_order_id,
          (select id from public.instagram_order_items where order_id = p_order_id and variant_id = v_item.variant_id order by id limit 1),
          case when p_new_status = 'مرتجع' then 'return_release' else 'cancellation_release' end,
          v_restore, 0, v_restore,
          (select product_name from public.instagram_order_items where order_id = p_order_id and variant_id = v_item.variant_id order by id limit 1),
          (select color from public.instagram_order_items where order_id = p_order_id and variant_id = v_item.variant_id order by id limit 1),
          (select size from public.instagram_order_items where order_id = p_order_id and variant_id = v_item.variant_id order by id limit 1),
          v_order.status, p_new_status, p_actor_user_id, gen_random_uuid()::text,
          coalesce(nullif(btrim(p_note), ''), 'تحرير مخزون تغيير حالة طلب Instagram')
        );
      end if;
    end loop;
  elsif not v_old_active and v_new_active then
    for v_item in
      select variant_id, sum(quantity)::integer as quantity
      from public.instagram_order_items
      where order_id = p_order_id
      group by variant_id
      order by variant_id
    loop
      select stock_available
      into v_stock_available
      from public.instagram_variants
      where id = v_item.variant_id
      for update;
      if not found or v_stock_available < v_item.quantity then
        raise exception 'الكمية المطلوبة غير متوفرة حالياً' using errcode = 'P0001';
      end if;
      update public.instagram_variants
      set stock_available = stock_available - v_item.quantity, updated_at = now()
      where id = v_item.variant_id;
      insert into public.instagram_inventory_movements (
        variant_id, order_id, order_item_id, movement_type, quantity,
        stock_total_delta, stock_available_delta, product_name, color, size,
        status_from, status_to, created_by_user_id, event_key, note
      ) values (
        v_item.variant_id, p_order_id,
        (select id from public.instagram_order_items where order_id = p_order_id and variant_id = v_item.variant_id order by id limit 1),
        'reopen_reservation', v_item.quantity, 0, -v_item.quantity,
        (select product_name from public.instagram_order_items where order_id = p_order_id and variant_id = v_item.variant_id order by id limit 1),
        (select color from public.instagram_order_items where order_id = p_order_id and variant_id = v_item.variant_id order by id limit 1),
        (select size from public.instagram_order_items where order_id = p_order_id and variant_id = v_item.variant_id order by id limit 1),
        v_order.status, p_new_status, p_actor_user_id, gen_random_uuid()::text,
        coalesce(nullif(btrim(p_note), ''), 'إعادة حجز مخزون تغيير حالة طلب Instagram')
      );
    end loop;
  end if;

  update public.instagram_orders
  set status = p_new_status,
      note = case when p_note is null then note else btrim(p_note) end,
      updated_at = now()
  where id = p_order_id
  returning * into v_order;

  return jsonb_build_object('success', true, 'duplicate', false, 'id', v_order.id, 'status', v_order.status);
end;
$$;

create or replace function public.change_instagram_orders_status_atomic(
  p_order_ids uuid[],
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
  v_order_id uuid;
  v_count integer := 0;
begin
  if p_order_ids is null or cardinality(p_order_ids) = 0 then
    raise exception 'لم يتم تحديد طلبات' using errcode = 'P0001';
  end if;
  for v_order_id in
    select distinct value from unnest(p_order_ids) as selected(value) order by value
  loop
    perform public.change_instagram_order_status_atomic(v_order_id, p_new_status, p_actor_user_id, p_note);
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('success', true, 'updated_count', v_count);
end;
$$;

-- =========================================================
-- Hard deletion, including pending shipping rejection through its own RPC.
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
  v_movement record;
  v_stock_available integer;
  v_stock_total integer;
  v_new_available integer;
begin
  if not exists (select 1 from public.users where id = p_actor_user_id and role = 'admin') then
    raise exception 'غير مصرح بحذف طلب Instagram' using errcode = 'P0001';
  end if;
  select * into v_order from public.instagram_orders where id = p_order_id for update;
  if not found then
    raise exception 'طلب Instagram غير موجود' using errcode = 'P0001';
  end if;

  for v_movement in
    select variant_id, coalesce(sum(stock_available_delta), 0)::integer as net_delta
    from public.instagram_inventory_movements
    where order_id = p_order_id and variant_id is not null
    group by variant_id
    order by variant_id
  loop
    select stock_available, stock_total
    into v_stock_available, v_stock_total
    from public.instagram_variants
    where id = v_movement.variant_id
    for update;
    if not found then
      raise exception 'تركيبة المخزون المرتبطة بالطلب غير موجودة' using errcode = 'P0001';
    end if;
    v_new_available := v_stock_available - v_movement.net_delta;
    if v_new_available < 0 or v_new_available > v_stock_total then
      raise exception 'تعذر تصحيح المخزون عند حذف الطلب' using errcode = 'P0001';
    end if;
    update public.instagram_variants
    set stock_available = v_new_available, updated_at = now()
    where id = v_movement.variant_id;
  end loop;

  delete from public.instagram_inventory_movements where order_id = p_order_id;
  delete from public.instagram_order_items where order_id = p_order_id;
  delete from public.instagram_orders where id = p_order_id;

  return jsonb_build_object('success', true, 'deleted_order_id', p_order_id, 'deleted_order_number', v_order.order_number);
end;
$$;

create or replace function public.delete_instagram_orders_atomic(
  p_order_ids uuid[],
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order_id uuid;
  v_count integer := 0;
begin
  if p_order_ids is null or cardinality(p_order_ids) = 0 then
    raise exception 'لم يتم تحديد طلبات للحذف' using errcode = 'P0001';
  end if;
  for v_order_id in
    select distinct value from unnest(p_order_ids) as selected(value) order by value
  loop
    perform public.delete_instagram_order_atomic(v_order_id, p_actor_user_id);
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('success', true, 'deleted_count', v_count);
end;
$$;

-- =========================================================
-- Manager delivery to the owning Instagram account, one or many orders.
-- =========================================================
create or replace function public.mark_instagram_shipping_delivered_atomic(
  p_order_ids uuid[],
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order_id uuid;
  v_order public.instagram_orders%rowtype;
  v_company_name text;
  v_delivered_count integer := 0;
  v_skipped_count integer := 0;
  v_delivered_ids uuid[] := array[]::uuid[];
begin
  if not exists (select 1 from public.users where id = p_actor_user_id and role = 'admin') then
    raise exception 'غير مصرح بتسجيل تسليم طلبات الشحن' using errcode = 'P0001';
  end if;
  if p_order_ids is null or cardinality(p_order_ids) = 0 then
    raise exception 'لم يتم تحديد طلبات' using errcode = 'P0001';
  end if;

  for v_order_id in
    select distinct value from unnest(p_order_ids) as selected(value) order by value
  loop
    select * into v_order
    from public.instagram_orders
    where id = v_order_id
    for update;

    if not found
      or coalesce(v_order.order_type, 'توصيل') <> 'شحن'
      or coalesce(v_order.shipping_approval_status, 'pending') <> 'accepted'
      or coalesce(v_order.shipping_delivery_status, 'pending') = 'delivered'
      or coalesce(v_order.is_archived, false) then
      v_skipped_count := v_skipped_count + 1;
      continue;
    end if;

    v_company_name := null;
    select coalesce(nullif(btrim(company.name), ''), nullif(btrim(company.username), ''))
    into v_company_name
    from public.users company
    where company.id = v_order.company_id and company.role = 'company';
    v_company_name := coalesce(v_company_name, nullif(btrim(v_order.company_name), ''), 'غير معروف');

    update public.instagram_orders
    set shipping_delivery_status = 'delivered',
        shipping_delivered_at = now(),
        shipping_delivered_by = p_actor_user_id,
        shipping_delivered_to_name = v_company_name,
        updated_at = now()
    where id = v_order_id
      and order_type = 'شحن'
      and shipping_approval_status = 'accepted'
      and coalesce(shipping_delivery_status, 'pending') <> 'delivered';

    if found then
      v_delivered_count := v_delivered_count + 1;
      v_delivered_ids := array_append(v_delivered_ids, v_order_id);
    else
      v_skipped_count := v_skipped_count + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'success', true,
    'delivered_count', v_delivered_count,
    'skipped_count', v_skipped_count,
    'delivered_ids', to_jsonb(v_delivered_ids)
  );
end;
$$;

revoke all on function public.create_instagram_order_atomic(text, text, text, text, text, jsonb, uuid, text) from public, anon, authenticated;
revoke all on function public.approve_instagram_shipping_order_atomic(uuid, uuid) from public, anon, authenticated;
revoke all on function public.reject_instagram_shipping_order_atomic(uuid, uuid) from public, anon, authenticated;
revoke all on function public.assign_instagram_orders_driver_atomic(uuid[], uuid, uuid, numeric) from public, anon, authenticated;
revoke all on function public.unassign_instagram_orders_driver_atomic(uuid[], uuid) from public, anon, authenticated;
revoke all on function public.change_instagram_order_status_atomic(uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function public.change_instagram_orders_status_atomic(uuid[], text, uuid, text) from public, anon, authenticated;
revoke all on function public.delete_instagram_order_atomic(uuid, uuid) from public, anon, authenticated;
revoke all on function public.delete_instagram_orders_atomic(uuid[], uuid) from public, anon, authenticated;
revoke all on function public.mark_instagram_shipping_delivered_atomic(uuid[], uuid) from public, anon, authenticated;

grant execute on function public.create_instagram_order_atomic(text, text, text, text, text, jsonb, uuid, text) to service_role;
grant execute on function public.approve_instagram_shipping_order_atomic(uuid, uuid) to service_role;
grant execute on function public.reject_instagram_shipping_order_atomic(uuid, uuid) to service_role;
grant execute on function public.assign_instagram_orders_driver_atomic(uuid[], uuid, uuid, numeric) to service_role;
grant execute on function public.unassign_instagram_orders_driver_atomic(uuid[], uuid) to service_role;
grant execute on function public.change_instagram_order_status_atomic(uuid, text, uuid, text) to service_role;
grant execute on function public.change_instagram_orders_status_atomic(uuid[], text, uuid, text) to service_role;
grant execute on function public.delete_instagram_order_atomic(uuid, uuid) to service_role;
grant execute on function public.delete_instagram_orders_atomic(uuid[], uuid) to service_role;
grant execute on function public.mark_instagram_shipping_delivered_atomic(uuid[], uuid) to service_role;

revoke all on function public.instagram_orders_shipping_driver_guard() from public, anon, authenticated;

commit;

-- If the tables are large, these optional indexes can be created separately
-- outside the transaction with CREATE INDEX CONCURRENTLY after deployment.
