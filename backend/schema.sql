create table public.group_schedule (
id text primary key check(id='06-057-25-11'), data jsonb not null,
revision integer not null default 1, updated_at timestamptz not null default now());
alter table public.group_schedule enable row level security;
revoke all on public.group_schedule from anon, authenticated;
grant select on public.group_schedule to anon, authenticated;
grant all on public.group_schedule to service_role;
create policy schedule_read on public.group_schedule for select to anon, authenticated using(true);
create table public.schedule_settings(id integer primary key check(id=1), salt text not null, password_hash text not null);
create table public.schedule_sessions(token_hash text primary key, expires_at timestamptz not null);
create table public.schedule_login_attempts(id bigint generated always as identity primary key, ip_hash text not null, created_at timestamptz not null default now());
create index schedule_attempts_ip_time on public.schedule_login_attempts(ip_hash,created_at);
create index schedule_attempts_time on public.schedule_login_attempts(created_at);
create index schedule_sessions_expiry on public.schedule_sessions(expires_at);
alter table public.schedule_settings enable row level security;
alter table public.schedule_sessions enable row level security;
alter table public.schedule_login_attempts enable row level security;
revoke all on public.schedule_settings, public.schedule_sessions, public.schedule_login_attempts from anon, authenticated;
grant all on public.schedule_settings, public.schedule_sessions, public.schedule_login_attempts to service_role;
grant usage, select on sequence public.schedule_login_attempts_id_seq to service_role;
create function public.validate_shared_schedule() returns trigger language plpgsql set search_path='' as $$
declare d integer; g text; l jsonb; prev_end text;
begin
 if jsonb_typeof(new.data) is distinct from 'object' or (select count(*) from jsonb_object_keys(new.data))<>7 then raise exception 'Invalid schedule'; end if;
 for d in 0..6 loop
  foreach g in array array['А','Б'] loop
   if jsonb_typeof(new.data->d::text->g) is distinct from 'array' or jsonb_array_length(new.data->d::text->g)>24 then raise exception 'Invalid day'; end if;
   prev_end:='00:00';
   for l in select value from jsonb_array_elements(new.data->d::text->g) loop
    if jsonb_typeof(l->'subject') is distinct from 'string' or length(l->>'subject') not between 1 and 100 or jsonb_typeof(l->'room') is distinct from 'string' or length(l->>'room')>40 or coalesce(l->>'start','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(l->>'end','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or (l->>'start')>=(l->>'end') or (l->>'start')<prev_end then raise exception 'Invalid lesson'; end if;
    prev_end:=l->>'end';
   end loop;
  end loop;
 end loop;
 if TG_OP='UPDATE' then new.revision:=old.revision+1;new.updated_at:=now();end if;
 return new;
end;$$;
revoke all on function public.validate_shared_schedule() from public, anon, authenticated;
create trigger validate_shared_schedule before insert or update on public.group_schedule for each row execute function public.validate_shared_schedule();
alter publication supabase_realtime add table public.group_schedule;
