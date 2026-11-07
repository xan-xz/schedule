-- Owner access is additive. No timetable, password or existing session is changed
-- by applying this migration. Legacy sessions are revoked only at owner activation.
begin;
create schema if not exists uniflow_private;
revoke all on schema uniflow_private from public,anon,authenticated;
-- The managed Auth role only needs to resolve its two trigger callbacks. It is
-- not granted access to application tables or the service-only Auth helpers.
grant usage on schema uniflow_private to service_role,supabase_auth_admin;

create table public.owner_access_config (
  id smallint primary key check(id=1),
  owner_email text not null default 'arappayevv@gmail.com' check(owner_email='arappayevv@gmail.com'),
  owner_uid uuid,
  factor_id uuid,
  setup_complete boolean not null default false,
  bootstrap_deadline timestamptz,
  mail_cooldown_until timestamptz,
  mail_lease uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(not setup_complete or (owner_uid is not null and factor_id is not null))
);
insert into public.owner_access_config(id) values(1);
create table public.owner_access_challenges (
  challenge_hash text primary key check(challenge_hash~'^[a-f0-9]{64}$'),
  kind text not null check(kind in('setup','login','recovery')),
  owner_uid uuid not null,
  native_session_id uuid not null,
  -- Immutable email proof identity. Password setup/refresh may replace the
  -- provider session, but must never make the original email link reusable.
  email_session_id uuid unique,
  encrypted_state text not null check(length(encrypted_state) between 20 and 64000),
  email_proved_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  attempts integer not null default 0 check(attempts between 0 and 8),
  processing_lease uuid,
  processing_until timestamptz,
  consumed_at timestamptz
);
create index owner_access_challenge_expiry on public.owner_access_challenges(expires_at);
create table public.owner_access_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_uid uuid not null,
  native_session_id uuid not null,
  factor_id uuid not null,
  access_hash text not null unique check(access_hash~'^[a-f0-9]{64}$'),
  refresh_hash text not null unique check(refresh_hash~'^[a-f0-9]{64}$'),
  encrypted_state text not null check(length(encrypted_state) between 20 and 64000),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  refreshing_lease uuid,
  refreshing_until timestamptz,
  revoked_at timestamptz,
  check(expires_at<=absolute_expires_at),
  check(absolute_expires_at<=created_at+interval '1 hour')
);
create index owner_access_session_expiry on public.owner_access_sessions(absolute_expires_at);
create table public.owner_access_used_refresh (
  refresh_hash text primary key check(refresh_hash~'^[a-f0-9]{64}$'),
  session_id uuid not null references public.owner_access_sessions(id) on delete cascade,
  expires_at timestamptz not null
);
create table public.owner_access_recovery (
  code_hash text primary key check(code_hash~'^[a-f0-9]{64}$'),
  owner_uid uuid not null,
  created_at timestamptz not null default now(),
  used_at timestamptz
);
create table public.owner_access_attempts (
  id bigint generated always as identity primary key,
  ip_hash text not null check(ip_hash~'^[a-f0-9]{64}$'),
  scope text not null check(scope in('setup','login','proof','refresh')),
  created_at timestamptz not null default now()
);
create index owner_access_attempts_time on public.owner_access_attempts(created_at);
create index owner_access_attempts_ip on public.owner_access_attempts(ip_hash,created_at);
create table public.owner_access_log (
  id bigint generated always as identity primary key,
  event text not null check(length(event) between 1 and 60),
  ip_hash text check(ip_hash is null or ip_hash~'^[a-f0-9]{64}$'),
  device text not null default '' check(length(device)<=200),
  session_id uuid,
  source text not null default 'web' check(source in('web','telegram')),
  created_at timestamptz not null default now()
);
create index owner_access_log_time on public.owner_access_log(created_at);

alter table public.owner_access_config enable row level security;
alter table public.owner_access_challenges enable row level security;
alter table public.owner_access_sessions enable row level security;
alter table public.owner_access_used_refresh enable row level security;
alter table public.owner_access_recovery enable row level security;
alter table public.owner_access_attempts enable row level security;
alter table public.owner_access_log enable row level security;
revoke all on public.owner_access_config,public.owner_access_challenges,public.owner_access_sessions,public.owner_access_used_refresh,public.owner_access_recovery,public.owner_access_attempts,public.owner_access_log from public,anon,authenticated;
grant all on public.owner_access_config,public.owner_access_challenges,public.owner_access_sessions,public.owner_access_used_refresh,public.owner_access_recovery,public.owner_access_attempts,public.owner_access_log to service_role;
grant usage,select on sequence public.owner_access_attempts_id_seq,public.owner_access_log_id_seq to service_role;

