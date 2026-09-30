create role anon;
create role authenticated;
create role service_role bypassrls;
create table public.users (id uuid primary key, role text not null, name text, username text);
create table public.orders (id uuid primary key, status text, payload jsonb);
create table public.instagram_products (id uuid primary key default gen_random_uuid(), company_id uuid references users(id), name text,
  unit_price numeric, currency text default 'ل.س', status text default 'active', created_at timestamptz default now(), updated_at timestamptz default now());
create table public.instagram_variants (id uuid primary key default gen_random_uuid(), product_id uuid references instagram_products(id),
  color text, size text, stock_total integer not null check(stock_total>=0), stock_available integer not null check(stock_available>=0 and stock_available<=stock_total),
  is_active boolean default true, created_at timestamptz default now(), updated_at timestamptz default now());
create table public.instagram_viewer_companies (viewer_user_id uuid primary key references users(id), company_id uuid references users(id));
create table public.instagram_company_links (id uuid primary key default gen_random_uuid(), company_id uuid references users(id), slug text unique,
  next_order_number bigint default 1, is_active boolean default true, updated_at timestamptz default now());
create table public.instagram_orders (id uuid primary key default gen_random_uuid(), order_number bigint not null, company_id uuid references users(id), company_name text,
  customer_name text, customer_number text, address text, order_type text, order_source text, total_price numeric, currency text, ratio numeric default 0,
  status text default 'قيد المتابعة', note text, driver_id uuid references users(id), driver_name text, shipping_approval_status text,
  shipping_approved_at timestamptz, shipping_approved_by uuid references users(id), shipping_fee numeric default 0, items_total numeric default 0,
  shipping_delivery_status text default 'pending', shipping_delivered_at timestamptz, shipping_delivered_by uuid references users(id),
  shipping_delivered_to_name text, idempotency_key uuid unique, is_archived boolean default false, created_at timestamptz default now(), updated_at timestamptz default now(),
  unique(company_id, order_number));
create table public.instagram_order_items (id uuid primary key default gen_random_uuid(), order_id uuid references instagram_orders(id) on delete cascade,
  product_id uuid references instagram_products(id), variant_id uuid references instagram_variants(id), product_name text, color text, size text,
  unit_price numeric, quantity integer check(quantity>0), line_total numeric generated always as (unit_price*quantity) stored, created_at timestamptz default now());
create table public.instagram_inventory_movements (id uuid primary key default gen_random_uuid(), variant_id uuid references instagram_variants(id),
  order_id uuid references instagram_orders(id) on delete cascade, order_item_id uuid references instagram_order_items(id) on delete set null,
  movement_type text, quantity integer, stock_total_delta integer default 0, stock_available_delta integer default 0,
  product_name text, color text, size text, status_from text, status_to text, created_by_user_id uuid references users(id), event_key text unique, note text, created_at timestamptz default now());
create view public.instagram_inventory_summary as
select p.company_id, p.id as product_id, u.name as company_name, p.name as product_name, v.color,v.size,
  v.stock_total as quantity_total,
  coalesce(sum(i.quantity) filter(where coalesce(o.order_type,'توصيل')='توصيل' and o.status='قيد المتابعة'),0) as reserved_delivery,
  coalesce(sum(i.quantity) filter(where o.order_type='شحن' and o.status='قيد المتابعة'),0) as reserved_shipping,
  coalesce(sum(i.quantity) filter(where o.status='تم'),0) as sold,
  coalesce(sum(i.quantity) filter(where o.status='مؤجل'),0) as postponed,
  coalesce(sum(i.quantity) filter(where o.status='مرتجع'),0) as returned,
  coalesce(sum(i.quantity) filter(where o.status='إلغاء'),0) as cancelled,
  v.stock_available as remaining
from public.instagram_variants v join public.instagram_products p on p.id=v.product_id join public.users u on u.id=p.company_id
left join public.instagram_order_items i on i.variant_id=v.id left join public.instagram_orders o on o.id=i.order_id
 group by p.company_id,p.id,u.name,p.name,v.id;
