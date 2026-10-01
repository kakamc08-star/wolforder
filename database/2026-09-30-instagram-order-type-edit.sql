-- Apply after 2026-09-30-instagram-direct-shipping-and-edit-requests.sql.
-- Only Instagram order editing is changed. Existing stock/status functions are reused.
begin;

-- A private name avoids ambiguous calls when old 14/15-argument overloads coexist.
create or replace function public.edit_instagram_order_items_core_atomic(
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

create or replace function public.edit_instagram_order_atomic(
  p_order_id uuid, p_actor_user_id uuid, p_changes jsonb
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_order public.instagram_orders%rowtype;
  v_result public.instagram_orders%rowtype;
  v_old_type text; v_type text; v_type_changed boolean; v_shipping boolean;
  v_fee numeric; v_total numeric; v_item_total numeric; v_ratio numeric;
  v_name text; v_number text; v_address text; v_status text; v_shipping_status text;
  v_company_id uuid; v_company_name text; v_driver_id uuid; v_driver_name text;
  v_order_number bigint; v_key text; v_items jsonb; v_recalculate boolean;
begin
  if not exists (select 1 from public.users where id = p_actor_user_id and role = 'admin') then
    raise exception 'غير مصرح بتعديل طلب Instagram';
  end if;
  select * into v_order from public.instagram_orders where id = p_order_id and is_archived = false for update;
  if not found then raise exception 'طلب Instagram غير موجود'; end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then
    raise exception 'لم يتم إرسال أي تعديل';
  end if;
  if exists (select 1 from jsonb_object_keys(p_changes) key where key not in (
    'order_type', 'order_number', 'customer_name', 'customer_number', 'address', 'note',
    'total_price', 'ratio', 'company_id', 'driver_id', 'status', 'shipping_delivery_status',
    'items', 'recalculate_total_price')) then raise exception 'حقول التعديل غير مسموحة'; end if;

  v_old_type := coalesce(v_order.order_type, 'توصيل');
  v_type := coalesce(p_changes->>'order_type', v_old_type);
  if (p_changes ? 'order_type' and jsonb_typeof(p_changes->'order_type') <> 'string')
    or v_type not in ('شحن', 'توصيل') then raise exception 'نوع الطلب غير صالح'; end if;
  v_type_changed := v_type <> v_old_type;
  v_shipping := v_type = 'شحن';
  v_fee := case when not v_shipping then 0 when v_type_changed then 10000 else coalesce(v_order.shipping_fee, 0) end;
  v_name := coalesce(p_changes->>'customer_name', v_order.customer_name);
  v_number := coalesce(p_changes->>'customer_number', v_order.customer_number);
  v_address := coalesce(p_changes->>'address', v_order.address, '');
  for v_key in select unnest(array['customer_name', 'customer_number', 'address', 'note']) loop
    if p_changes ? v_key and jsonb_typeof(p_changes->v_key) <> 'string' then
      raise exception 'بيانات التعديل غير صالحة';
    end if;
  end loop;
  if char_length(btrim(v_name)) not between 2 and 100 or char_length(v_address) > 300
    or (not v_shipping and char_length(btrim(v_address)) < 5)
    or (p_changes ? 'note' and char_length(p_changes->>'note') > 1000) then
    raise exception 'اسم العميل أو العنوان أو الملاحظة غير صالح';
  end if;
  if v_shipping and (
    (select count(*) from regexp_split_to_table(btrim(v_name), '\s+') part where part <> '') < 3
    or coalesce(v_number, '') !~ '^[0-9]{10}$'
    or coalesce(v_order.currency, 'ل.س') <> 'ل.س'
  ) then raise exception 'الشحن يتطلب الاسم الثلاثي ورقماً من 10 أرقام وعملة الليرة السورية'; end if;

  v_company_id := case when p_changes ? 'company_id' then (p_changes->>'company_id')::uuid else v_order.company_id end;
  select name into v_company_name from public.users where id = v_company_id and role = 'company';
  if not found then raise exception 'الشركة المحددة غير موجودة'; end if;
  if v_shipping and v_company_id is distinct from v_order.company_id then
    raise exception 'لا يمكن تغيير شركة طلب الشحن';
  end if;
  v_driver_id := case when p_changes ? 'driver_id' then (p_changes->>'driver_id')::uuid else v_order.driver_id end;
  if v_shipping then
    if p_changes ? 'driver_id' and p_changes->>'driver_id' is not null then
      raise exception 'لا يمكن تعيين سائق لطلب شحن';
    end if;
    v_driver_id := null;
  end if;
  if v_driver_id is not null then
    select name into v_driver_name from public.users where id = v_driver_id and role = 'driver';
    if not found then raise exception 'السائق المحدد غير موجود'; end if;
  end if;

  v_order_number := v_order.order_number;
  if p_changes ? 'order_number' then
    if jsonb_typeof(p_changes->'order_number') <> 'number' or (p_changes->>'order_number') !~ '^[1-9][0-9]*$'
      or (p_changes->>'order_number')::numeric > 9007199254740991 then raise exception 'رقم الطلب غير صالح'; end if;
    v_order_number := (p_changes->>'order_number')::bigint;
    if v_order_number is distinct from v_order.order_number and exists (select 1 from public.instagram_orders
      where order_number = v_order_number and (not v_shipping or company_id = v_company_id) and id <> p_order_id) then
      raise exception 'رقم الطلب مستخدم مسبقاً';
    end if;
  end if;
  for v_key in select unnest(array['total_price', 'ratio']) loop
    if p_changes ? v_key and (jsonb_typeof(p_changes->v_key) <> 'number' or (p_changes->>v_key)::numeric < 0) then
      raise exception 'السعر أو النسبة غير صالح';
    end if;
  end loop;
  v_total := coalesce((p_changes->>'total_price')::numeric, case when v_type_changed then
    greatest(coalesce(v_order.total_price, 0) - coalesce(v_order.shipping_fee, 0), 0) + v_fee
    else coalesce(v_order.total_price, 0) end);
  v_ratio := coalesce((p_changes->>'ratio')::numeric, v_order.ratio, 0);
  if p_changes ? 'recalculate_total_price' and
    (not (p_changes ? 'items') or jsonb_typeof(p_changes->'recalculate_total_price') <> 'boolean') then
    raise exception 'إعادة حساب السعر تتطلب أصنافاً صالحة';
  end if;
  v_items := p_changes->'items';
  v_recalculate := coalesce((p_changes->>'recalculate_total_price')::boolean, false);
  if p_changes ? 'items' then
    if jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) not between 1 and 50 then
      raise exception 'يجب اختيار من 1 إلى 50 صنفاً';
    end if;
    if exists (select 1 from jsonb_array_elements(v_items) item
      where jsonb_typeof(item) <> 'object' or coalesce(item->>'variant_id', '') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or coalesce(item->>'quantity', '') !~ '^[1-9][0-9]*$') then raise exception 'الصنف أو الكمية غير صالحة'; end if;
    if exists (select 1 from jsonb_array_elements(v_items) item where (item->>'quantity')::numeric > 1000) then
      raise exception 'الكمية يجب ألا تتجاوز 1000';
    end if;
    if v_shipping and exists (select 1 from jsonb_array_elements(v_items) item
      join public.instagram_variants variant on variant.id = (item->>'variant_id')::uuid
      join public.instagram_products product on product.id = variant.product_id
      where coalesce(product.currency, 'ل.س') <> 'ل.س') then raise exception 'طلبات الشحن متاحة بالليرة السورية فقط'; end if;
    if v_recalculate then
      select coalesce(sum(product.unit_price * (item->>'quantity')::integer), 0) into v_item_total
      from jsonb_array_elements(v_items) item
      join public.instagram_variants variant on variant.id = (item->>'variant_id')::uuid
      join public.instagram_products product on product.id = variant.product_id;
      v_total := v_item_total + v_fee;
    end if;
  end if;
  if v_total < v_fee then raise exception 'السعر النهائي يجب ألا يقل عن أجور الشحن'; end if;

  if v_shipping then
    if p_changes ? 'status' then raise exception 'طلبات الشحن تستخدم حالة التسليم فقط'; end if;
    v_status := case when v_type_changed then 'قيد المتابعة' else v_order.status end;
    v_shipping_status := coalesce(p_changes->>'shipping_delivery_status',
      case when v_type_changed then case when v_order.status = 'تم' then 'delivered' else 'pending' end
        else coalesce(v_order.shipping_delivery_status, 'pending') end);
    if (p_changes ? 'shipping_delivery_status' and jsonb_typeof(p_changes->'shipping_delivery_status') <> 'string')
      or v_shipping_status not in ('pending', 'delivered') then raise exception 'حالة تسليم الشحن غير صالحة'; end if;
  else
    if p_changes ? 'shipping_delivery_status' then raise exception 'حالة تسليم الشحن غير صالحة'; end if;
    v_status := coalesce(p_changes->>'status', case when v_type_changed then
      case when v_order.status in ('مرتجع', 'إلغاء') then v_order.status
        when v_order.shipping_delivery_status = 'delivered' then 'تم' else 'قيد المتابعة' end
      else v_order.status end);
    if (p_changes ? 'status' and jsonb_typeof(p_changes->'status') <> 'string')
      or v_status not in ('قيد المتابعة', 'تم', 'مؤجل', 'مرتجع', 'إلغاء') then raise exception 'حالة الطلب غير صالحة'; end if;
  end if;

  -- Shipping-to-delivery must switch type before reusing the general status editor.
  if v_type_changed and not v_shipping then
    update public.instagram_orders set order_type = 'توصيل' where id = p_order_id;
  end if;
  if p_changes ? 'items' or v_company_id is distinct from v_order.company_id then
    -- Reuse the existing locked stock/item editor while the old delivery status is still accurate.
    perform public.edit_instagram_order_items_core_atomic(
      p_order_id => p_order_id, p_actor_user_id => p_actor_user_id,
      p_order_number => v_order_number, p_customer_name => v_name, p_customer_number => v_number,
      p_address => v_address, p_total_price => v_total, p_ratio => v_ratio,
      p_note => p_changes->>'note', p_status => v_status,
      p_driver_id => v_driver_id, p_company_id => v_company_id, p_items => v_items,
      p_recalculate_total_price => false
    );
  elsif v_status is distinct from v_order.status then
    -- Metadata/type-only changes preserve item snapshots and adjust stock only for a status transition.
    perform public.change_instagram_order_status_atomic(p_order_id, v_status, p_actor_user_id, null);
  end if;
  update public.instagram_orders
  set order_type = v_type, order_number = v_order_number,
      customer_name = btrim(v_name), customer_number = v_number, address = btrim(v_address),
      company_id = v_company_id, company_name = v_company_name,
      driver_id = v_driver_id, driver_name = coalesce(v_driver_name, ''),
      status = v_status, shipping_fee = v_fee, total_price = v_total, items_total = greatest(v_total - v_fee, 0),
      ratio = v_ratio, note = coalesce(p_changes->>'note', note),
      shipping_delivery_status = case when v_type_changed or not v_shipping then 'pending' else shipping_delivery_status end,
      shipping_delivered_at = case when v_type_changed or not v_shipping then null else shipping_delivered_at end,
      shipping_delivered_by = case when v_type_changed or not v_shipping then null else shipping_delivered_by end,
      shipping_delivered_to_name = case when v_type_changed or not v_shipping then null else shipping_delivered_to_name end,
      updated_at = now()
  where id = p_order_id;
  if v_shipping then
    perform public.set_instagram_shipping_delivery_status_atomic(array[p_order_id], v_shipping_status, p_actor_user_id);
  end if;
  select * into v_result from public.instagram_orders where id = p_order_id;
  return to_jsonb(v_result) || jsonb_build_object('items', coalesce((select jsonb_agg(to_jsonb(item) order by item.created_at, item.id)
    from public.instagram_order_items item where item.order_id = p_order_id), '[]'::jsonb));
end;
$$;


create or replace function public.instagram_order_edit_snapshot(p_order_id uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'order_number', ord.order_number, 'company_id', ord.company_id,
    'order_type', coalesce(ord.order_type, 'توصيل'), 'shipping_fee', coalesce(ord.shipping_fee, 0), 'currency', coalesce(ord.currency, 'ل.س'),
    'customer_name', ord.customer_name, 'customer_number', ord.customer_number,
    'address', ord.address, 'note', coalesce(ord.note, ''), 'total_price', ord.total_price,
    'status', ord.status, 'shipping_delivery_status', coalesce(ord.shipping_delivery_status, 'pending'),
    'items', coalesce((select jsonb_agg(jsonb_build_object('variant_id', items.variant_id, 'quantity', items.quantity) order by items.variant_id)
      from (select variant_id, sum(quantity)::integer as quantity from public.instagram_order_items
        where order_id = p_order_id group by variant_id) items), '[]'::jsonb)
  ) from public.instagram_orders ord where ord.id = p_order_id;
$$;

-- Add the new snapshot keys to pending proposals created before type editing was available.
update public.instagram_order_edit_requests request
set original_values = request.original_values || jsonb_build_object(
  'order_type', coalesce(ord.order_type, 'توصيل'), 'shipping_fee', coalesce(ord.shipping_fee, 0), 'currency', coalesce(ord.currency, 'ل.س'))
from public.instagram_orders ord
where request.order_id = ord.id and request.status = 'معلق' and not (request.original_values ? 'order_type');

create or replace function public.create_instagram_order_edit_request_atomic(
  p_order_id uuid, p_actor_user_id uuid, p_changes jsonb, p_reason text default ''
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_company_id uuid; v_viewer_name text; v_order public.instagram_orders%rowtype;
  v_request public.instagram_order_edit_requests%rowtype;
  v_changes jsonb; v_original jsonb; v_original_items jsonb; v_proposed_items jsonb := '[]'::jsonb;
  v_key text; v_shipping boolean; v_type text; v_fee numeric;
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
    'status', 'shipping_delivery_status', 'order_type', 'items', 'recalculate_total_price')) then
    raise exception 'يتضمن طلب التعديل حقولاً غير مسموحة';
  end if;
  v_changes := p_changes;
  v_type := coalesce(p_changes->>'order_type', v_order.order_type, 'توصيل');
  if (p_changes ? 'order_type' and jsonb_typeof(p_changes->'order_type') <> 'string')
    or v_type not in ('شحن', 'توصيل') then raise exception 'نوع الطلب غير صالح'; end if;
  v_shipping := v_type = 'شحن';
  v_fee := case when not v_shipping then 0 when v_type is distinct from coalesce(v_order.order_type, 'توصيل') then 10000
    else coalesce(v_order.shipping_fee, 0) end;
  if p_changes ? 'order_type' and v_type is distinct from coalesce(v_order.order_type, 'توصيل') then
    if v_shipping and (coalesce(v_order.currency, 'ل.س') <> 'ل.س'
      or (select count(*) from regexp_split_to_table(btrim(coalesce(p_changes->>'customer_name', v_order.customer_name)), '\s+') part where part <> '') < 3
      or coalesce(p_changes->>'customer_number', v_order.customer_number, '') !~ '^[0-9]{10}$') then
      raise exception 'الشحن يتطلب الاسم الثلاثي ورقماً من 10 أرقام وعملة الليرة السورية';
    end if;
    if not v_shipping and char_length(btrim(coalesce(p_changes->>'address', v_order.address, ''))) < 5 then
      raise exception 'العنوان مطلوب لطلب التوصيل';
    end if;
  end if;
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
    if (p_changes->>'total_price')::numeric < v_fee then
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
    if v_current->'order_type' is distinct from v_request.original_values->'order_type' then
      raise exception 'تغير نوع الطلب بعد إرسال طلب التعديل؛ ارفضه واطلب مقترحاً جديداً';
    end if;
    if (v_changes ? 'total_price' or v_changes ? 'items' or v_changes ? 'order_type')
      and (v_current->'shipping_fee' is distinct from v_request.original_values->'shipping_fee'
        or v_current->'currency' is distinct from v_request.original_values->'currency') then
      raise exception 'تغيرت أجور الطلب أو عملته بعد إرسال طلب التعديل';
    end if;
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
    v_result := public.edit_instagram_order_atomic(v_order.id, p_actor_user_id, v_changes);
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

revoke all on function public.edit_instagram_order_items_core_atomic(uuid, uuid, bigint, text, text, text, numeric, numeric, text, text, uuid, uuid, jsonb, boolean) from public, anon, authenticated, service_role;
revoke all on function public.edit_instagram_order_atomic(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.edit_instagram_order_atomic(uuid, uuid, jsonb) to service_role;
revoke all on function public.instagram_order_edit_snapshot(uuid) from public, anon, authenticated;
revoke all on function public.create_instagram_order_edit_request_atomic(uuid, uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.decide_instagram_order_edit_request_atomic(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.create_instagram_order_edit_request_atomic(uuid, uuid, jsonb, text) to service_role;
grant execute on function public.decide_instagram_order_edit_request_atomic(uuid, uuid, boolean, text) to service_role;
notify pgrst, 'reload schema';
commit;