-- Narrow SECURITY DEFINER exceptions: Auth tables are not exposed and service_role
-- has no blanket SELECT grant. These two private helpers reveal only the fixed
-- owner's UUID or a boolean, never password hashes, JWTs or unrelated users.
-- Public entrypoint below is SECURITY INVOKER and executable by service_role only.
create function uniflow_private.owner_auth_user()
returns uuid language plpgsql stable security definer set search_path='' as $$
declare matches integer; result uuid;
begin
  select count(*),(array_agg(u.id))[1] into matches,result from auth.users u
  where lower(u.email)='arappayevv@gmail.com' and u.deleted_at is null;
  if matches>1 then raise exception 'ambiguous owner'; end if;
  return result;
end; $$;
create function uniflow_private.owner_auth_session_valid(p_uid uuid,p_session uuid,p_factor uuid default null)
returns boolean language sql stable security definer set search_path='' as $$
select exists(
  select 1 from auth.users u join auth.sessions s on s.user_id=u.id
  where u.id=p_uid and lower(u.email)='arappayevv@gmail.com'
  and u.email_confirmed_at is not null and u.deleted_at is null
  and coalesce(u.phone,'')='' and coalesce(u.phone_change,'')=''
  and coalesce(u.is_anonymous,false)=false
  and (u.banned_until is null or u.banned_until<=now())
  and s.id=p_session and (s.not_after is null or s.not_after>now())
  and (p_factor is null or (s.factor_id=p_factor and s.aal::text='aal2' and exists(
    select 1 from auth.mfa_factors f where f.id=p_factor and f.user_id=u.id
    and f.factor_type::text='totp' and f.status::text='verified'
  )))
);
$$;
revoke all on function uniflow_private.owner_auth_user(),uniflow_private.owner_auth_session_valid(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function uniflow_private.owner_auth_user(),uniflow_private.owner_auth_session_valid(uuid,uuid,uuid) to service_role;

create function public.owner_access_command(p_op text,p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  cfg public.owner_access_config;
  ch public.owner_access_challenges;
  sess public.owner_access_sessions;
  n integer; ip_count integer; total_count integer;
  new_id uuid; native_uid uuid; old_refresh text; code text;
begin
  if p is null or jsonb_typeof(p)<>'object' or octet_length(p::text)>100000 then
    return jsonb_build_object('error','INVALID_REQUEST');
  end if;
  select * into cfg from public.owner_access_config where id=1;
  if p_op='state' then return to_jsonb(cfg); end if;
  if p_op='rate.reserve' then
    if coalesce(p->>'ip_hash','')!~'^[a-f0-9]{64}$' or coalesce(p->>'scope','') not in('setup','login','proof','refresh') then
      return jsonb_build_object('error','INVALID_REQUEST');
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('owner_access:rate',0));
    select count(*) into ip_count from public.owner_access_attempts where ip_hash=p->>'ip_hash' and created_at>now()-interval '15 minutes';
    select count(*) into total_count from public.owner_access_attempts where scope=p->>'scope' and created_at>now()-interval '15 minutes';
    if ip_count>=15 or total_count>=60 then return jsonb_build_object('error','RATE_LIMITED','retryAfterSeconds',900); end if;
    insert into public.owner_access_attempts(ip_hash,scope) values(p->>'ip_hash',p->>'scope');
    delete from public.owner_access_attempts where created_at<now()-interval '1 day';
    delete from public.owner_access_log where created_at<now()-interval '90 days';
    delete from public.owner_access_challenges where expires_at<now()-interval '1 day';
    delete from public.owner_access_sessions where absolute_expires_at<now()-interval '7 days';
    return jsonb_build_object('attempt',ip_count+1);
  end if;
  if p_op='setup.reserve' then
    select * into cfg from public.owner_access_config where id=1 for update;
    if cfg.setup_complete then return jsonb_build_object('error','ACCESS_DENIED'); end if;
    if cfg.mail_cooldown_until>now() then return jsonb_build_object('error','RATE_LIMITED','retryAfterSeconds',greatest(1,ceil(extract(epoch from cfg.mail_cooldown_until-now())))); end if;
    native_uid:=uniflow_private.owner_auth_user();
    if cfg.owner_uid is not null and native_uid is distinct from cfg.owner_uid then return jsonb_build_object('error','ACCESS_DENIED'); end if;
    update public.owner_access_config set
      owner_uid=coalesce(owner_uid,native_uid),
      bootstrap_deadline=case when bootstrap_deadline>now() then bootstrap_deadline else now()+interval '15 minutes' end,
      mail_cooldown_until=now()+interval '5 minutes',mail_lease=(p->>'lease')::uuid,updated_at=now()
    where id=1 returning * into cfg;
    return to_jsonb(cfg);
  end if;
  if p_op='setup.pin' then
    select * into cfg from public.owner_access_config where id=1 for update;
    native_uid:=uniflow_private.owner_auth_user();
    if cfg.setup_complete or cfg.mail_lease is distinct from (p->>'lease')::uuid or cfg.bootstrap_deadline<=now() or native_uid is null or native_uid is distinct from (p->>'owner_uid')::uuid or (cfg.owner_uid is not null and cfg.owner_uid<>native_uid) then
      return jsonb_build_object('error','ACCESS_DENIED');
    end if;
    update public.owner_access_config set owner_uid=native_uid,updated_at=now() where id=1 returning * into cfg;
    return to_jsonb(cfg);
  end if;
  if p_op='challenge.create' then
    if coalesce(p->>'challenge_hash','')!~'^[a-f0-9]{64}$' or coalesce(p->>'kind','') not in('setup','login') or cfg.owner_uid is null or cfg.owner_uid is distinct from (p->>'owner_uid')::uuid then
      return jsonb_build_object('error','ACCESS_DENIED');
    end if;
    if p->>'kind'='setup' and (cfg.setup_complete or cfg.bootstrap_deadline is null or cfg.bootstrap_deadline<=now()) then return jsonb_build_object('error','ACCESS_DENIED'); end if;
    if p->>'kind'='login' and not cfg.setup_complete then return jsonb_build_object('error','ACCESS_DENIED'); end if;
    if not uniflow_private.owner_auth_session_valid(cfg.owner_uid,(p->>'native_session_id')::uuid,null) then return jsonb_build_object('error','INVALID_PROOF'); end if;
    -- A native email link is accepted once, even if its JWT remains unexpired.
    if p->>'kind'='setup' and exists(select 1 from public.owner_access_challenges where email_session_id=(p->>'native_session_id')::uuid) then return jsonb_build_object('error','INVALID_PROOF'); end if;
    insert into public.owner_access_challenges(challenge_hash,kind,owner_uid,native_session_id,email_session_id,encrypted_state,email_proved_at,expires_at)
    values(p->>'challenge_hash',p->>'kind',cfg.owner_uid,(p->>'native_session_id')::uuid,case when p->>'kind'='setup' then (p->>'native_session_id')::uuid else null end,p->>'encrypted_state',case when p->>'kind'='setup' then now() else null end,now()+case when p->>'kind'='setup' then interval '10 minutes' else interval '5 minutes' end)
    returning * into ch;
    return to_jsonb(ch);
  end if;
  if p_op='challenge.claim' then
    select * into ch from public.owner_access_challenges where challenge_hash=p->>'challenge_hash' for update;
    if not found or ch.consumed_at is not null or ch.expires_at<=now() or ch.attempts>=5 or ch.owner_uid is distinct from cfg.owner_uid then return jsonb_build_object('error','INVALID_PROOF'); end if;
    if ch.processing_until>now() then return jsonb_build_object('error','FLOW_CONFLICT'); end if;
    update public.owner_access_challenges set attempts=attempts+1,processing_lease=(p->>'lease')::uuid,processing_until=now()+interval '45 seconds' where challenge_hash=ch.challenge_hash returning * into ch;
    return to_jsonb(ch);
  end if;
  if p_op in('challenge.save','challenge.release') then
    select * into ch from public.owner_access_challenges where challenge_hash=p->>'challenge_hash' for update;
    if not found or ch.consumed_at is not null or ch.expires_at<=now() or ch.processing_lease is distinct from (p->>'lease')::uuid or ch.processing_until<=now() then return jsonb_build_object('error','INVALID_PROOF'); end if;
    if p_op='challenge.save' then
      if p->>'email_proved'='true' then
        if p->>'email_session_id' is null or ch.email_session_id is not null or (p->>'email_session_id')::uuid=ch.native_session_id or exists(select 1 from public.owner_access_challenges where email_session_id=(p->>'email_session_id')::uuid) or not uniflow_private.owner_auth_session_valid(cfg.owner_uid,(p->>'email_session_id')::uuid,null) then return jsonb_build_object('error','INVALID_PROOF'); end if;
      end if;
      update public.owner_access_challenges set encrypted_state=coalesce(p->>'encrypted_state',encrypted_state),native_session_id=coalesce((p->>'native_session_id')::uuid,native_session_id),email_session_id=case when p->>'email_proved'='true' then (p->>'email_session_id')::uuid else email_session_id end,email_proved_at=case when p->>'email_proved'='true' then now() else email_proved_at end where challenge_hash=ch.challenge_hash returning * into ch;
    else
      update public.owner_access_challenges set processing_lease=null,processing_until=null where challenge_hash=ch.challenge_hash returning * into ch;
    end if;
    return to_jsonb(ch);
  end if;
  if p_op='recovery.consume' then
    select * into ch from public.owner_access_challenges where challenge_hash=p->>'challenge_hash' for update;
    if not found or ch.kind<>'login' or ch.consumed_at is not null or ch.expires_at<=now() or ch.processing_lease is distinct from (p->>'lease')::uuid or ch.processing_until<=now() or ch.email_proved_at is null then return jsonb_build_object('error','INVALID_PROOF'); end if;
    update public.owner_access_recovery set used_at=now() where code_hash=p->>'code_hash' and owner_uid=cfg.owner_uid and used_at is null;
    if not found then return jsonb_build_object('error','INVALID_PROOF'); end if;
    update public.owner_access_challenges set kind='recovery' where challenge_hash=ch.challenge_hash returning * into ch;
    update public.owner_access_sessions set revoked_at=now() where owner_uid=cfg.owner_uid and revoked_at is null;
    insert into public.owner_access_log(event,ip_hash,device,source) values('recovery_started',p->>'ip_hash',left(coalesce(p->>'device',''),200),'web');
    return to_jsonb(ch);
  end if;
  if p_op='session.create' then
    select * into cfg from public.owner_access_config where id=1 for update;
    select * into ch from public.owner_access_challenges where challenge_hash=p->>'challenge_hash' for update;
    if not found or ch.consumed_at is not null or ch.expires_at<=now() or ch.processing_lease is distinct from (p->>'lease')::uuid or ch.processing_until<=now() or ch.email_proved_at is null or ch.owner_uid is distinct from cfg.owner_uid then return jsonb_build_object('error','INVALID_PROOF'); end if;
    if (ch.kind='setup' and cfg.setup_complete) or (ch.kind in('login','recovery') and not cfg.setup_complete) or (ch.kind='login' and cfg.factor_id is distinct from (p->>'factor_id')::uuid) then return jsonb_build_object('error','ACCESS_DENIED'); end if;
    if ch.native_session_id is distinct from (p->>'native_session_id')::uuid or not uniflow_private.owner_auth_session_valid(cfg.owner_uid,ch.native_session_id,(p->>'factor_id')::uuid) then return jsonb_build_object('error','INVALID_PROOF'); end if;
    if ch.kind in('setup','recovery') or (ch.kind='login' and p->>'renew_recovery'='true') then
      if jsonb_typeof(p->'recovery_hashes')<>'array' or jsonb_array_length(p->'recovery_hashes')<>10 then return jsonb_build_object('error','INVALID_REQUEST'); end if;
      delete from public.owner_access_recovery where owner_uid=cfg.owner_uid;
      for code in select jsonb_array_elements_text(p->'recovery_hashes') loop
        insert into public.owner_access_recovery(code_hash,owner_uid) values(code,cfg.owner_uid);
      end loop;
      update public.owner_access_config set setup_complete=true,factor_id=(p->>'factor_id')::uuid,bootstrap_deadline=null,mail_lease=null,updated_at=now() where id=1 returning * into cfg;
      -- Cutover revocation does not change old passwords or timetable rows.
      delete from public.schedule_sessions;
      delete from public.uf_sessions where user_id='admin' or user_id in(select id::text from public.uf_accounts where role='admin');
      update public.uf_accounts set active=false where role='admin';
      update public.owner_access_sessions set revoked_at=now() where owner_uid=cfg.owner_uid and revoked_at is null;
    end if;
    insert into public.owner_access_sessions(owner_uid,native_session_id,factor_id,access_hash,refresh_hash,encrypted_state,expires_at,absolute_expires_at)
    values(cfg.owner_uid,ch.native_session_id,cfg.factor_id,p->>'access_hash',p->>'refresh_hash',p->>'encrypted_state',now()+interval '15 minutes',now()+interval '1 hour') returning * into sess;
    insert into public.owner_access_log(event,ip_hash,device,session_id,source)
    values(case when ch.kind='setup' then 'setup_completed' when ch.kind='recovery' then 'recovery_completed' when p->>'renew_recovery'='true' then 'recovery_codes_renewed' else 'login_succeeded' end,p->>'ip_hash',left(coalesce(p->>'device',''),200),sess.id,'web');
    update public.owner_access_challenges set consumed_at=now(),encrypted_state='consumed-provider-state',processing_lease=null,processing_until=null where challenge_hash=ch.challenge_hash;
    return to_jsonb(sess)||jsonb_build_object('owner_email',cfg.owner_email);
  end if;
  if p_op='session.verify' then
    select * into sess from public.owner_access_sessions where access_hash=p->>'access_hash';
    if not found or not cfg.setup_complete or sess.owner_uid is distinct from cfg.owner_uid or sess.factor_id is distinct from cfg.factor_id or sess.revoked_at is not null or sess.expires_at<=now() or sess.absolute_expires_at<=now() or not uniflow_private.owner_auth_session_valid(cfg.owner_uid,sess.native_session_id,cfg.factor_id) then return jsonb_build_object('error','INVALID_PROOF'); end if;
    return to_jsonb(sess)||jsonb_build_object('owner_email',cfg.owner_email);
  end if;
  if p_op='session.claim_refresh' then
    select * into sess from public.owner_access_sessions where refresh_hash=p->>'refresh_hash' for update;
    if not found then
      select session_id into new_id from public.owner_access_used_refresh where refresh_hash=p->>'refresh_hash';
      if found then update public.owner_access_sessions set revoked_at=now() where id=new_id and revoked_at is null; end if;
      return jsonb_build_object('error','INVALID_PROOF');
    end if;
    if not cfg.setup_complete or sess.owner_uid is distinct from cfg.owner_uid or sess.factor_id is distinct from cfg.factor_id or sess.revoked_at is not null or sess.absolute_expires_at<=now() or not uniflow_private.owner_auth_session_valid(cfg.owner_uid,sess.native_session_id,cfg.factor_id) then return jsonb_build_object('error','INVALID_PROOF'); end if;
    if sess.refreshing_until>now() then return jsonb_build_object('error','FLOW_CONFLICT'); end if;
    update public.owner_access_sessions set refreshing_lease=(p->>'lease')::uuid,refreshing_until=now()+interval '45 seconds' where id=sess.id returning * into sess;
    return to_jsonb(sess)||jsonb_build_object('owner_email',cfg.owner_email);
  end if;
  if p_op='session.rotate' then
    select * into sess from public.owner_access_sessions where id=(p->>'id')::uuid for update;
    if not found or sess.revoked_at is not null or sess.absolute_expires_at<=now() or sess.refreshing_lease is distinct from (p->>'lease')::uuid or sess.refreshing_until<=now() or sess.factor_id is distinct from cfg.factor_id or sess.owner_uid is distinct from cfg.owner_uid or not uniflow_private.owner_auth_session_valid(cfg.owner_uid,sess.native_session_id,cfg.factor_id) then return jsonb_build_object('error','INVALID_PROOF'); end if;
    old_refresh:=sess.refresh_hash;
    insert into public.owner_access_used_refresh(refresh_hash,session_id,expires_at) values(old_refresh,sess.id,sess.absolute_expires_at);
    update public.owner_access_sessions set access_hash=p->>'access_hash',refresh_hash=p->>'refresh_hash',encrypted_state=p->>'encrypted_state',expires_at=least(now()+interval '15 minutes',absolute_expires_at),refreshing_lease=null,refreshing_until=null where id=sess.id returning * into sess;
    return to_jsonb(sess)||jsonb_build_object('owner_email',cfg.owner_email);
  end if;
  if p_op='session.revoke' then
    select * into sess from public.owner_access_sessions where id=(p->>'id')::uuid for update;
    if not found then return jsonb_build_object('error','INVALID_PROOF'); end if;
    update public.owner_access_sessions set revoked_at=now(),encrypted_state='revoked-provider-state' where (p->>'all'='true' and owner_uid=sess.owner_uid) or id=sess.id;
    if p->>'all'='true' then
      delete from public.schedule_sessions;
      delete from public.uf_sessions where user_id='admin' or user_id in(select id::text from public.uf_accounts where role='admin');
    end if;
    return jsonb_build_object('ok',true);
  end if;
  if p_op='log' then
    if coalesce(p->>'event','') not in('setup_requested','setup_completed','login_succeeded','login_failed','proof_failed','refresh_failed','logout','logout_all','recovery_started','recovery_completed') then return jsonb_build_object('error','INVALID_REQUEST'); end if;
    insert into public.owner_access_log(event,ip_hash,device,session_id,source) values(p->>'event',p->>'ip_hash',left(coalesce(p->>'device',''),200),(p->>'session_id')::uuid,'web');
    return jsonb_build_object('ok',true);
  end if;
  return jsonb_build_object('error','INVALID_REQUEST');
exception when unique_violation then
  return jsonb_build_object('error','INVALID_PROOF');
when invalid_text_representation or check_violation or not_null_violation then
  return jsonb_build_object('error','INVALID_REQUEST');
end; $$;
revoke all on function public.owner_access_command(text,jsonb) from public,anon,authenticated;
grant execute on function public.owner_access_command(text,jsonb) to service_role;

-- Prevent any new legacy admin identity at the database boundary, even if an old
-- server or a direct service client attempts to insert/promote one. Existing rows
-- are preserved; activation revokes/deactivates them without changing passwords.
create or replace function public.owner_access_deny_extra_admin()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if new.role='admin' and (TG_OP='INSERT' or old.role is distinct from new.role or new.active is true) then
    raise exception 'owner-only administration';
  end if;
  return new;
end; $$;
revoke all on function public.owner_access_deny_extra_admin() from public,anon,authenticated;
drop trigger if exists owner_access_deny_extra_admin on public.uf_accounts;
create trigger owner_access_deny_extra_admin before insert or update on public.uf_accounts for each row execute function public.owner_access_deny_extra_admin();

-- Native Auth inserts an invited user before assigning invited_at in the SAME
-- transaction. Check the final stored row with a deferred constraint trigger;
-- requiring invited_at in BEFORE INSERT would break legitimate invitations.
-- Public signup cannot choose invited_at, so it cannot provision even the owner.
create or replace function uniflow_private.owner_auth_email_immutable()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if new.id is distinct from old.id or lower(new.email) is distinct from lower(old.email) or coalesce(new.phone,'')<>'' or coalesce(new.phone_change,'')<>'' then
    raise exception 'owner identity is immutable';
  end if;
  return new;
end; $$;
create or replace function uniflow_private.owner_auth_registration_guard()
returns trigger language plpgsql security definer set search_path='' as $$
declare actual_email text; actual_invited_at timestamptz; actual_phone text; actual_phone_change text; pinned_uid uuid;
begin
  select email,invited_at,phone,phone_change into actual_email,actual_invited_at,actual_phone,actual_phone_change from auth.users where id=new.id;
  if not found then return null; end if;
  select owner_uid into pinned_uid from public.owner_access_config where id=1;
  if actual_email is null or lower(actual_email)<>'arappayevv@gmail.com' or actual_invited_at is null or coalesce(actual_phone,'')<>'' or coalesce(actual_phone_change,'')<>'' or (pinned_uid is not null and new.id<>pinned_uid) then
    raise exception 'owner-only registration';
  end if;
  return null;
end; $$;
revoke all on function uniflow_private.owner_auth_email_immutable(),uniflow_private.owner_auth_registration_guard() from public,anon,authenticated;
grant execute on function uniflow_private.owner_auth_email_immutable(),uniflow_private.owner_auth_registration_guard() to supabase_auth_admin,service_role;
drop trigger if exists owner_auth_email_immutable on auth.users;
create trigger owner_auth_email_immutable before update on auth.users for each row execute function uniflow_private.owner_auth_email_immutable();
drop trigger if exists owner_auth_registration_guard on auth.users;
create constraint trigger owner_auth_registration_guard after insert or update on auth.users deferrable initially deferred for each row execute function uniflow_private.owner_auth_registration_guard();
commit;
