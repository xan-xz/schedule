-- ISOLATED TRANSACTION PROBES. NO EMAIL, NO PASSWORD, NO REAL TOKEN.
-- Requires the pending owner-access migration in this SAME transaction, and an
-- empty native Auth user store (the verified pre-activation project baseline).
-- Root orchestration removes this file's outer BEGIN/ROLLBACK when concatenating
-- migration DDL into its own BEGIN ... ROLLBACK. Never COMMIT these fixtures.
begin;
create temporary table owner_probe_results(name text primary key,passed boolean not null) on commit drop;
do $$
begin
  if exists(select 1 from auth.users) then raise exception 'Probe requires an isolated empty Auth baseline'; end if;
  if exists(select 1 from public.owner_access_config where setup_complete or owner_uid is not null) then raise exception 'Probe requires fresh unactivated owner configuration'; end if;
end; $$;

-- Native public signup cannot provision even the owner by putting invited_at in
-- user metadata. The real invited_at column must be set by the invite transaction.
do $$
declare denied boolean:=false;
begin
  begin
    insert into auth.users(id,email,raw_user_meta_data,created_at,updated_at)
    values('01010101-0101-4101-8101-010101010101','arappayevv@gmail.com','{"invited_at":"synthetic metadata only"}'::jsonb,now(),now());
    set constraints all immediate;
  exception when others then
    if SQLERRM not like '%owner-only registration%' then raise; end if;
    denied:=true;
  end;
  set constraints all deferred;
  if not denied or exists(select 1 from auth.users) then raise exception 'Public owner signup persisted'; end if;
  insert into owner_probe_results values('native public signup denied at transaction end',true);
end; $$;

-- This ordering exactly models native invite.go -> signupNewUser -> sendInvite.
do $$
declare denied boolean:=false;
begin
  begin
    insert into auth.users(id,email,phone,invited_at,created_at,updated_at)
    values('0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b','arappayevv@gmail.com','+12025550123',now(),now(),now());
    set constraints all immediate;
  exception when others then
    if SQLERRM not like '%owner-only registration%' then raise; end if;
    denied:=true;
  end;
  set constraints all deferred;
  if not denied or exists(select 1 from auth.users) then raise exception 'Phone-bearing owner persisted'; end if;
  insert into owner_probe_results values('native owner registration rejects phone binding and therefore SMS signin',true);
end; $$;

-- Hosted Supabase protects supabase_auth_admin from SET ROLE. Model the SQL
-- ordering under this migration executor; assert the native callback ACL below.
-- This is not a claim that a real native invite/email has been exercised.
insert into auth.users(id,aud,role,email,email_confirmed_at,created_at,updated_at)
values('01010101-0101-4101-8101-010101010101','authenticated','authenticated','arappayevv@gmail.com',now(),now(),now());
update auth.users set invited_at=now() where id='01010101-0101-4101-8101-010101010101';
set constraints all immediate;
set constraints all deferred;
insert into owner_probe_results values('native invite SQL ordering accepted under migration executor; native delivery pending',true);

do $$
declare denied boolean:=false;
begin
  begin
    update auth.users set email='other@example.invalid' where id='01010101-0101-4101-8101-010101010101';
  exception when others then
    if SQLERRM not like '%owner identity is immutable%' then raise; end if;
    denied:=true;
  end;
  if not denied then raise exception 'Owner email changed'; end if;
  insert into owner_probe_results values('owner email and UID immutable',true);
  denied:=false;
  begin
    update auth.users set phone='+12025550123' where id='01010101-0101-4101-8101-010101010101';
  exception when others then
    if SQLERRM not like '%owner identity is immutable%' then raise; end if;
    denied:=true;
  end;
  if not denied then raise exception 'Owner phone bound'; end if;
  denied:=false;
  begin
    update auth.users set phone_change='+12025550123' where id='01010101-0101-4101-8101-010101010101';
  exception when others then
    if SQLERRM not like '%owner identity is immutable%' then raise; end if;
    denied:=true;
  end;
  if not denied then raise exception 'Pending owner phone change persisted'; end if;
  insert into owner_probe_results values('native owner phone and pending phone_change updates rejected',true);
  denied:=false;
  begin
    insert into auth.users(id,email,invited_at,created_at,updated_at)
    values('0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a','other@example.invalid',now(),now(),now());
    set constraints all immediate;
  exception when others then
    if SQLERRM not like '%owner-only registration%' then raise; end if;
    denied:=true;
  end;
  set constraints all deferred;
  if not denied then raise exception 'Another invited identity persisted'; end if;
  insert into owner_probe_results values('another native invited account rejected',true);
