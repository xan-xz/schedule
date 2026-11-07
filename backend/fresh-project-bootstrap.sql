-- A one-time baseline for an EMPTY Supabase project, not a numbered migration.
-- Follow with the unchanged files in supabase/migrations in filename order.
-- Never use this file on the existing production project or register a fake
-- baseline version in supabase_migrations.schema_migrations.
begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('uniflow-fresh-project-bootstrap'));

-- All checks precede every persistent CREATE/ALTER/GRANT statement. Existing
-- application objects are rejected even if they contain no rows.
do $fresh_project_guard$
declare required_role text; required_column record; has_history boolean;
begin
  if exists(select 1 from pg_catalog.pg_namespace where left(nspname,8)='uniflow_')
    or exists(
      select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and (
        left(c.relname,3)='uf_' or left(c.relname,9)='schedule_'
        or left(c.relname,6)='owner_' or c.relname='group_schedule'
      )
    ) or exists(
      select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and (
        left(p.proname,3)='uf_' or left(p.proname,9)='schedule_'
        or left(p.proname,6)='owner_' or p.proname='validate_shared_schedule'
      )
    ) or exists(
      select 1 from pg_catalog.pg_type t join pg_catalog.pg_namespace n on n.oid=t.typnamespace
      where n.nspname='public' and (
        left(t.typname,3)='uf_' or left(t.typname,9)='schedule_' or left(t.typname,6)='owner_'
      )
    ) then raise exception 'fresh_project_existing_application_objects'; end if;

  -- A different application's public data also makes this a used project.
  -- Managed extension relations are allowed; their membership is catalogued
  -- by Postgres itself. Ordinary indexes are covered by their owning table.
  if exists(
    select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p','v','m','S','f')
      and not exists(
        select 1 from pg_catalog.pg_depend d join pg_catalog.pg_extension e on e.oid=d.refobjid
        where d.classid='pg_catalog.pg_class'::regclass and d.objid=c.oid
          and d.refclassid='pg_catalog.pg_extension'::regclass and d.deptype='e'
      )
  ) then raise exception 'fresh_project_existing_public_relations'; end if;

  if pg_catalog.to_regclass('supabase_migrations.schema_migrations') is not null then
    execute 'select exists(select 1 from supabase_migrations.schema_migrations)' into has_history;
    if has_history then raise exception 'fresh_project_existing_migration_history'; end if;
  end if;
  foreach required_role in array array['anon','authenticated','service_role','supabase_auth_admin'] loop
    if not exists(select 1 from pg_catalog.pg_roles where rolname=required_role) then
      raise exception 'fresh_project_missing_managed_role: %',required_role;
    end if;
  end loop;
  if not exists(select 1 from pg_catalog.pg_roles where rolname='service_role' and rolbypassrls) then
    raise exception 'fresh_project_service_role_requires_bypassrls';
  end if;
  for required_column in select * from (values
    ('users','id'),('users','email'),('users','email_confirmed_at'),
    ('users','deleted_at'),('users','phone'),('users','phone_change'),
    ('users','is_anonymous'),('users','banned_until'),('users','invited_at'),
    ('sessions','id'),('sessions','user_id'),('sessions','not_after'),
    ('sessions','factor_id'),('sessions','aal'),
    ('mfa_factors','id'),('mfa_factors','user_id'),
    ('mfa_factors','factor_type'),('mfa_factors','status')
  ) as needed(table_name,column_name) loop
    if not exists(
      select 1 from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid=a.attrelid
      join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname='auth' and c.relname=required_column.table_name
        and c.relkind in ('r','p') and a.attname=required_column.column_name
        and a.attnum>0 and not a.attisdropped
    ) then raise exception 'fresh_project_missing_managed_auth_column: %.%',required_column.table_name,required_column.column_name; end if;
  end loop;
  -- Do not attach global Auth guards to a project already serving real users.
  if exists(select 1 from auth.users) then
    raise exception 'fresh_project_existing_auth_users';
  end if;
end
$fresh_project_guard$;

