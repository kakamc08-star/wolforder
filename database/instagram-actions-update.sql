-- WolfOrder Instagram actions update
-- Run this file once in Supabase SQL Editor before deploying the matching code.

begin;

create or replace function public.delete_instagram_order_atomic(
  p_order_id uuid,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_number bigint;
  v_movement record;
  v_stock_available integer;
  v_stock_total integer;
  v_new_available integer;
begin
  if not exists (
    select 1 from public.users
    where id = p_actor_user_id and role = 'admin'
  ) then
    raise exception 'غير مصرح بحذف طلب Instagram';
  end if;

  select order_number
  into v_order_number
  from public.instagram_orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'طلب Instagram غير موجود';
  end if;

  -- Reverse the net availability effect of every movement created by this order.
  -- Reservation produces a negative delta; cancellation/restock balances it to zero.
  for v_movement in
    select variant_id, coalesce(sum(stock_available_delta), 0)::integer as net_delta
    from public.instagram_inventory_movements
    where order_id = p_order_id and variant_id is not null
    group by variant_id
  loop
    select stock_available, stock_total
    into v_stock_available, v_stock_total
    from public.instagram_variants
    where id = v_movement.variant_id
    for update;

    if not found then
      raise exception 'تركيبة المخزون المرتبطة بالطلب غير موجودة';
    end if;

    v_new_available := v_stock_available - v_movement.net_delta;
    if v_new_available < 0 or v_new_available > v_stock_total then
      raise exception 'تعذر تصحيح المخزون عند حذف الطلب';
    end if;

    update public.instagram_variants
    set stock_available = v_new_available,
        updated_at = now()
    where id = v_movement.variant_id;
  end loop;

  delete from public.instagram_inventory_movements where order_id = p_order_id;
  delete from public.instagram_order_items where order_id = p_order_id;
  delete from public.instagram_orders where id = p_order_id;

  return jsonb_build_object(
    'success', true,
    'deleted_order_id', p_order_id,
    'deleted_order_number', v_order_number
  );
end;
$$;

create or replace function public.delete_instagram_orders_atomic(
  p_order_ids uuid[],
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_deleted integer := 0;
begin
  if p_order_ids is null or cardinality(p_order_ids) = 0 then
    raise exception 'لم يتم تحديد طلبات للحذف';
  end if;

  for v_order_id in
    select distinct value from unnest(p_order_ids) as selected(value)
  loop
    perform public.delete_instagram_order_atomic(v_order_id, p_actor_user_id);
    v_deleted := v_deleted + 1;
  end loop;

  return jsonb_build_object('success', true, 'deleted_count', v_deleted);
end;
$$;

-- Replace the old archive fallback with a real safe hard delete.
drop function if exists public.delete_instagram_product_safe(uuid, uuid);

create function public.delete_instagram_product_safe(
  p_product_id uuid,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product_name text;
begin
  if not exists (
    select 1 from public.users
    where id = p_actor_user_id and role = 'admin'
  ) then
    raise exception 'غير مصرح بحذف صنف Instagram';
  end if;

  select name
  into v_product_name
  from public.instagram_products
  where id = p_product_id
  for update;

  if not found then
    raise exception 'الصنف غير موجود';
  end if;

  if exists (
    select 1
    from public.instagram_order_items item
    where item.product_id = p_product_id
       or item.variant_id in (
         select id from public.instagram_variants where product_id = p_product_id
       )
  ) or exists (
    select 1
    from public.instagram_inventory_movements movement
    where movement.order_id is not null
      and movement.variant_id in (
        select id from public.instagram_variants where product_id = p_product_id
      )
  ) then
    raise exception 'لا يمكن حذف الصنف لأنه مرتبط بطلبات محفوظة. أوقف الصنف بدلاً من حذفه';
  end if;

  delete from public.instagram_inventory_movements
  where variant_id in (
    select id from public.instagram_variants where product_id = p_product_id
  );
  delete from public.instagram_variants where product_id = p_product_id;
  delete from public.instagram_products where id = p_product_id;

  return jsonb_build_object(
    'success', true,
    'deleted_product_id', p_product_id,
    'deleted_product_name', v_product_name
  );
end;
$$;

revoke all on function public.delete_instagram_order_atomic(uuid, uuid) from public, anon, authenticated;
revoke all on function public.delete_instagram_orders_atomic(uuid[], uuid) from public, anon, authenticated;
revoke all on function public.delete_instagram_product_safe(uuid, uuid) from public, anon, authenticated;

grant execute on function public.delete_instagram_order_atomic(uuid, uuid) to service_role;
grant execute on function public.delete_instagram_orders_atomic(uuid[], uuid) to service_role;
grant execute on function public.delete_instagram_product_safe(uuid, uuid) to service_role;

commit;