end; $$;

-- No native factor seed is needed: these synthetic rows only exercise the SQL
-- identity/session policy. Real native TOTP enrollment is a separate owner check.
insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at)
values
('02020202-0202-4202-8202-020202020202','01010101-0101-4101-8101-010101010101','Synthetic approved factor','totp','verified',now(),now()),
('03030303-0303-4303-8303-030303030303','01010101-0101-4101-8101-010101010101','Synthetic unapproved factor','totp','verified',now(),now());
insert into auth.sessions(id,user_id,created_at,updated_at,factor_id,aal,not_after)
values
('04040404-0404-4404-8404-040404040404','01010101-0101-4101-8101-010101010101',now(),now(),'02020202-0202-4202-8202-020202020202','aal2',now()+interval '1 hour'),
('05050505-0505-4505-8505-050505050505','01010101-0101-4101-8101-010101010101',now(),now(),null,'aal1',now()+interval '1 hour'),
('06060606-0606-4606-8606-060606060606','01010101-0101-4101-8101-010101010101',now(),now(),'03030303-0303-4303-8303-030303030303','aal2',now()+interval '1 hour'),
('07070707-0707-4707-8707-070707070707','01010101-0101-4101-8101-010101010101',now(),now(),'02020202-0202-4202-8202-020202020202','aal2',now()-interval '1 minute'),
('08080808-0808-4808-8808-080808080808','01010101-0101-4101-8101-010101010101',now(),now(),null,'aal1',now()+interval '1 hour'),
('09090909-0909-4909-8909-090909090909','01010101-0101-4101-8101-010101010101',now(),now(),null,'aal1',now()+interval '1 hour');
update public.owner_access_config set owner_uid='01010101-0101-4101-8101-010101010101',bootstrap_deadline=now()+interval '15 minutes' where id=1;

do $$
declare relation regclass; client_role text;
begin
  for relation in select unnest(array[
    'public.owner_access_config'::regclass,'public.owner_access_challenges'::regclass,
    'public.owner_access_sessions'::regclass,'public.owner_access_used_refresh'::regclass,
    'public.owner_access_recovery'::regclass,'public.owner_access_attempts'::regclass,'public.owner_access_log'::regclass
  ]) loop
    if not (select relrowsecurity from pg_class where oid=relation) then raise exception 'Missing RLS'; end if;
    foreach client_role in array array['anon','authenticated'] loop
      if has_table_privilege(client_role,relation,'SELECT') or has_table_privilege(client_role,relation,'INSERT') or has_table_privilege(client_role,relation,'UPDATE') or has_table_privilege(client_role,relation,'DELETE') then raise exception 'Client table privilege leaked'; end if;
    end loop;
  end loop;
  if has_function_privilege('anon','public.owner_access_command(text,jsonb)','EXECUTE') or has_function_privilege('authenticated','public.owner_access_command(text,jsonb)','EXECUTE') or not has_function_privilege('service_role','public.owner_access_command(text,jsonb)','EXECUTE') then raise exception 'RPC grants invalid'; end if;
  if has_schema_privilege('anon','uniflow_private','USAGE') or has_schema_privilege('authenticated','uniflow_private','USAGE') then raise exception 'Private schema exposed'; end if;
  if not has_schema_privilege('supabase_auth_admin','uniflow_private','USAGE') or not has_function_privilege('supabase_auth_admin','uniflow_private.owner_auth_email_immutable()','EXECUTE') or not has_function_privilege('supabase_auth_admin','uniflow_private.owner_auth_registration_guard()','EXECUTE') then raise exception 'Native Auth callback ACL missing'; end if;
  insert into owner_probe_results values('all seven tables RLS and default-deny client grants',true),('RPC service-only and private Auth helpers inaccessible to client roles',true);
  insert into owner_probe_results values('native Auth callback schema/function grants verified as metadata; role execution pending',true);
  if not uniflow_private.owner_auth_session_valid('01010101-0101-4101-8101-010101010101','04040404-0404-4404-8404-040404040404','02020202-0202-4202-8202-020202020202') then raise exception 'Approved native factor rejected'; end if;
  if uniflow_private.owner_auth_session_valid('01010101-0101-4101-8101-010101010101','05050505-0505-4505-8505-050505050505','02020202-0202-4202-8202-020202020202') or uniflow_private.owner_auth_session_valid('01010101-0101-4101-8101-010101010101','06060606-0606-4606-8606-060606060606','02020202-0202-4202-8202-020202020202') or uniflow_private.owner_auth_session_valid('01010101-0101-4101-8101-010101010101','07070707-0707-4707-8707-070707070707','02020202-0202-4202-8202-020202020202') then raise exception 'Weak, unapproved or expired native session accepted'; end if;
  insert into owner_probe_results values('approved factor and native AAL2 required; other factors and expired sessions denied',true);
