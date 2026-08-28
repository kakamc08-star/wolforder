-- WolfOrder: توحيد وظائف لوحة إنستغرام + الحذف الآمن
-- نفّذ هذا الملف بعد 2026-08-27-instagram-orders-and-performance.sql.

begin;

alter table public.instagram_products
  add column if not exists deleted_at timestamptz;

alter table public.instagram_inventory
  add column if not exists deleted_at timestamptz;

create or replace function public.archive_instagram_product(
  p_product_id uuid,
  p_actor_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  product_row public.instagram_products%rowtype;
begin
  update public.instagram_products
  set is_active = false, deleted_at = now(), updated_at = now()
  where id = p_product_id and deleted_at is null
  returning * into product_row;

  if not found then
    raise exception 'INVALID_PRODUCT' using errcode = 'P0001';
  end if;

  update public.instagram_inventory
  set is_active = false, deleted_at = coalesce(deleted_at, now()), updated_at = now()
  where product_id = p_product_id;

  return jsonb_build_object('id', product_row.id, 'archived', true, 'actor_id', p_actor_id);
end;
$$;

create or replace function public.archive_instagram_inventory(
  p_inventory_id uuid,
  p_actor_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  inventory_row public.instagram_inventory%rowtype;
begin
  select * into inventory_row
  from public.instagram_inventory
  where id = p_inventory_id and deleted_at is null
  for update;

  if not found then
    raise exception 'INVALID_INVENTORY' using errcode = 'P0001';
  end if;
  if inventory_row.reserved_quantity > 0 then
    raise exception 'INVENTORY_HAS_RESERVED_ORDERS' using errcode = 'P0001';
  end if;

  update public.instagram_inventory
  set is_active = false, deleted_at = now(), updated_at = now()
  where id = p_inventory_id
  returning * into inventory_row;

  insert into public.instagram_inventory_movements (
    inventory_id, movement_type, reason, actor_id
  ) values (
    p_inventory_id, 'archive', 'حذف تركيبة المخزون من لوحة المدير', p_actor_id
  );

  return jsonb_build_object('id', inventory_row.id, 'archived', true);
end;
$$;

create or replace function public.delete_instagram_order(
  p_order_id uuid,
  p_actor_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  order_row public.instagram_orders%rowtype;
  item_row record;
  batch_id uuid;
  remaining_order_count integer;
  remaining_piece_count integer;
begin
  select * into order_row
  from public.instagram_orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'INVALID_ORDER' using errcode = 'P0001';
  end if;

  batch_id := order_row.shipping_batch_id;

  for item_row in
    select inventory_id, quantity
    from public.instagram_order_items
    where order_id = p_order_id
    order by inventory_id
  loop
    perform 1 from public.instagram_inventory where id = item_row.inventory_id for update;

    if order_row.status in ('قيد المتابعة', 'مؤجل') then
      update public.instagram_inventory
      set available_quantity = available_quantity + item_row.quantity,
          reserved_quantity = reserved_quantity - item_row.quantity,
          updated_at = now()
      where id = item_row.inventory_id
        and reserved_quantity >= item_row.quantity;
    elsif order_row.status = 'تم' then
      update public.instagram_inventory
      set available_quantity = available_quantity + item_row.quantity,
          sold_quantity = sold_quantity - item_row.quantity,
          updated_at = now()
      where id = item_row.inventory_id
        and sold_quantity >= item_row.quantity;
    end if;

    if order_row.status in ('قيد المتابعة', 'مؤجل', 'تم') and not found then
      raise exception 'INVENTORY_STATE_CONFLICT' using errcode = 'P0001';
    end if;
  end loop;

  delete from public.instagram_order_status_history where order_id = p_order_id;
  delete from public.instagram_inventory_movements where order_id = p_order_id;
  delete from public.instagram_order_items where order_id = p_order_id;
  delete from public.instagram_orders where id = p_order_id;

  if batch_id is not null then
    select count(*), coalesce(sum(item_totals.pieces), 0)::integer
    into remaining_order_count, remaining_piece_count
    from public.instagram_orders orders
    join lateral (
      select coalesce(sum(quantity), 0)::integer as pieces
      from public.instagram_order_items
      where order_id = orders.id
    ) item_totals on true
    where orders.shipping_batch_id = batch_id;

    if remaining_order_count = 0 then
      delete from public.instagram_shipping_batches where id = batch_id;
    else
      update public.instagram_shipping_batches
      set order_count = remaining_order_count,
          piece_count = remaining_piece_count
      where id = batch_id;
    end if;
  end if;

  return jsonb_build_object(
    'id', order_row.id,
    'order_number', order_row.order_number,
    'deleted', true,
    'actor_id', p_actor_id
  );
end;
$$;

create or replace view public.instagram_inventory_stats
with (security_invoker = true)
as
select
  i.id as inventory_id,
  p.id as product_id,
  p.company_id,
  coalesce(company.name, '') as company_name,
  p.name as product_name,
  p.is_active as product_active,
  i.is_active as inventory_active,
  i.color,
  i.size,
  i.initial_quantity,
  coalesce(sum(oi.quantity) filter (where o.status = 'تم'), 0)::bigint as sold_quantity,
  coalesce(sum(oi.quantity) filter (where o.status = 'قيد المتابعة'), 0)::bigint as reserved_quantity,
  coalesce(sum(oi.quantity) filter (where o.status = 'مؤجل'), 0)::bigint as postponed_quantity,
  coalesce(sum(oi.quantity) filter (where o.status = 'ملغي'), 0)::bigint as cancelled_quantity,
  coalesce(sum(oi.quantity) filter (where o.status = 'مرتجع'), 0)::bigint as returned_quantity,
  i.available_quantity as remaining_quantity
from public.instagram_inventory i
join public.instagram_products p on p.id = i.product_id
left join public.users company on company.id::text = p.company_id and company.role = 'company'
left join public.instagram_order_items oi on oi.inventory_id = i.id
left join public.instagram_orders o on o.id = oi.order_id
where p.deleted_at is null and i.deleted_at is null
group by i.id, p.id, p.company_id, company.name, p.name, p.is_active, i.is_active,
         i.color, i.size, i.initial_quantity, i.available_quantity;

revoke execute on function public.archive_instagram_product(uuid, text) from public, anon, authenticated;
revoke execute on function public.archive_instagram_inventory(uuid, text) from public, anon, authenticated;
revoke execute on function public.delete_instagram_order(uuid, text) from public, anon, authenticated;
grant execute on function public.archive_instagram_product(uuid, text) to service_role;
grant execute on function public.archive_instagram_inventory(uuid, text) to service_role;
grant execute on function public.delete_instagram_order(uuid, text) to service_role;

commit;
