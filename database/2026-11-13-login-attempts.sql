-- Apply before deploying the updated login route.
begin;

create table if not exists public.wolforder_login_attempts (
  user_id uuid primary key references public.users(id) on delete cascade,
  failed_attempts smallint not null default 0 check (failed_attempts between 0 and 3),
  locked_until timestamptz
);

alter table public.wolforder_login_attempts enable row level security;
revoke all on table public.wolforder_login_attempts from public, anon, authenticated;
grant select, insert, update, delete on table public.wolforder_login_attempts to service_role;

create or replace function public.record_wolforder_login_attempt(
  p_user_id uuid,
  p_expected_password_hash text,
  p_success boolean
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_password text;
  v_role text;
  v_failed smallint;
  v_locked_until timestamptz;
  v_now timestamptz;
begin
  -- The account row also serializes login against an administrator password reset.
  select password, role into v_password, v_role
  from public.users
  where id = p_user_id
  for no key update;

  if not found or v_role not in ('admin', 'company', 'driver', 'instagram_viewer') then
    raise exception 'Account is unavailable' using errcode = '42501';
  end if;
  if v_password is distinct from p_expected_password_hash then
    return jsonb_build_object('allowed', false, 'credentials_changed', true);
  end if;

  insert into public.wolforder_login_attempts (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  select failed_attempts, locked_until into v_failed, v_locked_until
  from public.wolforder_login_attempts
  where user_id = p_user_id
  for update;
  v_now := clock_timestamp();

  -- Requests during a lock never extend the original five-minute deadline.
  if v_locked_until > v_now then
    return jsonb_build_object(
      'allowed', false,
      'locked_until', v_locked_until,
      'retry_after_seconds', greatest(1, ceil(extract(epoch from v_locked_until - v_now))::integer)
    );
  end if;
  if v_locked_until is not null then
    v_failed := 0;
    v_locked_until := null;
  end if;

  if p_success then
    update public.wolforder_login_attempts
    set failed_attempts = 0, locked_until = null
    where user_id = p_user_id;
    return jsonb_build_object('allowed', true, 'role', v_role);
  end if;

  v_failed := least(3, v_failed + 1);
  if v_failed = 3 then
    v_locked_until := v_now + interval '5 minutes';
  end if;
  update public.wolforder_login_attempts
  set failed_attempts = v_failed, locked_until = v_locked_until
  where user_id = p_user_id;
  return jsonb_build_object(
    'allowed', false,
    'locked_until', v_locked_until,
    'retry_after_seconds', case when v_locked_until is null then 0 else 300 end
  );
end;
$$;

revoke all on function public.record_wolforder_login_attempt(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.record_wolforder_login_attempt(uuid, text, boolean) to service_role;

notify pgrst, 'reload schema';
commit;
