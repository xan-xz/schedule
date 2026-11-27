begin;

create table public.uf_telegram_support_owner (
  singleton boolean primary key default true check (singleton),
  chat_id bigint not null check (chat_id between 1 and 9007199254740991)
);

create table public.uf_telegram_support_drafts (
  chat_id bigint primary key check (chat_id between 1 and 9007199254740991),
  id uuid not null default gen_random_uuid(),
  group_id text check (length(group_id) between 1 and 160),
  language text not null check (language in ('ru','kk')),
  expires_at timestamptz not null default now()+interval '30 minutes'
);

-- Message text stays in Telegram. Only retain the IDs needed to route a reply
-- and identify retries from Telegram.
create table public.uf_telegram_support_deliveries (
  id uuid primary key default gen_random_uuid(),
  update_id bigint not null unique check (update_id between 0 and 9007199254740991),
  student_chat_id bigint not null check (student_chat_id between 1 and 9007199254740991),
  owner_chat_id bigint not null check (owner_chat_id between 1 and 9007199254740991),
  draft_id uuid unique,
  reply_to uuid references public.uf_telegram_support_deliveries(id),
  group_id text,
  language text not null check (language in ('ru','kk')),
  message_id bigint check (message_id between 1 and 9007199254740991),
  delivered_at timestamptz,
  lease_token uuid not null default gen_random_uuid(),
  lease_until timestamptz not null default now()+interval '45 seconds',
  created_at timestamptz not null default now(),
  check ((draft_id is null) <> (reply_to is null)),
  check (message_id is null or (draft_id is not null and delivered_at is not null))
);

create unique index uf_telegram_support_reply_lookup
  on public.uf_telegram_support_deliveries(owner_chat_id,message_id)
  where draft_id is not null and message_id is not null;
create index uf_telegram_support_recent_reports
  on public.uf_telegram_support_deliveries(student_chat_id,created_at)
  where draft_id is not null and message_id is not null;
create index uf_telegram_support_replies_by_report
  on public.uf_telegram_support_deliveries(reply_to) where reply_to is not null;

alter table public.uf_telegram_support_owner enable row level security;
alter table public.uf_telegram_support_drafts enable row level security;
alter table public.uf_telegram_support_deliveries enable row level security;
revoke all on public.uf_telegram_support_owner,public.uf_telegram_support_drafts,
  public.uf_telegram_support_deliveries from public,anon,authenticated;
grant select,insert on public.uf_telegram_support_owner to service_role;
grant select,insert,update,delete on public.uf_telegram_support_drafts,
  public.uf_telegram_support_deliveries to service_role;

