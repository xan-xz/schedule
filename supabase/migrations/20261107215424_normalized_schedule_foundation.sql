-- Additive private store. This does not switch the active timetable writer.
-- Import is one-shot; the compatibility document and native owner Auth remain untouched.
begin;
create schema uniflow_data;
revoke all on schema uniflow_data from public,anon,authenticated;
grant usage on schema uniflow_data to service_role;
alter default privileges in schema uniflow_data revoke all on tables from public,anon,authenticated;
alter default privileges in schema uniflow_data revoke execute on functions from public,anon,authenticated;

create table uniflow_data.documents (
  id smallint primary key check(id=1),
  format text not null check(format='uniflow-normalized-v1'),
  source_revision bigint not null check(source_revision>0),
  root_keys jsonb not null check(jsonb_typeof(root_keys)='array'),
  root_payload jsonb not null check(jsonb_typeof(root_payload)='object'),
  collections jsonb not null check(jsonb_typeof(collections)='array'),
  is_live boolean not null default false,
  catalog_revision bigint not null default 1 check(catalog_revision>0),
  imported_at timestamptz not null default now()
);

do $tables$
declare target_name text;
begin
  foreach target_name in array array[
    'groups','subjects','rooms','teachers','lessons','overrides',
    'tasks','announcements','holidays','audit_log'
  ] loop
    execute format('create table uniflow_data.%I (
      row_key text primary key,
      source_id text unique,
      position integer not null check(position>=0),
      revision bigint not null default 1 check(revision>0),
      group_ids text[] not null default array[]::text[],
      indexes jsonb not null default ''{}''::jsonb check(jsonb_typeof(indexes)=''object''),
      payload jsonb not null,
      check(source_id is null or (payload->>''id'') is not distinct from source_id),
      unique(position) deferrable initially deferred
    )',target_name);
    execute format('create index %I on uniflow_data.%I using gin(group_ids)',target_name||'_scope_idx',target_name);
  end loop;
end
$tables$;

do $identities$
declare target_name text;
begin
  foreach target_name in array array['groups','subjects','rooms','teachers','lessons','tasks','announcements'] loop
    execute format('alter table uniflow_data.%I add check(length(source_id)>0 and row_key=source_id)',target_name);
  end loop;
end
$identities$;

alter table uniflow_data.groups alter column source_id set not null;
alter table uniflow_data.subjects alter column source_id set not null;
alter table uniflow_data.rooms alter column source_id set not null;
alter table uniflow_data.teachers alter column source_id set not null;
alter table uniflow_data.lessons alter column source_id set not null;
alter table uniflow_data.tasks alter column source_id set not null;
alter table uniflow_data.announcements alter column source_id set not null;
alter table uniflow_data.groups add column name text generated always as(payload->>'name') stored;
alter table uniflow_data.subjects add column name text generated always as(payload->>'name') stored;
alter table uniflow_data.rooms add column name text generated always as(payload->>'name') stored;
alter table uniflow_data.teachers add column name text generated always as(payload->>'name') stored;

create table uniflow_data.subgroups (
  row_key text primary key, group_id text not null,
  name text not null, position integer not null check(position>=0), payload jsonb not null,
  unique(group_id,name),
  foreign key(group_id) references uniflow_data.groups(source_id) deferrable initially deferred
);
create table uniflow_data.time_slots (
  row_key text primary key, position integer not null check(position>=0), payload jsonb not null,
  start_time text generated always as(payload->>'start') stored,
  end_time text generated always as(payload->>'end') stored,
  end_day_offset smallint generated always as((payload->>'endDayOffset')::smallint) stored,
  unique(position) deferrable initially deferred
);
create table uniflow_data.lesson_types (
  row_key text primary key, position integer not null check(position>=0), payload jsonb not null,
  name text generated always as(payload->>'name') stored,
  unique(position) deferrable initially deferred
);
create table uniflow_data.teacher_subjects (
  teacher_id text not null references uniflow_data.teachers(source_id) deferrable initially deferred,
  subject_id text not null references uniflow_data.subjects(source_id) deferrable initially deferred,
  primary key(teacher_id,subject_id)
);
create index teacher_subjects_subject_idx on uniflow_data.teacher_subjects(subject_id);

