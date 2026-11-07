-- Undo only this additive policy/index release. Existing RLS and revoked grants
-- remain in force. No timetable, owner identity, password or session is modified.
begin;
do $policies$
declare target_name text;
begin
  foreach target_name in array array[
    'owner_access_attempts','owner_access_challenges','owner_access_config',
    'owner_access_log','owner_access_recovery','owner_access_sessions',
    'owner_access_used_refresh','schedule_login_attempts','schedule_sessions',
    'schedule_settings','uf_accounts','uf_platform','uf_sessions','uf_versions'
  ] loop
    execute format('drop policy client_access_denied on public.%I',target_name);
  end loop;
end
$policies$;
drop index public.owner_access_used_refresh_session_id_idx;
commit;