end; $$;

set local role anon;
do $$
begin
  begin
    perform public.owner_access_command('state');
    raise exception 'Anonymous RPC unexpectedly accessible';
  exception when insufficient_privilege then null; end;
  begin
    perform 1 from public.owner_access_config;
    raise exception 'Anonymous table unexpectedly accessible';
  exception when insufficient_privilege then null; end;
end; $$;
reset role;
set local request.jwt.claims='{"role":"authenticated","aal":"aal2","sub":"01010101-0101-4101-8101-010101010101"}';
set local role authenticated;
do $$
begin
  begin
    perform public.owner_access_command('state');
    raise exception 'Client AAL2 claims bypassed service boundary';
  exception when insufficient_privilege then null; end;
  begin
    perform 1 from public.owner_access_config;
    raise exception 'Client AAL2 claims exposed private table';
  exception when insufficient_privilege then null; end;
end; $$;
reset role;
set local request.jwt.claims='{}';
set local role service_role;
do $$
declare r jsonb;
begin
  r:=public.owner_access_command('state');
  if r->>'owner_email'<>'arappayevv@gmail.com' then raise exception 'Service wrapper unavailable'; end if;
  if not uniflow_private.owner_auth_session_valid('01010101-0101-4101-8101-010101010101','04040404-0404-4404-8404-040404040404','02020202-0202-4202-8202-020202020202') then raise exception 'Service cannot invoke narrow Auth checker'; end if;
end; $$;
reset role;
insert into owner_probe_results values('actual anon and authenticated AAL2 roles cannot invoke RPC or read private tables',true),('service role can execute invoker wrapper and narrow private Auth checker',true);

-- Bootstrap's immutable email identity survives password-session replacement.
do $$
declare r jsonb; lease uuid:='11111111-1111-4111-8111-111111111111';
begin
  r:=public.owner_access_command('challenge.create',jsonb_build_object('challenge_hash',repeat('1',64),'kind','setup','owner_uid','01010101-0101-4101-8101-010101010101','native_session_id','08080808-0808-4808-8808-080808080808','encrypted_state','v1.synthetic-encrypted-provider-state'));
  if r?'error' then raise exception 'Setup challenge fixture rejected'; end if;
  r:=public.owner_access_command('challenge.claim',jsonb_build_object('challenge_hash',repeat('1',64),'lease',lease));
  r:=public.owner_access_command('challenge.save',jsonb_build_object('challenge_hash',repeat('1',64),'lease',lease,'native_session_id','05050505-0505-4505-8505-050505050505','encrypted_state','v1.synthetic-password-provider-state'));
  if r?'error' or r->>'email_session_id'<>'08080808-0808-4808-8808-080808080808' then raise exception 'Immutable email identity changed'; end if;
  r:=public.owner_access_command('challenge.create',jsonb_build_object('challenge_hash',repeat('f',64),'kind','setup','owner_uid','01010101-0101-4101-8101-010101010101','native_session_id','08080808-0808-4808-8808-080808080808','encrypted_state','v1.synthetic-replayed-provider-state'));
  if r->>'error'<>'INVALID_PROOF' then raise exception 'Bootstrap reused after password change'; end if;
  insert into owner_probe_results values('bootstrap email-session replay denied after password-session replacement',true);
end; $$;

