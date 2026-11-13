-- WolfOrder / Store images for public Instagram order links.
-- Create the private instagram-storefront-images bucket in Supabase Storage.
-- Limit it to 2 MiB and image/jpeg, image/png, image/webp.
-- Run this migration on the schema with instagram_company_links.slug (text)
-- and public.users.id / instagram_company_links.company_id (uuid).
--
-- Read-only preflight (run these lines separately after removing "--"):
-- select table_name, column_name, data_type
-- from information_schema.columns
-- where table_schema = 'public'
--   and ((table_name = 'users' and column_name = 'id')
--     or (table_name = 'instagram_company_links' and column_name in ('company_id', 'slug', 'is_active')));

begin;

create table if not exists public.instagram_storefront_images (
  company_id uuid primary key references public.users(id) on delete cascade,
  object_path text not null check (
    object_path ~ ('^' || company_id::text || '/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}[.](jpg|png|webp)$')
  )
);

alter table public.instagram_storefront_images enable row level security;
revoke all on table public.instagram_storefront_images from public, anon, authenticated;
grant select, insert, update, delete on table public.instagram_storefront_images to service_role;

drop policy if exists instagram_storefront_images_server_only on storage.objects;
create policy instagram_storefront_images_server_only
  on storage.objects as restrictive for all to anon, authenticated
  using (bucket_id <> 'instagram-storefront-images')
  with check (bucket_id <> 'instagram-storefront-images');

create or replace function public.get_instagram_storefront_image_path(p_slug text)
returns text
language sql
stable
set search_path = ''
as $$
  select image.object_path
  from public.instagram_company_links link
  join public.users company on company.id = link.company_id and company.role = 'company'
  join public.instagram_storefront_images image on image.company_id = link.company_id
  where link.slug = btrim(p_slug)
    and link.is_active = true;
$$;

create or replace function public.set_instagram_storefront_image_path(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_object_path text
)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_previous_path text;
begin
  if not exists (
    select 1 from public.users where id = p_actor_user_id and role = 'admin'
  ) then
    raise exception 'Only admins may change a store image' using errcode = '42501';
  end if;

  -- Serialize changes even when this company does not yet have an image or a link.
  perform 1 from public.users where id = p_company_id and role = 'company' for no key update;
  if not found then
    raise exception 'Store not found' using errcode = 'P0002';
  end if;

  select object_path into v_previous_path
  from public.instagram_storefront_images
  where company_id = p_company_id;

  if v_previous_path is not distinct from p_object_path then
    return null;
  end if;

  if p_object_path is null then
    delete from public.instagram_storefront_images where company_id = p_company_id;
  else
    insert into public.instagram_storefront_images (company_id, object_path)
    values (p_company_id, p_object_path)
    on conflict (company_id) do update set object_path = excluded.object_path;
  end if;

  return v_previous_path;
end;
$$;

revoke all on function public.get_instagram_storefront_image_path(text) from public, anon, authenticated;
revoke all on function public.set_instagram_storefront_image_path(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.get_instagram_storefront_image_path(text) to service_role;
grant execute on function public.set_instagram_storefront_image_path(uuid, uuid, text) to service_role;

commit;
