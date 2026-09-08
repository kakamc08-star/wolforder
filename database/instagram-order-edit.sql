-- WolfOrder Instagram order editing (historical compatibility migration)
-- نفّذ هذا الملف مرة واحدة فقط إذا لم يكن مطبقاً، ثم شغّل
-- 2026-09-08-instagram-order-edit-type-and-validation.sql للنسخة النهائية.
-- لا ينشئ جداول جديدة ولا يحذف الطلبات الحالية.

begin;

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
  if coalesce(v_order.order_type, 'توصيل') not in ('توصيل', 'شحن') then
    raise exception 'نوع طلب Instagram غير صالح';
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

  if exists (
    select 1
    from public.instagram_orders
    where order_number = coalesce(p_order_number, v_order.order_number)
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
  if char_length(btrim(v_address)) not between 5 and 300 then
    raise exception 'العنوان مطلوب ويجب أن يكون واضحاً';
  end if;
  if v_total_price < 0 or v_ratio < 0 then
    raise exception 'السعر أو النسبة غير صالح';
  end if;
  if v_new_status not in ('قيد المتابعة', 'تم', 'مؤجل', 'مرتجع', 'إلغاء') then
    raise exception 'حالة الطلب غير صالحة';
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

    v_computed_total := v_computed_total + (coalesce(v_unit_price, 0) * v_desired_item.quantity);
  end loop;

  if p_recalculate_total_price then
    v_total_price := v_computed_total;
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

revoke all on function public.update_instagram_order_atomic(
  uuid, uuid, bigint, text, text, text, numeric, numeric, text, text, uuid, uuid, jsonb, boolean
) from public, anon, authenticated;
grant execute on function public.update_instagram_order_atomic(
  uuid, uuid, bigint, text, text, text, numeric, numeric, text, text, uuid, uuid, jsonb, boolean
) to service_role;

-- The final workflow supports both types. Keep only the driver invariant here
-- when this historical file is run before the current migration.
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
    raise exception 'لا يمكن تعيين سائق لطلب شحن';
  end if;
  return new;
end;
$$;

drop trigger if exists instagram_orders_shipping_driver_guard on public.instagram_orders;
create trigger instagram_orders_shipping_driver_guard
before insert or update of order_type, driver_id on public.instagram_orders
for each row execute function public.instagram_orders_shipping_driver_guard();

commit;