-- Configure a synthetic owner directly: the probes intentionally avoid the
-- setup/recovery activation branch, which also revokes existing legacy sessions.
update public.owner_access_config set setup_complete=true,factor_id='02020202-0202-4202-8202-020202020202',bootstrap_deadline=null where id=1;
do $$
declare r jsonb; p jsonb; lease uuid:='12121212-1212-4212-8212-121212121212'; before_count integer;
begin
  r:=public.owner_access_command('challenge.create',jsonb_build_object('challenge_hash',repeat('2',64),'kind','login','owner_uid','01010101-0101-4101-8101-010101010101','native_session_id','04040404-0404-4404-8404-040404040404','encrypted_state','v1.synthetic-encrypted-provider-state'));
  if r?'error' then raise exception 'Login challenge rejected'; end if;
  r:=public.owner_access_command('challenge.claim',jsonb_build_object('challenge_hash',repeat('2',64),'lease',lease));
  r:=public.owner_access_command('challenge.save',jsonb_build_object('challenge_hash',repeat('2',64),'lease',lease,'email_proved',true,'email_session_id','09090909-0909-4909-8909-090909090909','encrypted_state','v1.synthetic-encrypted-provider-state'));
  if r?'error' then raise exception 'Email proof fixture rejected'; end if;
  p:=jsonb_build_object('challenge_hash',repeat('2',64),'lease',lease,'native_session_id','04040404-0404-4404-8404-040404040404','factor_id','02020202-0202-4202-8202-020202020202','access_hash',repeat('a',64),'refresh_hash',repeat('b',64),'encrypted_state','v1.synthetic-encrypted-provider-state','ip_hash','BAD','device','Synthetic SQL probe');
  select count(*) into before_count from public.owner_access_log;
  r:=public.owner_access_command('session.create',p);
  if r->>'error'<>'INVALID_REQUEST' or exists(select 1 from public.owner_access_sessions) or exists(select 1 from public.owner_access_challenges where challenge_hash=repeat('2',64) and consumed_at is not null) or (select count(*) from public.owner_access_log)<>before_count then raise exception 'Audit failure partially committed access'; end if;
  insert into owner_probe_results values('bad audit input atomically rolls back session creation and challenge consumption',true);
  r:=public.owner_access_command('session.create',p||jsonb_build_object('ip_hash',repeat('d',64)));
  if r?'error' then raise exception 'Valid full-proof access rejected'; end if;
  if (r->>'expires_at')::timestamptz>now()+interval '15 minutes 1 second' or (r->>'absolute_expires_at')::timestamptz>now()+interval '1 hour 1 second' then raise exception 'Session lifetime too long'; end if;
  if not exists(select 1 from public.owner_access_log where session_id=(r->>'id')::uuid and event='login_succeeded') then raise exception 'Success audit missing'; end if;
  r:=public.owner_access_command('session.verify',jsonb_build_object('access_hash',repeat('a',64)));
  if r?'error' or r->>'owner_uid'<>'01010101-0101-4101-8101-010101010101' then raise exception 'Owner access rejected'; end if;
  insert into owner_probe_results values('full-proof owner session and success audit committed together',true),('access 15 minutes and absolute refresh lifetime 1 hour',true);
end; $$;

-- A second password flow cannot reuse the first flow's already-consumed email JWT.
do $$
declare r jsonb; lease uuid:='13131313-1313-4313-8313-131313131313';
begin
  r:=public.owner_access_command('challenge.create',jsonb_build_object('challenge_hash',repeat('3',64),'kind','login','owner_uid','01010101-0101-4101-8101-010101010101','native_session_id','05050505-0505-4505-8505-050505050505','encrypted_state','v1.synthetic-encrypted-provider-state'));
  r:=public.owner_access_command('challenge.claim',jsonb_build_object('challenge_hash',repeat('3',64),'lease',lease));
  r:=public.owner_access_command('challenge.save',jsonb_build_object('challenge_hash',repeat('3',64),'lease',lease,'email_proved',true,'email_session_id','09090909-0909-4909-8909-090909090909','encrypted_state','v1.synthetic-encrypted-provider-state'));
  if r->>'error'<>'INVALID_PROOF' then raise exception 'Email JWT reused across flows'; end if;
  insert into owner_probe_results values('email-session JWT globally one use across password challenges',true);
end; $$;

do $$
declare r jsonb; current_id uuid; lease uuid:='14141414-1414-4414-8414-141414141414'; deadline timestamptz;
begin
  r:=public.owner_access_command('session.claim_refresh',jsonb_build_object('refresh_hash',repeat('b',64),'lease',lease));
  if r?'error' then raise exception 'Refresh rejected'; end if;
  current_id:=(r->>'id')::uuid; deadline:=(r->>'absolute_expires_at')::timestamptz;
  r:=public.owner_access_command('session.rotate',jsonb_build_object('id',current_id,'lease',lease,'access_hash',repeat('c',64),'refresh_hash',repeat('d',64),'encrypted_state','v1.synthetic-rotated-provider-state'));
  if r?'error' or (r->>'absolute_expires_at')::timestamptz<>deadline then raise exception 'Refresh extended absolute lifetime'; end if;
  if (public.owner_access_command('session.verify',jsonb_build_object('access_hash',repeat('a',64)))->>'error')<>'INVALID_PROOF' then raise exception 'Old access survived rotation'; end if;
  if public.owner_access_command('session.verify',jsonb_build_object('access_hash',repeat('c',64)))?'error' then raise exception 'Rotated access rejected'; end if;
  r:=public.owner_access_command('session.claim_refresh',jsonb_build_object('refresh_hash',repeat('b',64),'lease',lease));
  if r->>'error'<>'INVALID_PROOF' or not exists(select 1 from public.owner_access_sessions where id=current_id and revoked_at is not null) then raise exception 'Refresh replay did not revoke family'; end if;
  insert into owner_probe_results values('refresh rotation preserves deadline and invalidates old access',true),('replayed refresh revokes its whole application session family',true);
