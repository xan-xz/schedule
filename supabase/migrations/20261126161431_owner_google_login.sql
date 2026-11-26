-- A Google sign-in is bound to the existing owner's linked Google identity
-- and to its native Auth session. The original authenticator remains usable.

alter table public.owner_access_config
  add column google_subject text check (google_subject ~ '^[0-9]{1,255}$');
alter table public.owner_access_sessions
  alter column factor_id drop not null,
  add column google_subject text check (google_subject ~ '^[0-9]{1,255}$'),
  add constraint owner_access_session_one_credential
    check ((factor_id is not null) <> (google_subject is not null));
create unique index owner_access_google_native_session
  on public.owner_access_sessions(native_session_id) where google_subject is not null;

-- Managed identities stay private. The app role receives only a boolean.
create function uniflow_private.owner_auth_google_identity_valid(p_uid uuid, p_subject text)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(
    select 1 from auth.identities i
    where i.user_id=p_uid and i.provider='google' and i.provider_id=p_subject
      and lower(i.email)='arappayevv@gmail.com'
  );
$$;
revoke all on function uniflow_private.owner_auth_google_identity_valid(uuid,text) from public,anon,authenticated;
grant execute on function uniflow_private.owner_auth_google_identity_valid(uuid,text) to service_role;

create function uniflow_private.owner_session_identity_valid(
  p_cfg public.owner_access_config, p_sess public.owner_access_sessions
)
returns boolean language sql stable security invoker set search_path='' as $$
  select (p_cfg).owner_uid is not null
    and (p_sess).owner_uid is not distinct from (p_cfg).owner_uid
    and case when (p_sess).google_subject is not null then
      (p_sess).google_subject is not distinct from (p_cfg).google_subject
      and uniflow_private.owner_auth_google_identity_valid((p_cfg).owner_uid,(p_sess).google_subject)
      and uniflow_private.owner_auth_session_valid((p_cfg).owner_uid,(p_sess).native_session_id,null)
    else
      (p_cfg).setup_complete and (p_sess).factor_id is not distinct from (p_cfg).factor_id
      and uniflow_private.owner_auth_session_valid((p_cfg).owner_uid,(p_sess).native_session_id,(p_cfg).factor_id)
    end;
$$;
revoke all on function uniflow_private.owner_session_identity_valid(public.owner_access_config,public.owner_access_sessions) from public,anon,authenticated;
grant execute on function uniflow_private.owner_session_identity_valid(public.owner_access_config,public.owner_access_sessions) to service_role;