alter table uniflow_data.lessons
  add column group_id text generated always as(payload->>'groupId') stored not null,
  add column subject_id text generated always as(payload->>'subjectId') stored not null,
  add column teacher_id text generated always as(nullif(payload->>'teacherId','')) stored,
  add column room_id text generated always as(nullif(payload->>'roomId','')) stored,
  add column subgroup text generated always as(payload->>'subgroup') stored not null,
  add column subgroup_name text generated always as(nullif(payload->>'subgroup','all')) stored,
  add column day smallint generated always as((payload->>'day')::smallint) stored not null check(day between 0 and 6),
  add column start_time text generated always as(payload->>'start') stored not null,
  add column end_time text generated always as(payload->>'end') stored not null,
  add column week text generated always as(payload->>'week') stored not null check(week in ('all','odd','even')),
  add column shared_session_id text generated always as(nullif(payload->>'sharedSessionId','')) stored,
  add column time_slot_key text generated always as(indexes->>'timeSlotKey') stored,
  add column lesson_type_key text generated always as(indexes->>'lessonTypeKey') stored,
  add foreign key(group_id) references uniflow_data.groups(source_id) deferrable initially deferred,
  add foreign key(group_id,subgroup_name) references uniflow_data.subgroups(group_id,name) deferrable initially deferred,
  add foreign key(subject_id) references uniflow_data.subjects(source_id) deferrable initially deferred,
  add foreign key(teacher_id) references uniflow_data.teachers(source_id) deferrable initially deferred,
  add foreign key(room_id) references uniflow_data.rooms(source_id) deferrable initially deferred,
  add foreign key(time_slot_key) references uniflow_data.time_slots(row_key) deferrable initially deferred,
  add foreign key(lesson_type_key) references uniflow_data.lesson_types(row_key) deferrable initially deferred;
create index lessons_group_day_time_idx on uniflow_data.lessons(group_id,day,start_time);
create index lessons_group_subgroup_idx on uniflow_data.lessons(group_id,subgroup_name);
create index lessons_subject_idx on uniflow_data.lessons(subject_id);
create index lessons_teacher_day_time_idx on uniflow_data.lessons(teacher_id,day,start_time);
create index lessons_room_day_time_idx on uniflow_data.lessons(room_id,day,start_time);
create index lessons_slot_idx on uniflow_data.lessons(time_slot_key);
create index lessons_type_idx on uniflow_data.lessons(lesson_type_key);
create index lessons_shared_idx on uniflow_data.lessons(shared_session_id);

alter table uniflow_data.overrides
  add column lesson_id text generated always as(payload->>'lessonId') stored not null,
  add column date text generated always as(payload->>'date') stored not null,
  add column target_date text generated always as(payload->>'targetDate') stored,
  add column subject_id text generated always as(nullif(payload->>'subjectId','')) stored,
  add column teacher_id text generated always as(nullif(payload->>'teacherId','')) stored,
  add column room_id text generated always as(nullif(payload->>'roomId','')) stored,
  add foreign key(subject_id) references uniflow_data.subjects(source_id) deferrable initially deferred,
  add foreign key(teacher_id) references uniflow_data.teachers(source_id) deferrable initially deferred,
  add foreign key(room_id) references uniflow_data.rooms(source_id) deferrable initially deferred,
  add foreign key(lesson_id) references uniflow_data.lessons(source_id) deferrable initially deferred;
create unique index overrides_lesson_date_idx on uniflow_data.overrides(lesson_id,date);
create index overrides_target_date_idx on uniflow_data.overrides(target_date);
create index overrides_subject_idx on uniflow_data.overrides(subject_id);
create index overrides_teacher_idx on uniflow_data.overrides(teacher_id);
create index overrides_room_idx on uniflow_data.overrides(room_id);

alter table uniflow_data.tasks
  add column group_id text generated always as(payload->>'groupId') stored not null,
  add column subject_id text generated always as(payload->>'subjectId') stored not null,
  add column due text generated always as(payload->>'due') stored not null,
  add column subgroup_name text generated always as(nullif(payload->>'subgroup','all')) stored,
  add foreign key(group_id) references uniflow_data.groups(source_id) deferrable initially deferred,
  add foreign key(group_id,subgroup_name) references uniflow_data.subgroups(group_id,name) deferrable initially deferred,
  add foreign key(subject_id) references uniflow_data.subjects(source_id) deferrable initially deferred;
