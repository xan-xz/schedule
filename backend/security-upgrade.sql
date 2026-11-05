-- Applied 2026-11-06 (Asia/Qyzylorda), migration version 20261105213809.
-- Additive upgrade: apply in a reviewed migration before deploying the new Edge Functions.
-- Created with `supabase migration new security_sessions`; see docs/BACKEND_RELEASE.md.
-- Existing timetable rows, hashes, sessions, and history are not overwritten.
begin;
create or replace function public.uf_login_attempt(p_ip_hash text, p_account_hash text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare ip_count integer; account_count integer;
begin
  if p_ip_hash !~ '^[a-f0-9]{64}$' or p_account_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid limiter key';
  end if;
  -- Stable lock ordering prevents deadlocks; the insert and counts are atomic.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(least(p_ip_hash,p_account_hash),0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(greatest(p_ip_hash,p_account_hash),0));
  select count(*) into ip_count from public.schedule_login_attempts
    where ip_hash=p_ip_hash and created_at>now()-interval '15 minutes';
  select count(*) into account_count from public.schedule_login_attempts
    where ip_hash=p_account_hash and created_at>now()-interval '15 minutes';
  if ip_count>=10 or account_count>=30 then return false; end if;
  insert into public.schedule_login_attempts(ip_hash) values(p_ip_hash),(p_account_hash);
  delete from public.schedule_login_attempts where created_at<now()-interval '1 day';
  return true;
end; $$;
revoke all on function public.uf_login_attempt(text,text) from public,anon,authenticated;
grant execute on function public.uf_login_attempt(text,text) to service_role;

create or replace function public.uf_revoke_sessions(p_user_id text)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  delete from public.uf_sessions where user_id=p_user_id;
  if p_user_id='admin' then delete from public.schedule_sessions; end if;
end; $$;
revoke all on function public.uf_revoke_sessions(text) from public,anon,authenticated;
grant execute on function public.uf_revoke_sessions(text) to service_role;

create or replace function public.uf_change_password(p_user_id text,p_salt text,p_hash text)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if p_salt !~ '^[a-f0-9]{32}$' or p_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid credential format'; end if;
  if p_user_id='admin' then
    update public.schedule_settings set salt=p_salt,password_hash=p_hash where id=1;
  else
    update public.uf_accounts set salt=p_salt,password_hash=p_hash where id=p_user_id::uuid;
  end if;
  if not found then raise exception 'account not found'; end if;
  perform public.uf_revoke_sessions(p_user_id);
end; $$;
revoke all on function public.uf_change_password(text,text,text) from public,anon,authenticated;
grant execute on function public.uf_change_password(text,text,text) to service_role;

-- Serialize password change vs session creation. A password verified before a
-- concurrent rotation cannot create a new session after the revocation.
create or replace function public.uf_create_session(p_user_id text,p_token_hash text,p_expected_hash text,p_legacy boolean default false)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare actual_hash text;
begin
  if p_token_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid session'; end if;
  if p_user_id='admin' then
    select password_hash into actual_hash from public.schedule_settings where id=1 for update;
  else
    select password_hash into actual_hash from public.uf_accounts where id=p_user_id::uuid and active for update;
  end if;
  if actual_hash is null or actual_hash<>p_expected_hash then return false; end if;
  if p_legacy then
    if p_user_id<>'admin' then return false; end if;
    insert into public.schedule_sessions(token_hash,expires_at) values(p_token_hash,now()+interval '2 hours');
  else
    insert into public.uf_sessions(token_hash,user_id,expires_at) values(p_token_hash,p_user_id,now()+interval '2 hours');
  end if;
  return true;
end; $$;
revoke all on function public.uf_create_session(text,text,text,boolean) from public,anon,authenticated;
grant execute on function public.uf_create_session(text,text,text,boolean) to service_role;
commit;