create function public.uf_telegram_support(
  p_action text,p_chat_id bigint default null,p_update_id bigint default null,
  p_group_id text default null,p_language text default null,
  p_report_id uuid default null,p_message_id bigint default null,
  p_lease_token uuid default null
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  owner_chat bigint;
  draft public.uf_telegram_support_drafts;
  delivery public.uf_telegram_support_deliveries;
  report public.uf_telegram_support_deliveries;
begin
  if (p_chat_id is not null and p_chat_id not between 1 and 9007199254740991)
     or (p_update_id is not null and p_update_id not between 0 and 9007199254740991)
     or (p_message_id is not null and p_message_id not between 1 and 9007199254740991)
     or (p_group_id is not null and length(p_group_id) not between 1 and 160)
  then raise exception 'invalid_telegram_support_request'; end if;

  if p_action='bind' and p_chat_id is not null then
    insert into public.uf_telegram_support_owner(chat_id) values(p_chat_id)
    on conflict (singleton) do nothing;
    return to_jsonb(exists(select 1 from public.uf_telegram_support_owner where chat_id=p_chat_id));
  end if;

  select chat_id into owner_chat from public.uf_telegram_support_owner where singleton;

  if p_action='status' and p_chat_id is not null then
    select * into draft from public.uf_telegram_support_drafts
    where chat_id=p_chat_id and expires_at>now();
    return jsonb_build_object('ownerChatId',owner_chat::text,'pending',
      case when draft.id is not null then jsonb_build_object('groupId',draft.group_id,'language',draft.language) end);
  elsif p_action='begin' and p_chat_id is not null and p_language in ('ru','kk') then
    if owner_chat is null then return to_jsonb(false); end if;
    insert into public.uf_telegram_support_drafts as d(chat_id,group_id,language)
      values(p_chat_id,p_group_id,p_language)
    on conflict (chat_id) do update set id=excluded.id,group_id=excluded.group_id,
      language=excluded.language,expires_at=excluded.expires_at;
    return to_jsonb(true);
  elsif p_action='cancel' and p_chat_id is not null then
    delete from public.uf_telegram_support_drafts where chat_id=p_chat_id;
    return to_jsonb(found);
  elsif p_action='claim' and p_chat_id is not null and p_update_id is not null then
    if owner_chat is null then return jsonb_build_object('code','unavailable'); end if;
    select * into draft from public.uf_telegram_support_drafts
      where chat_id=p_chat_id for update;
    select * into delivery from public.uf_telegram_support_deliveries
      where update_id=p_update_id;
    if delivery.id is not null and (
      delivery.student_chat_id<>p_chat_id or delivery.draft_id is null or delivery.message_id is not null
    ) then return jsonb_build_object('code','duplicate'); end if;
    if draft.id is null or draft.expires_at<=now()
       or (delivery.id is not null and delivery.draft_id<>draft.id)
    then return jsonb_build_object('code','inactive'); end if;

    select * into delivery from public.uf_telegram_support_deliveries
      where draft_id=draft.id for update;
    if delivery.message_id is not null then return jsonb_build_object('code','duplicate'); end if;
    if delivery.lease_until>now() then return jsonb_build_object('code','busy'); end if;
    if exists(select 1 from public.uf_telegram_support_deliveries
      where student_chat_id=p_chat_id and draft_id is not null and message_id is not null
        and created_at>now()-interval '15 seconds')
    then return jsonb_build_object('code','rate_limited'); end if;

    if delivery.id is not null and delivery.update_id<>p_update_id then
      delete from public.uf_telegram_support_deliveries where id=delivery.id;
      delivery.id:=null;
    end if;
    if delivery.id is null then
      insert into public.uf_telegram_support_deliveries(
        update_id,student_chat_id,owner_chat_id,draft_id,group_id,language
      ) values(p_update_id,p_chat_id,owner_chat,draft.id,draft.group_id,draft.language)
      returning * into delivery;
    else
      update public.uf_telegram_support_deliveries
        set lease_token=gen_random_uuid(),lease_until=now()+interval '45 seconds'
        where id=delivery.id returning * into delivery;
    end if;
    return jsonb_build_object('code','claimed','reportId',delivery.id,'leaseToken',delivery.lease_token,
      'ownerChatId',owner_chat::text,'groupId',delivery.group_id,'language',delivery.language);
  elsif p_action='route_reply' and p_chat_id is not null and p_message_id is not null and p_update_id is not null then
    if owner_chat is distinct from p_chat_id then return jsonb_build_object('code','inactive'); end if;
    select * into report from public.uf_telegram_support_deliveries
      where owner_chat_id=p_chat_id and message_id=p_message_id and draft_id is not null
      for update;
    if report.id is null then return jsonb_build_object('code','inactive'); end if;
    select * into delivery from public.uf_telegram_support_deliveries
      where update_id=p_update_id for update;
    if delivery.id is not null and (delivery.reply_to is distinct from report.id or delivery.delivered_at is not null)
    then return jsonb_build_object('code','duplicate'); end if;
    if delivery.lease_until>now() then return jsonb_build_object('code','busy'); end if;

    if delivery.id is null then
      insert into public.uf_telegram_support_deliveries(update_id,student_chat_id,owner_chat_id,reply_to,language)
        values(p_update_id,report.student_chat_id,p_chat_id,report.id,report.language)
        returning * into delivery;
    else
      update public.uf_telegram_support_deliveries
        set lease_token=gen_random_uuid(),lease_until=now()+interval '45 seconds'
        where id=delivery.id returning * into delivery;
    end if;
    return jsonb_build_object('code','claimed','reportId',report.id,'leaseToken',delivery.lease_token,
      'chatId',report.student_chat_id::text,'language',report.language);
  elsif p_action='complete' and p_report_id is not null and p_message_id is not null and p_lease_token is not null then
    select * into delivery from public.uf_telegram_support_deliveries where id=p_report_id and draft_id is not null;
    -- Acquire the draft lock before the delivery lock, in the same order as claim.
    perform 1 from public.uf_telegram_support_drafts where chat_id=delivery.student_chat_id for update;
    update public.uf_telegram_support_deliveries
      set message_id=p_message_id,delivered_at=coalesce(delivered_at,now())
      where id=p_report_id and draft_id is not null
        and lease_token=p_lease_token and (message_id is null or message_id=p_message_id)
      returning * into delivery;
    if not found then return to_jsonb(false); end if;
    delete from public.uf_telegram_support_drafts where chat_id=delivery.student_chat_id and id=delivery.draft_id;
    return to_jsonb(true);
  elsif p_action='complete_reply' and p_update_id is not null and p_lease_token is not null then
    -- Acknowledgement only. Reply Telegram IDs are never used for routing.
    update public.uf_telegram_support_deliveries set delivered_at=coalesce(delivered_at,now())
      where update_id=p_update_id and reply_to is not null and lease_token=p_lease_token;
    return to_jsonb(found);
  elsif p_action='release' and p_report_id is not null and p_lease_token is not null then
    delete from public.uf_telegram_support_deliveries
      where id=p_report_id and draft_id is not null and message_id is null and lease_token=p_lease_token;
    return to_jsonb(found);
  elsif p_action='release_reply' and p_update_id is not null and p_lease_token is not null then
    delete from public.uf_telegram_support_deliveries
      where update_id=p_update_id and reply_to is not null and delivered_at is null and lease_token=p_lease_token;
    return to_jsonb(found);
  end if;
  raise exception 'invalid_telegram_support_request';
end;
$$;

revoke all on function public.uf_telegram_support(text,bigint,bigint,text,text,uuid,bigint,uuid) from public,anon,authenticated;
grant execute on function public.uf_telegram_support(text,bigint,bigint,text,text,uuid,bigint,uuid) to service_role;

commit;