create index tasks_group_due_idx on uniflow_data.tasks(group_id,due);
create index tasks_group_subgroup_idx on uniflow_data.tasks(group_id,subgroup_name);
create index tasks_subject_idx on uniflow_data.tasks(subject_id);

alter table uniflow_data.announcements
  add column group_id text generated always as(nullif(payload->>'groupId','')) stored,
  add foreign key(group_id) references uniflow_data.groups(source_id) deferrable initially deferred;
create index announcements_group_idx on uniflow_data.announcements(group_id);
alter table uniflow_data.holidays
  add column group_id text generated always as(nullif(payload->>'groupId','')) stored,
  add foreign key(group_id) references uniflow_data.groups(source_id) deferrable initially deferred;
create index holidays_group_idx on uniflow_data.holidays(group_id);

create table uniflow_data.extension_records (
  collection text not null, row_key text not null, source_id text,
  position integer not null check(position>=0), revision bigint not null check(revision>0),
  group_ids text[] not null default array[]::text[],
  indexes jsonb not null default '{}'::jsonb, payload jsonb not null,
  primary key(collection,row_key), unique(collection,position) deferrable initially deferred
);
create index extension_records_scope_idx on uniflow_data.extension_records using gin(group_ids);
create table uniflow_data.group_revisions (
  group_id text primary key references uniflow_data.groups(source_id) deferrable initially deferred,
  revision bigint not null default 1 check(revision>0), updated_at timestamptz not null default now()
);
create table uniflow_data.revisions (
  id bigint generated always as identity primary key,
  group_id text, entity_type text not null, entity_key text not null,
  revision bigint not null check(revision>0), actor text not null,
  before_payload jsonb, after_payload jsonb, reason text not null,
  created_at timestamptz not null default now()
);
create index revisions_group_entity_idx on uniflow_data.revisions(group_id,entity_type,entity_key,revision desc);
create table uniflow_data.site_settings (
  key text primary key, revision bigint not null default 1 check(revision>0),
  payload jsonb not null, updated_at timestamptz not null default now()
);
create table uniflow_data.support_tickets (
  id uuid primary key default gen_random_uuid(), receipt_hash text not null unique,
  group_id text references uniflow_data.groups(source_id) deferrable initially deferred,
  category text not null, body text not null, contact text,
  status text not null default 'new' check(status in ('new','in_progress','resolved','spam')),
  revision bigint not null default 1 check(revision>0), metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index support_tickets_group_idx on uniflow_data.support_tickets(group_id);
create index support_tickets_status_date_idx on uniflow_data.support_tickets(status,created_at desc);

create function uniflow_data.collection_table(p_name text) returns text
language sql immutable strict security invoker set search_path='' as $$
  select case p_name
    when 'groups' then 'groups' when 'subjects' then 'subjects'
    when 'rooms' then 'rooms' when 'teachers' then 'teachers'
    when 'lessons' then 'lessons' when 'exceptions' then 'overrides'
    when 'tasks' then 'tasks' when 'announcements' then 'announcements'
    when 'holidays' then 'holidays' when 'history' then 'audit_log'
    else 'extension_records' end;
$$;

-- Match JavaScript's UTF-16 code-unit order, including non-BMP custom labels.
create function uniflow_data.utf16_sort_key(s text) returns integer[]
language sql immutable strict security invoker set search_path='' as $$
  select coalesce(array_agg(u.unit order by i.n,u.part),array[]::integer[])
  from generate_series(1,length(s)) i(n)
  cross join lateral (select ascii(substr(s,i.n,1)) as point) c
  cross join lateral (
    select case when c.point>65535 then 55296+(c.point-65536)/1024 else c.point end as unit,0 as part
    union all select 56320+(c.point-65536)%1024,1 where c.point>65535
  ) u;
$$;

create function uniflow_data.assert_snapshot(s jsonb) returns void
language plpgsql immutable security invoker set search_path='' as $$
declare r jsonb; c jsonb; k text; expected_indexes jsonb; expected_identity jsonb;
  expected_key text; expected_source text; expected_scope jsonb; expected_slot text;
  lesson_groups jsonb; manifest_count bigint; actual_count bigint; origin_payload jsonb;
begin
  if s->>'format' is distinct from 'uniflow-normalized-v1'
    or jsonb_typeof(s->'rootKeys') is distinct from 'array'
    or jsonb_typeof(s->'rootPayload') is distinct from 'object'
    or jsonb_typeof(s->'collections') is distinct from 'array'
    or jsonb_typeof(s->'records') is distinct from 'array'
    or jsonb_typeof(s->'derived') is distinct from 'object'
    or jsonb_typeof(s->'sourceRevision') is distinct from 'number'
    or (s->>'sourceRevision')::numeric not between 1 and 9007199254740991
    or mod((s->>'sourceRevision')::numeric,1)<>0 then raise exception 'invalid_normalized_document'; end if;
  if exists(select 1 from jsonb_array_elements(s->'rootKeys') x where jsonb_typeof(x)<>'string')
    or (select count(*)<>count(distinct value) from jsonb_array_elements(s->'rootKeys'))
    or (select count(*)<>count(distinct value->>'name') from jsonb_array_elements(s->'collections'))
    then raise exception 'duplicate_or_invalid_manifest'; end if;
  for c in select value from jsonb_array_elements(s->'collections') loop
    if jsonb_typeof(c->'name') is distinct from 'string'
      or c->>'table' is distinct from uniflow_data.collection_table(c->>'name')
      or not (s->'rootKeys' @> jsonb_build_array(c->'name'))
      or s->'rootPayload' ? (c->>'name')
      or jsonb_typeof(c->'count') is distinct from 'number'
      or (c->>'count')::numeric not between 0 and 1000000
      or mod((c->>'count')::numeric,1)<>0 then raise exception 'invalid_collection_manifest'; end if;
  end loop;
  for k in select jsonb_array_elements_text(s->'rootKeys') loop
    if not (s->'rootPayload' ? k) and not exists(
      select 1 from jsonb_array_elements(s->'collections') x where x->>'name'=k
    ) then raise exception 'missing_root_value'; end if;
  end loop;
  if exists(select 1 from jsonb_each(s->'rootPayload') x
    where not (s->'rootKeys' @> jsonb_build_array(x.key)) or jsonb_typeof(x.value)='array')
    then raise exception 'unmanifested_root_value'; end if;
  select coalesce(jsonb_object_agg(x->'payload'->>'id',x->'payload'->'groupId'),'{}') into lesson_groups
    from jsonb_array_elements(s->'records') x where x->>'collection'='lessons';
  select coalesce(sum((x->>'count')::bigint),0) into manifest_count from jsonb_array_elements(s->'collections') x;
  if manifest_count<>jsonb_array_length(s->'records') then raise exception 'normalized_total_count_mismatch'; end if;
  if exists(select 1 from jsonb_array_elements(s->'records') x group by x->>'collection',x->>'rowKey' having count(*)>1)
    or exists(select 1 from jsonb_array_elements(s->'records') x group by x->>'collection',x->>'position' having count(*)>1)
    then raise exception 'duplicate_normalized_record'; end if;
  for r in select value from jsonb_array_elements(s->'records') loop
    select value into c from jsonb_array_elements(s->'collections') x where x->>'name'=r->>'collection';
    if c is null or r->>'table' is distinct from c->>'table' or not (r ? 'payload')
      or jsonb_typeof(r->'rowKey') is distinct from 'string'
      or jsonb_typeof(r->'position') is distinct from 'number'
      or (r->>'position')::numeric not between 0 and (c->>'count')::numeric-1
      or mod((r->>'position')::numeric,1)<>0
      or jsonb_typeof(r->'revision') is distinct from 'number'
      or (r->>'revision')::numeric not between 1 and 9007199254740991
      or mod((r->>'revision')::numeric,1)<>0 then raise exception 'invalid_normalized_record'; end if;
    expected_source:=case when jsonb_typeof(r->'payload'->'id')='string' and length(r->'payload'->>'id')>0 then r->'payload'->>'id' end;
    if r->'sourceId' is distinct from coalesce(to_jsonb(expected_source),'null'::jsonb) then raise exception 'normalized_source_id_mismatch'; end if;
    if r->>'collection' in ('groups','teachers','subjects','rooms','lessons','tasks','announcements','requests') then
      if expected_source is null or r->>'rowKey'<>expected_source then raise exception 'normalized_identity_mismatch'; end if;
    else
      expected_identity:=case
        when r->>'collection' in ('exceptions','attendance','holidays','history') and expected_source is not null then jsonb_build_array('id',expected_source)
        when r->>'collection'='exceptions' and length(r->'payload'->>'lessonId')>0 and length(r->'payload'->>'date')>0 then jsonb_build_array('lesson-date',r->'payload'->>'lessonId',r->'payload'->>'date')
        when r->>'collection'='attendance' and length(r->'payload'->>'lessonId')>0 and length(r->'payload'->>'date')>0 and length(r->'payload'->>'studentId')>0 then jsonb_build_array('attendance',r->'payload'->>'lessonId',r->'payload'->>'date',r->'payload'->>'studentId')
        else jsonb_build_array('position',(r->>'position')::integer) end;
      select '['||string_agg(x.value::text,',' order by x.ordinality)||']' into expected_key from jsonb_array_elements(expected_identity) with ordinality x;
      if r->>'rowKey'<>expected_key then raise exception 'normalized_identity_mismatch'; end if;
    end if;
    expected_indexes:='{}';
    if jsonb_typeof(r->'payload')='object' and r->>'collection' in ('groups','subjects','rooms','teachers','lessons','exceptions','tasks','announcements','holidays','history','requests','attendance') then
      select coalesce(jsonb_object_agg(x.key,x.value),'{}') into expected_indexes from jsonb_each(r->'payload') x
        where x.key=any(array['groupId','lessonId','subjectId','teacherId','roomId','studentId','subgroup','day','start','end','endDayOffset','week','date','targetDate','sharedSessionId']);
      if r->>'collection'='groups' then expected_indexes:=expected_indexes||jsonb_build_object('groupId',expected_source); end if;
      if r->>'collection' in ('exceptions','requests','attendance') and jsonb_typeof(lesson_groups->(r->'payload'->>'lessonId'))='string' then
        expected_indexes:=expected_indexes||jsonb_build_object('groupId',lesson_groups->(r->'payload'->>'lessonId'));
      end if;
      if r->>'collection'='lessons' then
        if jsonb_typeof(r->'payload'->'start')='string' and jsonb_typeof(r->'payload'->'end')='string' then
          select '['||string_agg(x.value::text,',' order by x.ordinality)||']' into expected_slot
            from jsonb_array_elements(jsonb_build_array(r->'payload'->'start',r->'payload'->'end',coalesce(nullif(r->'payload'->'endDayOffset','null'::jsonb),'0'::jsonb))) with ordinality x;
          expected_indexes:=expected_indexes||jsonb_build_object('timeSlotKey',expected_slot);
        end if;
        if jsonb_typeof(r->'payload'->'type')='string' then expected_indexes:=expected_indexes||jsonb_build_object('lessonTypeKey',r->'payload'->'type'); end if;
      end if;
    end if;
    expected_scope:=case when r->>'collection' in ('groups','lessons','exceptions','tasks','announcements','requests','attendance','holidays')
      and jsonb_typeof(expected_indexes->'groupId')='string' and length(expected_indexes->>'groupId')>0 then jsonb_build_array(expected_indexes->'groupId') else '[]'::jsonb end;
    if r->'indexes' is distinct from expected_indexes or r->'groupIds' is distinct from expected_scope then raise exception 'normalized_projection_mismatch'; end if;
  end loop;
  for c in select value from jsonb_array_elements(s->'collections') loop
    select count(*) into actual_count from jsonb_array_elements(s->'records') x where x->>'collection'=c->>'name';
    if actual_count<>(c->>'count')::bigint then raise exception 'normalized_collection_count_mismatch'; end if;
  end loop;
  if jsonb_typeof(s->'derived'->'subgroups') is distinct from 'array'
    or jsonb_typeof(s->'derived'->'timeSlots') is distinct from 'array'
    or jsonb_typeof(s->'derived'->'lessonTypes') is distinct from 'array'
    then raise exception 'invalid_derived_collections'; end if;
  select count(*) into actual_count from (
    select distinct g->'payload'->>'id',v.value from jsonb_array_elements(s->'records') g
      cross join lateral jsonb_array_elements(g->'payload'->'subgroups') v
      where g->>'collection'='groups' and jsonb_typeof(v.value)='string'
  ) x;
  if actual_count<>jsonb_array_length(s->'derived'->'subgroups') then raise exception 'derived_subgroup_count_mismatch'; end if;
  for r in select value from jsonb_array_elements(s->'derived'->'subgroups') loop
    select x->'payload' into origin_payload from jsonb_array_elements(s->'records') x
      where x->>'collection'='groups' and x->'payload'->>'id'=r->>'groupId';
    select '['||string_agg(x.value::text,',' order by x.ordinality)||']' into expected_key
      from jsonb_array_elements(jsonb_build_array(r->>'groupId',r->>'name')) with ordinality x;
    if origin_payload is null or r->>'collection' is distinct from '@derived/subgroups'
      or r->>'table' is distinct from 'subgroups' or r->>'rowKey' is distinct from expected_key
      or r->'payload' is distinct from to_jsonb(r->>'name')
      or not (origin_payload->'subgroups' @> jsonb_build_array(r->>'name'))
      or (r->>'position')::integer is distinct from (
        select min(x.ordinality)::integer-1 from jsonb_array_elements(origin_payload->'subgroups') with ordinality x where x.value=to_jsonb(r->>'name')
      ) then raise exception 'derived_subgroup_mismatch'; end if;
  end loop;
  select count(distinct x->'indexes'->>'timeSlotKey') into actual_count from jsonb_array_elements(s->'records') x where x->>'collection'='lessons';
  if actual_count<>jsonb_array_length(s->'derived'->'timeSlots') then raise exception 'derived_slot_count_mismatch'; end if;
  if exists(select 1 from (
    select x,row_number() over(order by uniflow_data.utf16_sort_key(x->>'rowKey'))-1 expected
    from jsonb_array_elements(s->'derived'->'timeSlots') x
  ) ordered where jsonb_typeof(x->'position') is distinct from 'number' or (x->>'position')::numeric is distinct from expected)
    or (select count(*)<>count(distinct x->>'rowKey') from jsonb_array_elements(s->'derived'->'timeSlots') x)
    then raise exception 'derived_slot_order_mismatch'; end if;
  for r in select value from jsonb_array_elements(s->'derived'->'timeSlots') loop
    select x->'payload' into origin_payload from jsonb_array_elements(s->'records') x
      where x->>'collection'='lessons' and x->'indexes'->>'timeSlotKey'=r->>'rowKey' limit 1;
    if origin_payload is null or r->>'collection' is distinct from '@derived/timeSlots' or r->>'table' is distinct from 'time_slots'
      or r->'payload' is distinct from jsonb_build_object('start',origin_payload->'start','end',origin_payload->'end',
        'endDayOffset',coalesce(nullif(origin_payload->'endDayOffset','null'::jsonb),'0'::jsonb)) then raise exception 'derived_slot_mismatch'; end if;
  end loop;
  select count(distinct x->'indexes'->>'lessonTypeKey') into actual_count from jsonb_array_elements(s->'records') x where x->>'collection'='lessons';
  if actual_count<>jsonb_array_length(s->'derived'->'lessonTypes') then raise exception 'derived_type_count_mismatch'; end if;
  if exists(select 1 from (
    select x,row_number() over(order by uniflow_data.utf16_sort_key(x->>'rowKey'))-1 expected
    from jsonb_array_elements(s->'derived'->'lessonTypes') x
  ) ordered where jsonb_typeof(x->'position') is distinct from 'number' or (x->>'position')::numeric is distinct from expected)
    or (select count(*)<>count(distinct x->>'rowKey') from jsonb_array_elements(s->'derived'->'lessonTypes') x)
    then raise exception 'derived_type_order_mismatch'; end if;
  for r in select value from jsonb_array_elements(s->'derived'->'lessonTypes') loop
    if r->>'collection' is distinct from '@derived/lessonTypes' or r->>'table' is distinct from 'lesson_types'
      or r->'payload' is distinct from jsonb_build_object('name',r->>'rowKey')
      or not exists(select 1 from jsonb_array_elements(s->'records') x where x->>'collection'='lessons' and x->'indexes'->>'lessonTypeKey'=r->>'rowKey')
      then raise exception 'derived_type_mismatch'; end if;
  end loop;
end;
$$;

create function public.uf_normalized_import(p_snapshot jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare r jsonb; c jsonb; target_name text; loaded_count integer; expected_count integer;
begin
  perform pg_advisory_xact_lock(hashtext('uniflow-normalized-one-time-import'));
  if exists(select 1 from uniflow_data.documents) then raise exception 'normalized_import_already_initialized'; end if;
  perform uniflow_data.assert_snapshot(p_snapshot);
  if p_snapshot->>'format' is distinct from 'uniflow-normalized-v1'
    or jsonb_typeof(p_snapshot->'rootKeys') is distinct from 'array'
    or jsonb_typeof(p_snapshot->'rootPayload') is distinct from 'object'
    or jsonb_typeof(p_snapshot->'collections') is distinct from 'array'
    or jsonb_typeof(p_snapshot->'records') is distinct from 'array'
    or (p_snapshot->>'sourceRevision')::bigint<1 then raise exception 'invalid_normalized_document'; end if;
  insert into uniflow_data.documents(id,format,source_revision,root_keys,root_payload,collections)
    values(1,p_snapshot->>'format',(p_snapshot->>'sourceRevision')::bigint,
      p_snapshot->'rootKeys',p_snapshot->'rootPayload',p_snapshot->'collections');
  for r in select value from jsonb_array_elements(p_snapshot->'derived'->'subgroups') loop
    insert into uniflow_data.subgroups(row_key,group_id,name,position,payload)
      values(r->>'rowKey',r->>'groupId',r->>'name',(r->>'position')::integer,r->'payload');
  end loop;
  for r in select value from jsonb_array_elements(p_snapshot->'derived'->'timeSlots') loop
    insert into uniflow_data.time_slots(row_key,position,payload)
      values(r->>'rowKey',(r->>'position')::integer,r->'payload');
  end loop;
  for r in select value from jsonb_array_elements(p_snapshot->'derived'->'lessonTypes') loop
    insert into uniflow_data.lesson_types(row_key,position,payload)
      values(r->>'rowKey',(r->>'position')::integer,r->'payload');
  end loop;
  for r in select value from jsonb_array_elements(p_snapshot->'records') loop
    target_name:=uniflow_data.collection_table(r->>'collection');
    if target_name is distinct from r->>'table' or not (r ? 'payload') then raise exception 'invalid_normalized_record'; end if;
    if target_name='extension_records' then
      insert into uniflow_data.extension_records(collection,row_key,source_id,position,revision,group_ids,indexes,payload)
        values(r->>'collection',r->>'rowKey',r->>'sourceId',(r->>'position')::integer,(r->>'revision')::bigint,
          array(select jsonb_array_elements_text(r->'groupIds')),r->'indexes',r->'payload');
    else
      execute format('insert into uniflow_data.%I(row_key,source_id,position,revision,group_ids,indexes,payload) values($1,$2,$3,$4,$5,$6,$7)',target_name)
        using r->>'rowKey',r->>'sourceId',(r->>'position')::integer,(r->>'revision')::bigint,
          array(select jsonb_array_elements_text(r->'groupIds')),r->'indexes',r->'payload';
    end if;
  end loop;
  insert into uniflow_data.teacher_subjects(teacher_id,subject_id)
    select distinct t.source_id,s.value from uniflow_data.teachers t
      cross join lateral jsonb_array_elements_text(t.payload->'subjects') s;
  for c in select value from jsonb_array_elements(p_snapshot->'collections') loop
    target_name:=uniflow_data.collection_table(c->>'name');
    if c->>'table' is distinct from target_name then raise exception 'invalid_collection_mapping'; end if;
    expected_count:=(c->>'count')::integer;
    if target_name='extension_records' then
      select count(*) into loaded_count from uniflow_data.extension_records where collection=c->>'name';
    else
      execute format('select count(*) from uniflow_data.%I',target_name) into loaded_count;
    end if;
    if loaded_count is distinct from expected_count then raise exception 'normalized_collection_count_mismatch'; end if;
  end loop;
  insert into uniflow_data.group_revisions(group_id) select source_id from uniflow_data.groups;
  -- Force all references to be checked before returning, including source ordering.
  set constraints all immediate;
  return jsonb_build_object('imported',true,'groups',(select count(*) from uniflow_data.groups),
    'lessons',(select count(*) from uniflow_data.lessons),'activeWriterChanged',false);
end;
$$;

create function public.uf_normalized_export() returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare d uniflow_data.documents; c jsonb; target_name text; section_rows jsonb; all_rows jsonb:='[]'; projection jsonb;
begin
  select * into d from uniflow_data.documents where id=1;
  if not found then return null; end if;
  for c in select value from jsonb_array_elements(d.collections) loop
    target_name:=uniflow_data.collection_table(c->>'name');
    if target_name='extension_records' then
      select coalesce(jsonb_agg(jsonb_build_object('collection',collection,'table','extension_records',
        'rowKey',row_key,'sourceId',source_id,'position',position,'revision',revision,
        'groupIds',to_jsonb(group_ids),'indexes',indexes,'payload',payload) order by position),'[]')
        into section_rows from uniflow_data.extension_records where collection=c->>'name';
    else
      execute format('select coalesce(jsonb_agg(jsonb_build_object(''collection'',$1,''table'',$2,
        ''rowKey'',row_key,''sourceId'',source_id,''position'',position,''revision'',revision,
        ''groupIds'',to_jsonb(group_ids),''indexes'',indexes,''payload'',payload) order by position),''[]'') from uniflow_data.%I',target_name)
        into section_rows using c->>'name',target_name;
    end if;
    all_rows:=all_rows||section_rows;
  end loop;
  projection:=jsonb_build_object(
    'subgroups',(select coalesce(jsonb_agg(jsonb_build_object('collection','@derived/subgroups','table','subgroups',
      'rowKey',s.row_key,'position',s.position,'groupId',s.group_id,'name',s.name,'payload',s.payload) order by g.position,s.position),'[]') from uniflow_data.subgroups s join uniflow_data.groups g on g.source_id=s.group_id),
    'timeSlots',(select coalesce(jsonb_agg(jsonb_build_object('collection','@derived/timeSlots','table','time_slots',
      'rowKey',row_key,'position',position,'payload',payload) order by position),'[]') from uniflow_data.time_slots),
    'lessonTypes',(select coalesce(jsonb_agg(jsonb_build_object('collection','@derived/lessonTypes','table','lesson_types',
      'rowKey',row_key,'position',position,'payload',payload) order by position),'[]') from uniflow_data.lesson_types)
  );
  return jsonb_build_object('format',d.format,'sourceRevision',d.source_revision,'rootKeys',d.root_keys,
    'rootPayload',d.root_payload,'collections',d.collections,'records',all_rows,'derived',projection);
