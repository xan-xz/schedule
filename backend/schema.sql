-- Apply after connecting the selected Supabase project.
-- Seed the schedule and assign an existing Auth user as admin separately.
create table public.group_schedule (
  id text primary key check (id = '06-057-25-11'),
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  revision bigint not null default 1,
  updated_at timestamptz not null default now()
);

create table public.schedule_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

alter table public.group_schedule enable row level security;
alter table public.schedule_admins enable row level security;
revoke all on public.group_schedule from anon, authenticated;
revoke all on public.schedule_admins from anon, authenticated;
grant select on public.group_schedule to anon, authenticated;
grant update (data) on public.group_schedule to authenticated;
grant select on public.schedule_admins to authenticated;

create policy "Public schedule read" on public.group_schedule
  for select to anon, authenticated using (true);
create policy "Admin can read own role" on public.schedule_admins
  for select to authenticated using (user_id = (select auth.uid()));
create policy "Only assigned admin may update" on public.group_schedule
  for update to authenticated
  using (exists (select 1 from public.schedule_admins where user_id = (select auth.uid())))
  with check (exists (select 1 from public.schedule_admins where user_id = (select auth.uid())));

create function public.bump_schedule_revision() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.revision := old.revision + 1;
  new.updated_at := now();
  return new;
end;
$$;
create trigger schedule_revision before update on public.group_schedule
  for each row execute function public.bump_schedule_revision();

alter publication supabase_realtime add table public.group_schedule;