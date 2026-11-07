-- Make the existing server-only boundary explicit without granting client access.
-- The service role continues to enforce owner authorization in the Edge API.
begin;
create index owner_access_used_refresh_session_id_idx
  on public.owner_access_used_refresh(session_id);

do $policies$
declare target_name text;
begin
  foreach target_name in array array[
    'owner_access_attempts','owner_access_challenges','owner_access_config',
    'owner_access_log','owner_access_recovery','owner_access_sessions',
    'owner_access_used_refresh','schedule_login_attempts','schedule_sessions',
    'schedule_settings','uf_accounts','uf_platform','uf_sessions','uf_versions'
  ] loop
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname=target_name and c.relrowsecurity
    ) then
      raise exception 'Expected RLS-protected table is missing: %',target_name;
    end if;
    execute format(
      'create policy client_access_denied on public.%I as restrictive for all to anon,authenticated using(false) with check(false)',
      target_name
    );
  end loop;
end
$policies$;
commit;