end;
$$;

do $security$
declare target_name text;
begin
  for target_name in select tablename from pg_tables where schemaname='uniflow_data' loop
    execute format('alter table uniflow_data.%I enable row level security',target_name);
    execute format('revoke all on uniflow_data.%I from public,anon,authenticated',target_name);
    execute format('grant all on uniflow_data.%I to service_role',target_name);
    execute format('create policy client_access_denied on uniflow_data.%I as restrictive for all to anon,authenticated using(false) with check(false)',target_name);
  end loop;
end
$security$;
grant usage,select on all sequences in schema uniflow_data to service_role;
revoke all on function uniflow_data.collection_table(text) from public,anon,authenticated;
grant execute on function uniflow_data.collection_table(text) to service_role;
revoke all on function uniflow_data.assert_snapshot(jsonb) from public,anon,authenticated;
grant execute on function uniflow_data.assert_snapshot(jsonb) to service_role;
revoke all on function uniflow_data.utf16_sort_key(text) from public,anon,authenticated;
grant execute on function uniflow_data.utf16_sort_key(text) to service_role;
revoke all on function public.uf_normalized_import(jsonb),public.uf_normalized_export() from public,anon,authenticated;
grant execute on function public.uf_normalized_import(jsonb),public.uf_normalized_export() to service_role;
commit;
