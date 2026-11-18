-- WolfOrder: optional product/color/size images. Run the whole file in Supabase SQL Editor.
-- Adds new image metadata/functions only; does not replace any order/inventory RPC.
begin;

create table if not exists public.instagram_variant_images (
  variant_id uuid primary key references public.instagram_variants(id) on delete cascade,
  object_path text not null unique check (
    object_path ~ ('^' || variant_id::text || '/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}[.]webp$')
  )
);

-- A durable outbox: retired files and uploads interrupted before linking survive server restarts.
-- No FK here: cleanup must also work after a product/variant has been deleted.
create table if not exists public.instagram_variant_image_cleanup (
  object_path text primary key check (
    object_path ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}[.]webp$'
  ),
  available_at timestamptz not null default now()
);
create index if not exists instagram_variant_image_cleanup_available
  on public.instagram_variant_image_cleanup(available_at);

alter table public.instagram_variant_images enable row level security;
alter table public.instagram_variant_image_cleanup enable row level security;
revoke all on public.instagram_variant_images, public.instagram_variant_image_cleanup from public, anon, authenticated;
grant select, insert, update, delete on public.instagram_variant_images, public.instagram_variant_image_cleanup to service_role;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('instagram-variant-images', 'instagram-variant-images', false, 3145728, array['image/webp'])
on conflict(id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Restrictive so even a pre-existing permissive policy cannot expose this bucket.
drop policy if exists instagram_variant_images_server_only on storage.objects;
create policy instagram_variant_images_server_only on storage.objects
  as restrictive for all to anon, authenticated
  using (bucket_id <> 'instagram-variant-images')
  with check (bucket_id <> 'instagram-variant-images');

create or replace function public.queue_instagram_variant_image_cleanup()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' or old.object_path is distinct from new.object_path then
    insert into public.instagram_variant_image_cleanup(object_path, available_at)
    values(old.object_path, now())
    on conflict(object_path) do update set available_at = excluded.available_at;
  end if;
  return null;
end;
$$;
drop trigger if exists instagram_variant_image_retired on public.instagram_variant_images;
create trigger instagram_variant_image_retired after update or delete on public.instagram_variant_images
  for each row execute function public.queue_instagram_variant_image_cleanup();

create or replace function public.prepare_instagram_variant_image_upload(
  p_variant_id uuid, p_actor_user_id uuid, p_object_path text
)
returns void language plpgsql set search_path = '' as $$
begin
  if not exists(select 1 from public.users where id = p_actor_user_id and role = 'admin') then
    raise exception 'Only admins may change a variant image' using errcode = '42501';
  end if;
  perform 1 from public.instagram_variants where id = p_variant_id for no key update;
  if not found then raise exception 'Variant not found' using errcode = 'P0002'; end if;
  if p_object_path is null or p_object_path !~ (
    '^' || p_variant_id::text || '/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}[.]webp$'
  ) then raise exception 'Invalid image path' using errcode = '23514'; end if;
  -- Paths are unique and may never be reused or resurrected after cleanup begins.
  if exists(select 1 from public.instagram_variant_images where object_path = p_object_path) then
    raise exception 'Image path already used' using errcode = '23514';
  end if;
  insert into public.instagram_variant_image_cleanup(object_path, available_at)
  values(p_object_path, now() + interval '1 hour');
end;
$$;

create or replace function public.set_instagram_variant_image_path(
  p_variant_id uuid, p_actor_user_id uuid, p_object_path text
)
returns void language plpgsql set search_path = '' as $$
begin
  if not exists(select 1 from public.users where id = p_actor_user_id and role = 'admin') then
    raise exception 'Only admins may change a variant image' using errcode = '42501';
  end if;
  -- Serializes upload/replacement/deletion, including variants without an existing image.
  perform 1 from public.instagram_variants where id = p_variant_id for no key update;
  if not found then raise exception 'Variant not found' using errcode = 'P0002'; end if;
  if p_object_path is null then
    delete from public.instagram_variant_images where variant_id = p_variant_id;
  else
    -- Expired candidates cannot race a cleanup worker and become live again.
    perform 1 from public.instagram_variant_image_cleanup
      where object_path = p_object_path and available_at > now() for update;
    if not found then raise exception 'Upload expired or was not prepared' using errcode = '23514'; end if;
    insert into public.instagram_variant_images(variant_id, object_path)
    values(p_variant_id, p_object_path)
    on conflict(variant_id) do update set object_path = excluded.object_path;
    delete from public.instagram_variant_image_cleanup where object_path = p_object_path;
  end if;
end;
$$;

create or replace function public.get_instagram_variant_image_path(p_slug text, p_variant_id uuid)
returns text language sql stable set search_path = '' as $$
  select image.object_path
  from public.instagram_company_links link
  join public.users company on company.id = link.company_id and company.role = 'company'
  join public.instagram_products product on product.company_id = link.company_id and product.status = 'active'
  join public.instagram_variants variant on variant.product_id = product.id
    and variant.is_active = true and variant.stock_available > 0
  join public.instagram_variant_images image on image.variant_id = variant.id
  where link.slug = btrim(p_slug) and link.is_active = true and variant.id = p_variant_id;
$$;

create or replace function public.get_instagram_variant_image_cleanup_batch()
returns table(object_path text) language sql set search_path = '' as $$
  select cleanup.object_path from public.instagram_variant_image_cleanup cleanup
  where cleanup.available_at <= now()
    and not exists(select 1 from public.instagram_variant_images image where image.object_path = cleanup.object_path)
  order by cleanup.available_at, cleanup.object_path limit 50;
$$;

create or replace function public.complete_instagram_variant_image_cleanup(p_paths text[])
returns void language sql set search_path = '' as $$
  delete from public.instagram_variant_image_cleanup cleanup
  where cleanup.object_path = any(p_paths) and cleanup.available_at <= now()
    and not exists(select 1 from public.instagram_variant_images image where image.object_path = cleanup.object_path);
$$;

revoke all on function public.queue_instagram_variant_image_cleanup() from public, anon, authenticated;
revoke all on function public.prepare_instagram_variant_image_upload(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.set_instagram_variant_image_path(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.get_instagram_variant_image_path(text, uuid) from public, anon, authenticated;
revoke all on function public.get_instagram_variant_image_cleanup_batch() from public, anon, authenticated;
revoke all on function public.complete_instagram_variant_image_cleanup(text[]) from public, anon, authenticated;
grant execute on function public.prepare_instagram_variant_image_upload(uuid, uuid, text) to service_role;
grant execute on function public.set_instagram_variant_image_path(uuid, uuid, text) to service_role;
grant execute on function public.get_instagram_variant_image_path(text, uuid) to service_role;
grant execute on function public.get_instagram_variant_image_cleanup_batch() to service_role;
grant execute on function public.complete_instagram_variant_image_cleanup(text[]) to service_role;

notify pgrst, 'reload schema';
commit;
