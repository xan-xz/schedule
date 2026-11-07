-- Read-only assertions; no owner configuration or native Auth fixtures changed.
do $checks$
declare target_name text; count_checked integer:=0;
begin
  foreach target_name in array array[
    'owner_access_attempts','owner_access_challenges','owner_access_config',
    'owner_access_log','owner_access_recovery','owner_access_sessions',
    'owner_access_used_refresh','schedule_login_attempts','schedule_sessions',
    'schedule_settings','uf_accounts','uf_platform','uf_sessions','uf_versions'
  ] loop
    if not exists (
      select 1 from pg_policies where schemaname='public' and tablename=target_name
      and policyname='client_access_denied' and permissive='RESTRICTIVE'
      and roles @> array['anon','authenticated']::name[] and cmd='ALL'
      and qual='false' and with_check='false'
    ) then raise exception 'Client deny policy missing or changed: %',target_name; end if;
    if has_table_privilege('anon',format('public.%I',target_name),'SELECT,INSERT,UPDATE,DELETE')
      or has_table_privilege('authenticated',format('public.%I',target_name),'SELECT,INSERT,UPDATE,DELETE') then
      raise exception 'Unexpected client table grant: %',target_name;
    end if;
    count_checked:=count_checked+1;
  end loop;
  if count_checked<>14 then raise exception 'Incomplete table coverage'; end if;
  if not exists (
    select 1 from pg_indexes where schemaname='public'
    and tablename='owner_access_used_refresh'
    and indexname='owner_access_used_refresh_session_id_idx'
    and indexdef like '%(session_id)%'
  ) then raise exception 'Refresh session index missing'; end if;
end
$checks$;
select jsonb_build_object('closedTables',14,'foreignKeyIndex',true,'ownerStateModified',false) as client_denial_checks;
