-- WolfOrder / reserve Instagram shipping inventory while approval is pending
--
-- Apply after 2026-09-05-instagram-inventory-release-fix.sql.
-- Shipping orders now reserve stock at creation. Approval only changes the
-- approval state; rejection releases the reservation and deletes the order.

begin;

-- =========================================================
-- Shared reservation helper for legacy pending orders and approval.
-- It is intentionally not exposed to browser roles. The helper is idempotent:
-- it reserves only the quantity not already represented by a negative
-- stock_available movement for this order.
-- =========================================================
create or replace function public.reserve_instagram_shipping_order_stock(
  p_order_id uuid,
  p_movement_type text default 'shipping_approval',
  p_note text default 'حجز مخزون طلب الشحن'
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.instagram_orders%rowtype;
  v_item record;
  v_reserved_quantity integer;
  v_missing_quantity integer;
  v_stock_available integer;
  v_product_name text;
  v_color text;
  v_size text;
  v_reserved_total integer := 0;
begin
  if p_movement_type not in ('reservation', 'shipping_approval') then
    raise exception 'نوع حركة حجز الشحن غير صالح' using errcode = 'P0001';
  end if;

  select * into v_order
  from public.instagram_orders
  where id = p_order_id
    and coalesce(is_archived, false) = false
  for update;
  if not found then
    raise exception 'طلب Instagram غير موجود' using errcode = 'P0001';
  end if;
  if coalesce(v_order.order_type, 'توصيل') <> 'شحن'
    or coalesce(v_order.shipping_approval_status, 'pending') <> 'pending' then
    raise exception 'لا يمكن حجز مخزون لطلب شحن تمت معالجته مسبقاً' using errcode = 'P0001';
  end if;
  if exists (
    select 1
    from public.instagram_order_items
    where order_id = p_order_id and variant_id is null
  ) then
    raise exception 'لا يمكن حجز طلب شحن يحتوي على صنف غير صالح' using errcode = 'P0001';
  end if;

  -- Validate every missing quantity first while locking variants in a stable
  -- order. Any shortage rolls back the entire reservation attempt.
  for v_item in
    select oi.variant_id, sum(oi.quantity)::integer as quantity
    from public.instagram_order_items oi
    where oi.order_id = p_order_id
    group by oi.variant_id
    order by oi.variant_id
  loop
    select greatest(-coalesce(sum(movement.stock_available_delta), 0), 0)::integer
    into v_reserved_quantity
    from public.instagram_inventory_movements movement
    where movement.order_id = p_order_id
      and movement.variant_id = v_item.variant_id;

    v_missing_quantity := greatest(v_item.quantity - v_reserved_quantity, 0);
    if v_missing_quantity = 0 then
      continue;
    end if;

    select variant.stock_available
    into v_stock_available
    from public.instagram_variants variant
    join public.instagram_products product on product.id = variant.product_id
    where variant.id = v_item.variant_id
      and variant.is_active = true
      and product.company_id = v_order.company_id
      and product.status = 'active'
    for update;

    if not found then
      raise exception 'تركيبة الصنف المرتبطة بطلب الشحن غير موجودة' using errcode = 'P0001';
    end if;
    if v_stock_available < v_missing_quantity then
      raise exception 'الكمية المطلوبة غير متوفرة حالياً' using errcode = 'P0001';
    end if;
  end loop;

  -- Apply only the missing part. This makes approval safe for both new orders
  -- (already reserved at creation) and legacy orders (not yet reserved).
  for v_item in
    select oi.variant_id, sum(oi.quantity)::integer as quantity
    from public.instagram_order_items oi
    where oi.order_id = p_order_id
    group by oi.variant_id
    order by oi.variant_id
  loop
    select greatest(-coalesce(sum(movement.stock_available_delta), 0), 0)::integer
    into v_reserved_quantity
    from public.instagram_inventory_movements movement
    where movement.order_id = p_order_id
      and movement.variant_id = v_item.variant_id;

    v_missing_quantity := greatest(v_item.quantity - v_reserved_quantity, 0);
    if v_missing_quantity = 0 then
      continue;
    end if;

    update public.instagram_variants
    set stock_available = stock_available - v_missing_quantity,
        updated_at = now()
    where id = v_item.variant_id
      and stock_available >= v_missing_quantity;
    if not found then
      raise exception 'الكمية المطلوبة غير متوفرة حالياً' using errcode = 'P0001';
    end if;

    select product_name, color, size
    into v_product_name, v_color, v_size
    from public.instagram_order_items
    where order_id = p_order_id
      and variant_id = v_item.variant_id
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
      p_movement_type,
      v_missing_quantity,
      0,
      -v_missing_quantity,
      v_product_name,
      v_color,
      v_size,
      null,
      'قيد المتابعة',
      null,
      format('instagram:shipping-pending-reservation:%s:%s:%s', p_order_id, v_item.variant_id, gen_random_uuid()),
      coalesce(nullif(btrim(p_note), ''), 'حجز مخزون طلب الشحن')
    );

    v_reserved_total := v_reserved_total + v_missing_quantity;
  end loop;

  return v_reserved_total;
end;
$$;

