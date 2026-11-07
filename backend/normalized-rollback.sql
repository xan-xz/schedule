-- Shadow-store rollback only. Never restores the historical password-only API.
begin;
do $guard$
begin
  if exists(select 1 from uniflow_data.documents where is_live)
    or exists(select 1 from uniflow_data.revisions)
    or exists(select 1 from uniflow_data.support_tickets)
    or exists(select 1 from uniflow_data.site_settings) then
    raise exception 'normalized_rollback_refuses_operational_data';
  end if;
end
$guard$;
drop function public.uf_normalized_import(jsonb);
drop function public.uf_normalized_export();
drop schema uniflow_data cascade;
commit;
