begin;

create table public.uf_telegram_subscriptions (
  chat_id bigint primary key check (chat_id between 1 and 9007199254740991),
  group_id text,
  subgroup text,
  binding uuid not null default gen_random_uuid(),
  last_update_id bigint not null,
  updated_at timestamptz not null default now(),
  check ((group_id is null and subgroup is null) or (group_id is not null and subgroup is not null))
);
create index uf_telegram_subscriptions_scope on public.uf_telegram_subscriptions(group_id,subgroup)
  where group_id is not null;

create table public.uf_telegram_outbox (
  id uuid primary key default gen_random_uuid(),
  chat_id bigint not null,
  binding uuid not null,
  group_id text not null,
  lesson_id text not null,
  original_date text not null,
  revision integer not null,
  payload jsonb not null,
  state text not null default 'pending' check (state in ('pending','sent','discarded')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  lease_until timestamptz,
  lease_token uuid,
  created_at timestamptz not null default now(),
  unique (revision,lesson_id,original_date,chat_id)
);
create index uf_telegram_outbox_ready on public.uf_telegram_outbox(available_at,created_at,id)
  where state='pending';
create index uf_telegram_outbox_pending_occurrence on public.uf_telegram_outbox(lesson_id,original_date)
  where state='pending';
create index uf_telegram_outbox_chat_lease on public.uf_telegram_outbox(chat_id,lease_until)
  where state='pending' and lease_until is not null;
create index uf_telegram_outbox_age on public.uf_telegram_outbox(created_at);

alter table public.uf_telegram_subscriptions enable row level security;
alter table public.uf_telegram_outbox enable row level security;
revoke all on public.uf_telegram_subscriptions,public.uf_telegram_outbox from public,anon,authenticated;
grant select,insert,update,delete on public.uf_telegram_subscriptions,public.uf_telegram_outbox to service_role;

create function public.uf_telegram_active_group(p_group jsonb)
returns boolean language sql immutable security invoker set search_path='' as $$
  select p_group is not null and not (
    coalesce(p_group->'deleted' = 'true'::jsonb,false)
    or coalesce(p_group->>'deletedAt','') <> ''
    or coalesce(p_group->>'deleted_at','') <> ''
    or p_group->>'status' is not distinct from 'deleted'
  ) and case when p_group ? 'archivedAt' then p_group->'archivedAt' = 'null'::jsonb
             else not (
               coalesce(p_group->'archived' = 'true'::jsonb,false)
               or coalesce(p_group->>'archived_at','') <> ''
               or p_group->>'status' is not distinct from 'archived'
             ) end;
$$;

-- A later explicit action wins even when Telegram retries an older update.
-- Telegram may choose a new update ID after a week without updates.
create function public.uf_telegram_subscription(
  p_chat_id bigint,p_update_id bigint default null,p_group_id text default null,p_subgroup text default null
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare selected_group jsonb; existing public.uf_telegram_subscriptions;
begin
  if p_chat_id is null or p_chat_id not between 1 and 9007199254740991
     or (p_update_id is not null and p_update_id not between 0 and 9007199254740991)
     or (p_group_id is null) <> (p_subgroup is null)
     or (p_group_id is not null and (
       length(p_group_id) not between 1 and 160
       or length(p_subgroup) not between 1 and 80
       or p_update_id is null
     )) then raise exception 'invalid_telegram_subscription'; end if;
  if p_update_id is not null then
    if p_group_id is not null then
      select g.value into selected_group
      from public.uf_platform p
      cross join lateral jsonb_array_elements(p.data->'groups') g(value)
      where p.id=1 and g.value->>'id'=p_group_id
      for share of p;
      if not coalesce(public.uf_telegram_active_group(selected_group),false)
         or (p_subgroup <> 'all' and not coalesce(selected_group->'subgroups' ? p_subgroup,false))
      then raise exception 'unknown_telegram_subscription_scope'; end if;
    end if;
    insert into public.uf_telegram_subscriptions as s(chat_id,group_id,subgroup,last_update_id)
      values (p_chat_id,p_group_id,p_subgroup,p_update_id)
      on conflict (chat_id) do update
        set group_id=excluded.group_id,subgroup=excluded.subgroup,
            binding=case when (s.group_id,s.subgroup) is not distinct from (excluded.group_id,excluded.subgroup)
                         then s.binding else excluded.binding end,
            last_update_id=excluded.last_update_id,updated_at=now()
      where s.last_update_id <> excluded.last_update_id
        and (s.last_update_id < excluded.last_update_id or s.updated_at < now()-interval '7 days');
  end if;
  select * into existing from public.uf_telegram_subscriptions s where s.chat_id=p_chat_id;
  if existing.group_id is null then return null; end if;
  return jsonb_build_object('groupId',existing.group_id,'subgroup',existing.subgroup);
end;
$$;

-- Project only the public schedule fields that define a transfer or cancellation.
-- Audit notes and changes to display names never generate a new notification.
create function public.uf_telegram_occurrence(p_lesson jsonb,p_change jsonb)
returns jsonb language sql immutable security invoker set search_path='' as $$
  select case
    when p_change->>'status'='cancelled' then jsonb_build_object('status','cancelled')
    when p_change->>'status'='moved' then jsonb_build_object(
      'status','moved',
      'date',coalesce(nullif(p_change->>'targetDate',''),p_change->>'date'),
      'start',coalesce(p_change->>'start',p_lesson->>'start'),
      'end',coalesce(p_change->>'end',p_lesson->>'end'),
      'room',coalesce(p_change->>'roomId',p_lesson->>'roomId',''),
      'endDayOffset',coalesce(p_change->'endDayOffset',p_lesson->'endDayOffset','0'::jsonb)
    )
    else null
  end;
$$;

create function public.uf_telegram_enqueue_published_changes()
returns trigger language plpgsql security invoker set search_path='' as $$
declare inserted_count integer;
begin
  if new.revision <= old.revision
     or new.data->'exceptions' is not distinct from old.data->'exceptions' then return new; end if;

  with before_items as materialized (
    select item->>'lessonId' as lesson_id,item->>'date' as original_date,item
    from jsonb_array_elements(old.data->'exceptions') as a(item)
  ), after_items as materialized (
    select item->>'lessonId' as lesson_id,item->>'date' as original_date,item
    from jsonb_array_elements(new.data->'exceptions') as a(item)
  ), lessons as materialized (
    select item->>'id' as lesson_id,item
    from jsonb_array_elements(new.data->'lessons') as a(item)
  ), deltas as materialized (
    select lesson_id,original_date,l.item as lesson,a.item as change,n.current
    from before_items b full join after_items a using(lesson_id,original_date)
    left join lessons l using(lesson_id)
    cross join lateral (select public.uf_telegram_occurrence(l.item,a.item) as current) n
    where n.current is distinct from public.uf_telegram_occurrence(l.item,b.item)
  ), retire as (
    update public.uf_telegram_outbox o
    set state='discarded',lease_token=null,lease_until=null
    from deltas d where o.state='pending' and o.lesson_id=d.lesson_id and o.original_date=d.original_date
    returning o.id
  )
  insert into public.uf_telegram_outbox(chat_id,binding,group_id,lesson_id,original_date,revision,payload)
    select s.chat_id,s.binding,s.group_id,d.lesson_id,d.original_date,new.revision,
      jsonb_build_object(
        'status',d.current->>'status',
        'groupName',g.item->>'name',
        'subject',coalesce(subject.item->>'name',d.lesson->>'subjectId'),
        'subgroup',coalesce(nullif(d.lesson->>'subgroup',''),'all'),
        'originalDate',d.original_date,
        'originalStart',d.lesson->>'start',
        'originalEnd',d.lesson->>'end',
        'originalRoom',coalesce(before_room.item->>'name',''),
        'date',d.current->>'date',
        'start',d.current->>'start',
        'end',d.current->>'end',
        'room',coalesce(after_room.item->>'name','')
      )
    from deltas d
    join public.uf_telegram_subscriptions s on s.group_id=d.lesson->>'groupId'
      and (s.subgroup='all' or coalesce(nullif(d.lesson->>'subgroup',''),'all') in ('all',s.subgroup))
    join lateral jsonb_array_elements(new.data->'groups') g(item)
      on g.item->>'id'=s.group_id and public.uf_telegram_active_group(g.item)
    left join lateral jsonb_array_elements(new.data->'subjects') subject(item)
      on subject.item->>'id'=d.lesson->>'subjectId'
    left join lateral jsonb_array_elements(new.data->'rooms') before_room(item)
      on before_room.item->>'id'=d.lesson->>'roomId'
    left join lateral jsonb_array_elements(new.data->'rooms') after_room(item)
      on after_room.item->>'id'=d.current->>'room'
    where d.current is not null
      and greatest(d.original_date, d.current->>'date') >= to_char(now() at time zone 'Asia/Almaty','YYYY-MM-DD')
      and (
        d.current->>'status'='cancelled'
        or (d.current->>'date',d.current->>'start',d.current->>'end',d.current->>'room',d.current->'endDayOffset')
          is distinct from (d.original_date,d.lesson->>'start',d.lesson->>'end',coalesce(d.lesson->>'roomId',''),coalesce(d.lesson->'endDayOffset','0'::jsonb))
      )
    on conflict (revision,lesson_id,original_date,chat_id) do nothing;
  get diagnostics inserted_count=row_count;
  if inserted_count > 0 and to_regprocedure('public.uf_telegram_wake_notifications()') is not null then
    begin
      execute 'select public.uf_telegram_wake_notifications()';
    exception when others then
      -- The durable delivery remains queued for the scheduled retry.
      null;
    end;
  end if;
  return new;
end;
$$;

create trigger uf_telegram_on_publication after update of data on public.uf_platform
  for each row execute function public.uf_telegram_enqueue_published_changes();

create function public.uf_telegram_claim_notifications(p_limit integer)
returns table(id uuid,lease_token uuid,chat_id bigint,attempts integer,payload jsonb)
language plpgsql security invoker set search_path='' as $$
begin
  if p_limit is null or p_limit not between 1 and 12 then raise exception 'invalid_notification_batch'; end if;
  -- Serialize the short lease selection to avoid simultaneous deliveries to one chat.
  if not pg_try_advisory_xact_lock(44982040,1) then return; end if;
  return query
    with heads as materialized (
      select distinct on (o.chat_id) o.id,o.available_at,o.created_at
      from public.uf_telegram_outbox o
      join public.uf_telegram_subscriptions s on s.chat_id=o.chat_id and s.binding=o.binding
      where o.state='pending' and o.available_at <= now() and o.attempts < 8
        and greatest(o.original_date,o.payload->>'date') >= to_char(now() at time zone 'Asia/Almaty','YYYY-MM-DD')
        and s.group_id=o.group_id and (o.lease_until is null or o.lease_until <= now())
        and not exists (
          select 1 from public.uf_telegram_outbox active
          where active.chat_id=o.chat_id and active.state='pending' and active.lease_until>now()
        )
        and exists (
          select 1 from public.uf_platform p
          cross join lateral jsonb_array_elements(p.data->'groups') g(item)
          where p.id=1 and g.item->>'id'=s.group_id and public.uf_telegram_active_group(g.item)
        )
      order by o.chat_id,o.available_at,o.created_at,o.id
    ), picked as (
      select o.id from public.uf_telegram_outbox o join heads h on h.id=o.id
      order by h.available_at,h.created_at,h.id limit p_limit for update of o skip locked
    )
    update public.uf_telegram_outbox o
      set attempts=o.attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes'
      from picked p where o.id=p.id and o.state='pending'
      returning o.id,o.lease_token,o.chat_id,o.attempts,o.payload;
end;
$$;

create function public.uf_telegram_finish_notification(
  p_id uuid,p_lease_token uuid,p_outcome text,p_delay_seconds integer
) returns boolean language plpgsql security invoker set search_path='' as $$
declare job public.uf_telegram_outbox;
begin
  if p_outcome is null or p_outcome not in ('sent','retry','discard','blocked')
     or p_delay_seconds is null or p_delay_seconds not between 0 and 86400
     or (p_outcome='retry' and p_delay_seconds=0) then raise exception 'invalid_notification_outcome'; end if;
  update public.uf_telegram_outbox o
    set state=case when p_outcome='sent' then 'sent'
                   when p_outcome='retry' and o.attempts<8 then 'pending'
                   else 'discarded' end,
        available_at=now()+make_interval(secs=>p_delay_seconds),
        lease_token=null,lease_until=null
    where o.id=p_id and o.state='pending' and o.lease_token=p_lease_token
    returning o.* into job;
  if not found then return false; end if;
  if p_outcome='blocked' then
    update public.uf_telegram_subscriptions s
      set group_id=null,subgroup=null,binding=gen_random_uuid(),updated_at=now()
      where s.chat_id=job.chat_id and s.binding=job.binding;
  end if;
  return true;
end;
$$;

create function public.uf_telegram_prune_notifications()
returns void language sql security invoker set search_path='' as $$
  delete from public.uf_telegram_outbox where created_at < now()-interval '7 days';
  delete from public.uf_telegram_subscriptions where group_id is null and updated_at < now()-interval '7 days';
$$;

revoke all on function
  public.uf_telegram_active_group(jsonb),
  public.uf_telegram_subscription(bigint,bigint,text,text),
  public.uf_telegram_occurrence(jsonb,jsonb),
  public.uf_telegram_enqueue_published_changes(),
  public.uf_telegram_claim_notifications(integer),
  public.uf_telegram_finish_notification(uuid,uuid,text,integer),
  public.uf_telegram_prune_notifications()
from public,anon,authenticated;
grant execute on function
  public.uf_telegram_active_group(jsonb),
  public.uf_telegram_subscription(bigint,bigint,text,text),
  public.uf_telegram_occurrence(jsonb,jsonb),
  public.uf_telegram_enqueue_published_changes(),
  public.uf_telegram_claim_notifications(integer),
  public.uf_telegram_finish_notification(uuid,uuid,text,integer),
  public.uf_telegram_prune_notifications()
to service_role;

commit;