-- =========================================================
-- Public creation: both delivery and shipping reserve stock atomically.
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
  if coalesce(p_customer_number, '') !~ '^0[0-9]{9}$' then
    raise exception 'رقم العميل يجب أن يتكون من 10 أرقام ويبدأ بالرقم 0' using errcode = 'P0001';
  end if;
  if char_length(btrim(coalesce(p_address, ''))) not between 3 and 300 then
    raise exception 'العنوان مطلوب ويجب أن يتكون من 3 محارف على الأقل' using errcode = 'P0001';
  end if;
  if char_length(coalesce(p_note, '')) > 85 then
    raise exception 'الملاحظة يجب ألا تتجاوز 85 محرفاً' using errcode = 'P0001';
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
    0, 'قيد المتابعة', left(btrim(coalesce(p_note, '')), 85), null, '',
    case when v_order_type = 'شحن' then 'pending' else 'not_required' end,
    v_shipping_fee, v_items_total, 'pending', p_idempotency_key, false
  ) returning * into v_order;

  v_movement_event := case
    when v_order_type = 'شحن' then 'instagram:shipping-pending-reservation:'
    else 'instagram:delivery-reservation:'
  end;
  v_movement_note := case
    when v_order_type = 'شحن' then 'حجز طلب Instagram للشحن بانتظار موافقة الشركة'
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
    'shipping_approval_status', v_order.shipping_approval_status
  );
end;
$$;

-- =========================================================
-- Approval: new orders are already reserved; legacy pending orders are
-- reserved here only when their reservation movement is missing.
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
  v_company_id uuid;
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

  -- No second deduction for new orders. Legacy pending orders are completed
  -- here if they were created before pending reservations were introduced.
  perform public.reserve_instagram_shipping_order_stock(
    p_order_id,
    'shipping_approval',
    'اعتماد طلب الشحن وحجز المخزون للطلب القديم'
  );

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

-- =========================================================
-- Rejection: release only the reservation that actually exists, then delete.
-- =========================================================
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
  v_item record;
  v_net_delta integer;
  v_release integer;
  v_stock_available integer;
  v_stock_total integer;
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

  for v_item in
    select variant_id, sum(quantity)::integer as quantity
    from public.instagram_order_items
    where order_id = p_order_id and variant_id is not null
    group by variant_id
    order by variant_id
  loop
    select coalesce(sum(movement.stock_available_delta), 0)::integer
    into v_net_delta
    from public.instagram_inventory_movements movement
    where movement.order_id = p_order_id
      and movement.variant_id = v_item.variant_id;

    -- A pending order created before the new workflow has no negative
    -- reservation, so rejection does not invent stock that was never held.
    v_release := least(v_item.quantity, greatest(-v_net_delta, 0));
    if v_release = 0 then
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
    if v_stock_available + v_release > v_stock_total then
      raise exception 'تعذر إعادة المخزون عند رفض طلب الشحن' using errcode = 'P0001';
    end if;

    update public.instagram_variants
    set stock_available = stock_available + v_release,
        updated_at = now()
    where id = v_item.variant_id;
  end loop;

  if to_regclass('public.instagram_order_status_history') is not null then
    execute 'delete from public.instagram_order_status_history where order_id = $1'
      using p_order_id;
  end if;
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
-- Admin hard deletion also understands pending reservations. Pending shipping
-- orders remain hidden from the admin list, but a direct deletion is still
-- safe and releases only a reservation that exists.
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
  v_pending_shipping boolean;
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
  v_pending_shipping := coalesce(v_order.order_type, 'توصيل') = 'شحن'
    and coalesce(v_order.shipping_approval_status, 'pending') = 'pending';

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
    v_restore := case
      when v_item.item_quantity > 0 and v_active_order and v_stock_order
        then v_item.item_quantity
      when v_item.item_quantity > 0 and v_active_order and v_pending_shipping
        then least(v_item.item_quantity, greatest(-v_item.movement_net_delta, 0))
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

  if to_regclass('public.instagram_order_status_history') is not null then
    execute 'delete from public.instagram_order_status_history where order_id = $1'
      using p_order_id;
  end if;
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

-- Existing pending shipping orders were created before the reservation rule.
-- Reserve them in creation order where stock is available. If an old queue is
-- already overbooked, leave the excess pending order unchanged so the company
-- can reject it or the stock can be replenished before approval.
do $$
declare
  v_order_id uuid;
begin
  for v_order_id in
    select id
    from public.instagram_orders
    where coalesce(order_type, 'توصيل') = 'شحن'
      and coalesce(shipping_approval_status, 'pending') = 'pending'
      and coalesce(is_archived, false) = false
    order by created_at, id
  loop
    begin
      perform public.reserve_instagram_shipping_order_stock(
        v_order_id,
        'reservation',
        'حجز مخزون طلب شحن قديم بانتظار موافقة الشركة'
      );
    exception when others then
      raise notice 'تعذر حجز طلب الشحن القديم %: %', v_order_id, sqlerrm;
    end;
  end loop;
end;
$$;

revoke all on function public.reserve_instagram_shipping_order_stock(uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.create_instagram_order_atomic(text, text, text, text, text, jsonb, uuid, text)
  from public, anon, authenticated;
revoke all on function public.approve_instagram_shipping_order_atomic(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.reject_instagram_shipping_order_atomic(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.delete_instagram_order_atomic(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.create_instagram_order_atomic(text, text, text, text, text, jsonb, uuid, text) to service_role;
grant execute on function public.approve_instagram_shipping_order_atomic(uuid, uuid) to service_role;
grant execute on function public.reject_instagram_shipping_order_atomic(uuid, uuid) to service_role;
grant execute on function public.delete_instagram_order_atomic(uuid, uuid) to service_role;

commit;
