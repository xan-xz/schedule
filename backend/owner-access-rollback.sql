-- STAGING / PRE-ACTIVATION ROLLBACK ONLY.
-- Take a private database snapshot and stop the new auth endpoint first.
-- This script refuses an activated owner. After activation, restore the reviewed
-- owner-access snapshot or fix forward; never silently restore password-only
-- administration, old tokens, old passwords or another administrator.
-- Timetable tables, native Auth users/factors and existing password hashes are
-- never deleted or restored. Minimal deny guards deliberately remain installed.
begin;
do $$
begin
  if exists(select 1 from public.owner_access_config where setup_complete) then
    raise exception 'Activated owner access requires a coordinated snapshot restore or fix forward';
  end if;
end; $$;

-- Keep native registration restricted even when the application tables disappear.
-- Forward migration CREATE OR REPLACE restores the additional pinned-UID check.
create or replace function uniflow_private.owner_auth_registration_guard()
returns trigger language plpgsql security definer set search_path='' as $$
declare actual_email text; actual_invited_at timestamptz; actual_phone text; actual_phone_change text;
begin
  select email,invited_at,phone,phone_change into actual_email,actual_invited_at,actual_phone,actual_phone_change from auth.users where id=new.id;
  if not found then return null; end if;
  if actual_email is null or lower(actual_email)<>'arappayevv@gmail.com' or actual_invited_at is null or coalesce(actual_phone,'')<>'' or coalesce(actual_phone_change,'')<>'' then
    raise exception 'owner-only registration';
  end if;
  return null;
end; $$;
revoke all on function uniflow_private.owner_auth_registration_guard() from public,anon,authenticated;
grant execute on function uniflow_private.owner_auth_registration_guard() to supabase_auth_admin,service_role;

drop function if exists public.owner_access_command(text,jsonb);
drop function if exists uniflow_private.owner_auth_session_valid(uuid,uuid,uuid);
drop function if exists uniflow_private.owner_auth_user();
drop table if exists public.owner_access_used_refresh;
drop table if exists public.owner_access_recovery;
drop table if exists public.owner_access_attempts;
drop table if exists public.owner_access_log;
drop table if exists public.owner_access_sessions;
drop table if exists public.owner_access_challenges;
drop table if exists public.owner_access_config;

-- Intentionally retained: uniflow_private schema, owner_auth_registration_guard
-- deferred trigger, owner_auth_email_immutable trigger and the legacy-account
-- owner_access_deny_extra_admin trigger/function. They do not depend on removed
-- owner tables and prevent the rollback from reopening registration/admin grants.
commit;