create or replace function public.owner_access_command(p_op text,p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  cfg public.owner_access_config;
  ch public.owner_access_challenges;
  sess public.owner_access_sessions;
  n integer; ip_count integer; total_count integer;
  new_id uuid; native_uid uuid; password_totp_factor uuid; old_refresh text; code text;
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
    password_totp_factor:=(p->>'password_totp_factor_id')::uuid;
    if p->>'kind'='setup' and (cfg.setup_complete or (password_totp_factor is null and (cfg.bootstrap_deadline is null or cfg.bootstrap_deadline<=now()))) then return jsonb_build_object('error','ACCESS_DENIED'); end if;
    if password_totp_factor is not null and cfg.factor_id is not null and cfg.factor_id<>password_totp_factor then return jsonb_build_object('error','ACCESS_DENIED'); end if;
    if p->>'kind'='login' and not cfg.setup_complete then return jsonb_build_object('error','ACCESS_DENIED'); end if;
    if not uniflow_private.owner_auth_session_valid(cfg.owner_uid,(p->>'native_session_id')::uuid,null) then return jsonb_build_object('error','INVALID_PROOF'); end if;
    -- A native email link is accepted once, even if its JWT remains unexpired.
    if password_totp_factor is null and p->>'kind'='setup' and exists(select 1 from public.owner_access_challenges where email_session_id=(p->>'native_session_id')::uuid) then return jsonb_build_object('error','INVALID_PROOF'); end if;
    insert into public.owner_access_challenges(challenge_hash,kind,owner_uid,native_session_id,email_session_id,encrypted_state,email_proved_at,expires_at,password_totp_factor_id)
    values(p->>'challenge_hash',p->>'kind',cfg.owner_uid,(p->>'native_session_id')::uuid,
      case when password_totp_factor is null and p->>'kind'='setup' then (p->>'native_session_id')::uuid end,
      p->>'encrypted_state',case when password_totp_factor is null and p->>'kind'='setup' then now() end,
      now()+case when password_totp_factor is null and p->>'kind'='setup' then interval '10 minutes' else interval '5 minutes' end,password_totp_factor)
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
      if ch.password_totp_factor_id is not null and (p ? 'native_session_id' or p->>'email_proved'='true') then return jsonb_build_object('error','INVALID_PROOF'); end if;
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
    if not found or ch.consumed_at is not null or ch.expires_at<=now() or ch.processing_lease is distinct from (p->>'lease')::uuid or ch.processing_until<=now() or ch.owner_uid is distinct from cfg.owner_uid then return jsonb_build_object('error','INVALID_PROOF'); end if;
    if ch.password_totp_factor_id is not null then
      if ch.password_totp_factor_id is distinct from (p->>'factor_id')::uuid then return jsonb_build_object('error','INVALID_PROOF'); end if;
    elsif ch.email_proved_at is null then return jsonb_build_object('error','INVALID_PROOF'); end if;
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
      delete from public.schedule_sessions where expires_at > now();
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
  if p_op='session.create_google' then
    select * into cfg from public.owner_access_config where id=1 for update;
    if cfg.owner_uid is null or cfg.owner_uid is distinct from (p->>'owner_uid')::uuid
       or coalesce(p->>'google_subject','')!~'^[0-9]{1,255}$'
       or (cfg.google_subject is not null and cfg.google_subject is distinct from p->>'google_subject')
       or not uniflow_private.owner_auth_google_identity_valid(cfg.owner_uid,p->>'google_subject')
       or not uniflow_private.owner_auth_session_valid(cfg.owner_uid,(p->>'native_session_id')::uuid,null) then
      return jsonb_build_object('error','ACCESS_DENIED');
    end if;
    if cfg.google_subject is null then
      update public.owner_access_config set google_subject=p->>'google_subject',updated_at=now() where id=1 returning * into cfg;
    end if;
    insert into public.owner_access_sessions(owner_uid,native_session_id,google_subject,access_hash,refresh_hash,encrypted_state,expires_at,absolute_expires_at)
    values(cfg.owner_uid,(p->>'native_session_id')::uuid,cfg.google_subject,p->>'access_hash',p->>'refresh_hash',p->>'encrypted_state',now()+interval '15 minutes',now()+interval '1 hour')
    returning * into sess;
    insert into public.owner_access_log(event,ip_hash,device,session_id,source)
    values('login_succeeded',p->>'ip_hash',left(coalesce(p->>'device',''),200),sess.id,'web');
    return to_jsonb(sess)||jsonb_build_object('owner_email',cfg.owner_email);
  end if;
  if p_op='session.verify' then
    select * into sess from public.owner_access_sessions where access_hash=p->>'access_hash';
    if not found or sess.revoked_at is not null or sess.expires_at<=now() or sess.absolute_expires_at<=now() or not uniflow_private.owner_session_identity_valid(cfg,sess) then return jsonb_build_object('error','INVALID_PROOF'); end if;
    return to_jsonb(sess)||jsonb_build_object('owner_email',cfg.owner_email);
  end if;
  if p_op='session.claim_refresh' then
    select * into sess from public.owner_access_sessions where refresh_hash=p->>'refresh_hash' for update;
    if not found then
      select session_id into new_id from public.owner_access_used_refresh where refresh_hash=p->>'refresh_hash';
      if found then update public.owner_access_sessions set revoked_at=now() where id=new_id and revoked_at is null; end if;
      return jsonb_build_object('error','INVALID_PROOF');
    end if;
    if sess.revoked_at is not null or sess.absolute_expires_at<=now() or not uniflow_private.owner_session_identity_valid(cfg,sess) then return jsonb_build_object('error','INVALID_PROOF'); end if;
    if sess.refreshing_until>now() then return jsonb_build_object('error','FLOW_CONFLICT'); end if;
    update public.owner_access_sessions set refreshing_lease=(p->>'lease')::uuid,refreshing_until=now()+interval '45 seconds' where id=sess.id returning * into sess;
    return to_jsonb(sess)||jsonb_build_object('owner_email',cfg.owner_email);
  end if;
  if p_op='session.rotate' then
    select * into sess from public.owner_access_sessions where id=(p->>'id')::uuid for update;
    if not found or sess.revoked_at is not null or sess.absolute_expires_at<=now() or sess.refreshing_lease is distinct from (p->>'lease')::uuid or sess.refreshing_until<=now() or not uniflow_private.owner_session_identity_valid(cfg,sess) then return jsonb_build_object('error','INVALID_PROOF'); end if;
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
      delete from public.schedule_sessions where expires_at > now();
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