create table public.schedule_settings (
  id integer primary key check(id=1), salt text not null, password_hash text not null
);
create table public.schedule_sessions (
  token_hash text primary key, expires_at timestamptz not null
);
create table public.schedule_login_attempts (
  id bigint generated always as identity primary key,
  ip_hash text not null, created_at timestamptz not null default now()
);
create index schedule_attempts_ip_time on public.schedule_login_attempts(ip_hash,created_at);
create index schedule_attempts_time on public.schedule_login_attempts(created_at);
create index schedule_sessions_expiry on public.schedule_sessions(expires_at);

create table public.uf_platform (
  id integer primary key check(id=1),
  data jsonb not null check(jsonb_typeof(data)='object'),
  revision integer not null default 1 check(revision>0),
  updated_at timestamptz not null default now()
);
create table public.uf_signal (
  id integer primary key check(id=1), revision integer not null default 1 check(revision>0),
  updated_at timestamptz not null default now()
);
create table public.uf_accounts (
  id uuid primary key default gen_random_uuid(), username text not null unique,
  name text not null, role text not null check(role in('student','teacher','admin')),
  group_id text not null default '', subgroup text not null default '',
  teacher_id text not null default '', active boolean not null default true,
  salt text not null, password_hash text not null, created_at timestamptz not null default now()
);
create table public.uf_sessions (
  token_hash text primary key, user_id text not null, expires_at timestamptz not null
);
create index uf_sessions_expires on public.uf_sessions(expires_at);
create table public.uf_versions (
  revision integer primary key, data jsonb not null, actor text not null,
  reason text not null, created_at timestamptz not null default now()
);

do $table_security$
declare target_name text;
begin
  foreach target_name in array array[
    'schedule_settings','schedule_sessions','schedule_login_attempts',
    'uf_platform','uf_signal','uf_accounts','uf_sessions','uf_versions'
  ] loop
    execute format('alter table public.%I enable row level security',target_name);
    execute format('revoke all on public.%I from public,anon,authenticated',target_name);
    execute format('grant all on public.%I to service_role',target_name);
  end loop;
end
$table_security$;
grant usage on schema public to service_role;
grant usage,select on sequence public.schedule_login_attempts_id_seq to service_role;
grant select on public.uf_signal to anon,authenticated;
create policy uf_signal_read on public.uf_signal for select to anon,authenticated using(true);

-- An empty, valid document permits the owner to import reviewed real data.
-- No group, timetable, user, password, verifier, session or sample is seeded.
insert into public.uf_platform(id,data) values(1,jsonb_build_object(
  'groups','[]'::jsonb,'teachers','[]'::jsonb,'subjects','[]'::jsonb,'rooms','[]'::jsonb,
  'lessons','[]'::jsonb,'exceptions','[]'::jsonb,'tasks','[]'::jsonb,
  'announcements','[]'::jsonb,'requests','[]'::jsonb,'attendance','[]'::jsonb,'history','[]'::jsonb
));
insert into public.uf_signal(id) values(1);

create function public.uf_commit(p_expected integer,p_data jsonb,p_actor text,p_reason text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare current_row public.uf_platform; next_revision integer;
begin
  if jsonb_typeof(p_data) is distinct from 'object' or octet_length(p_data::text)>2000000
    or p_actor is null or length(p_actor) not between 1 and 160
    or p_reason is null or length(p_reason) not between 1 and 1000 then
    raise exception 'invalid_payload';
  end if;
  select * into current_row from public.uf_platform where id=1 for update;
  if not found then raise exception 'platform_not_initialized'; end if;
  if current_row.revision is distinct from p_expected then raise exception 'version_conflict'; end if;
  insert into public.uf_versions(revision,data,actor,reason)
    values(current_row.revision,current_row.data,p_actor,p_reason);
  next_revision:=current_row.revision+1;
  update public.uf_platform set data=p_data,revision=next_revision,updated_at=now() where id=1;
  update public.uf_signal set revision=next_revision,updated_at=now() where id=1;
  delete from public.uf_versions where revision<next_revision-30;
  return jsonb_build_object('data',p_data,'revision',next_revision);
end;
$$;
revoke all on function public.uf_commit(integer,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.uf_commit(integer,jsonb,text,text) to service_role;
commit;
