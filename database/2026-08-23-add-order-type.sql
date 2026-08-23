-- نفّذ هذا الملف مرة واحدة من Supabase SQL Editor قبل تشغيل النسخة الجديدة.
-- الطلبات القديمة تُعتبر "توصيل" تلقائياً.

begin;

alter table public.orders
  add column if not exists order_type text;

update public.orders
set order_type = 'توصيل'
where order_type is null
   or order_type not in ('توصيل', 'شحن', 'شحن لباب المنزل');

alter table public.orders
  alter column order_type set default 'توصيل',
  alter column order_type set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'orders_order_type_check'
      and conrelid = 'public.orders'::regclass
  ) then
    alter table public.orders
      add constraint orders_order_type_check
      check (order_type in ('توصيل', 'شحن', 'شحن لباب المنزل'));
  end if;
end
$$;

create index if not exists orders_company_order_type_idx
  on public.orders (company_id, order_type);

commit;