end; $$;

-- Recovery code consumption itself has no native side effects. Its phase must be
-- persisted before any real provider reset; native operations are HTTP-mock tested.
insert into public.owner_access_recovery(code_hash,owner_uid) values(repeat('9',64),'01010101-0101-4101-8101-010101010101');
insert into public.owner_access_challenges(challenge_hash,kind,owner_uid,native_session_id,encrypted_state,email_proved_at,expires_at,processing_lease,processing_until)
values(repeat('4',64),'login','01010101-0101-4101-8101-010101010101','05050505-0505-4505-8505-050505050505','v1.synthetic-recovery-provider-state',now(),now()+interval '5 minutes','15151515-1515-4515-8515-151515151515',now()+interval '45 seconds');
do $$
declare r jsonb; p jsonb;
begin
  p:=jsonb_build_object('challenge_hash',repeat('4',64),'lease','15151515-1515-4515-8515-151515151515','code_hash',repeat('9',64),'ip_hash',repeat('d',64),'device','Synthetic SQL probe');
  r:=public.owner_access_command('recovery.consume',p);
  if r?'error' or r->>'kind'<>'recovery' or not exists(select 1 from public.owner_access_recovery where code_hash=repeat('9',64) and used_at is not null) then raise exception 'Recovery proof not atomically persisted'; end if;
  r:=public.owner_access_command('recovery.consume',p);
  if r->>'error'<>'INVALID_PROOF' then raise exception 'Recovery code reused'; end if;
  if not exists(select 1 from public.owner_access_log where event='recovery_started') then raise exception 'Recovery audit missing'; end if;
  insert into owner_probe_results values('hashed recovery code consumed once with resumable phase and audit',true);
end; $$;

-- A raw client AAL2 JWT/factor cannot select its own approved factor. Change only
-- synthetic native rows and assert every access check consults their current state.
insert into public.owner_access_sessions(owner_uid,native_session_id,factor_id,access_hash,refresh_hash,encrypted_state,expires_at,absolute_expires_at)
values('01010101-0101-4101-8101-010101010101','04040404-0404-4404-8404-040404040404','02020202-0202-4202-8202-020202020202',repeat('e',64),repeat('f',64),'v1.synthetic-native-policy-provider-state',now()+interval '15 minutes',now()+interval '1 hour');
do $$
declare r jsonb;
begin
  update auth.sessions set factor_id='03030303-0303-4303-8303-030303030303' where id='04040404-0404-4404-8404-040404040404';
  r:=public.owner_access_command('session.verify',jsonb_build_object('access_hash',repeat('e',64)));
  if r->>'error'<>'INVALID_PROOF' then raise exception 'Unapproved native factor accepted'; end if;
  update auth.sessions set factor_id='02020202-0202-4202-8202-020202020202' where id='04040404-0404-4404-8404-040404040404';
  update auth.users set banned_until=now()+interval '1 hour' where id='01010101-0101-4101-8101-010101010101';
  if (public.owner_access_command('session.verify',jsonb_build_object('access_hash',repeat('e',64)))->>'error')<>'INVALID_PROOF' then raise exception 'Banned owner accepted'; end if;
  update auth.users set banned_until=null where id='01010101-0101-4101-8101-010101010101';
  delete from auth.sessions where id='04040404-0404-4404-8404-040404040404';
  if (public.owner_access_command('session.verify',jsonb_build_object('access_hash',repeat('e',64)))->>'error')<>'INVALID_PROOF' then raise exception 'Revoked native session accepted'; end if;
  insert into owner_probe_results values('unapproved factor, banned owner and revoked native session fail closed immediately',true);
end; $$;

select jsonb_build_object('passed',count(*),'checks',jsonb_agg(name order by name),'allPassed',bool_and(passed),'transaction','ROLLBACK ONLY') as owner_access_probe_summary from owner_probe_results;
rollback;
