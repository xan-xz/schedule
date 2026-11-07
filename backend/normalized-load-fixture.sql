-- Test-only compact equivalent of syntheticFixture(): 100 groups × 40 lessons.
-- Materializing on the server avoids large management-API request bodies.
CREATE FUNCTION pg_temp.normalized_fixture_row(c text,t text,k text,p integer,g jsonb,i jsonb,v jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('collection',c,'table',t,'rowKey',k,'sourceId',k,
    'position',p,'revision',1,'groupIds',g,'indexes',i,'payload',v);
$$;
WITH groups AS (
  SELECT n,'synthetic-group-'||n AS id FROM generate_series(0,99) n
), slots AS (
  SELECT n,to_char(8+n,'FM00')||':00' AS start,to_char(8+n,'FM00')||':50' AS finish FROM generate_series(0,7) n
), types AS (
  SELECT name,ordinality::integer-1 AS n FROM unnest(ARRAY['Lab','Lecture','Practice','Seminar']) WITH ORDINALITY x(name,ordinality)
), records AS (
  SELECT 0 section,n position,pg_temp.normalized_fixture_row('groups','groups',id,n,jsonb_build_array(id),jsonb_build_object('groupId',id),
    jsonb_build_object('id',id,'name','Synthetic group '||n,'subgroups',jsonb_build_array('А','Б'))) value FROM groups
  UNION ALL
  SELECT 1,0,pg_temp.normalized_fixture_row('subjects','subjects','synthetic-subject',0,'[]','{}',jsonb_build_object('id','synthetic-subject','name','Synthetic subject'))
  UNION ALL
  SELECT 2,n,pg_temp.normalized_fixture_row('teachers','teachers','synthetic-teacher-'||n,n,'[]','{}',
    jsonb_build_object('id','synthetic-teacher-'||n,'name','Synthetic teacher '||n,'subjects',jsonb_build_array('synthetic-subject'))) FROM groups
  UNION ALL
  SELECT 3,n,pg_temp.normalized_fixture_row('rooms','rooms','synthetic-room-'||n,n,'[]','{}',
    jsonb_build_object('id','synthetic-room-'||n,'name','Synthetic room '||n,'capacity',30)) FROM groups
  UNION ALL
  SELECT 4,g.n*40+l.n,pg_temp.normalized_fixture_row('lessons','lessons','synthetic-lesson-'||g.n||'-'||l.n,g.n*40+l.n,jsonb_build_array(g.id),
    jsonb_build_object('groupId',g.id,'subjectId','synthetic-subject','teacherId','synthetic-teacher-'||g.n,'roomId','synthetic-room-'||g.n,
      'subgroup','all','day',l.n/8,'start',s.start,'end',s.finish,'week','all',
      'timeSlotKey','["'||s.start||'","'||s.finish||'",0]','lessonTypeKey',typ.name),
    jsonb_build_object('id','synthetic-lesson-'||g.n||'-'||l.n,'groupId',g.id,'subjectId','synthetic-subject',
      'teacherId','synthetic-teacher-'||g.n,'roomId','synthetic-room-'||g.n,'subgroup','all','day',l.n/8,
      'start',s.start,'end',s.finish,'week','all','type',typ.name))
    FROM groups g CROSS JOIN generate_series(0,39) l(n) JOIN slots s ON s.n=l.n%8
      CROSS JOIN LATERAL (SELECT (ARRAY['Practice','Lecture','Lab','Seminar'])[1+l.n%4] AS name) typ
)
INSERT INTO uniflow_normalized_fixture(snapshot)
SELECT jsonb_build_object(
  'format','uniflow-normalized-v1','sourceRevision',(SELECT source_revision FROM uniflow_normalized_fixture_parameters),
  'rootKeys',jsonb_build_array('groups','subjects','teachers','rooms','lessons','exceptions','tasks','announcements','requests','attendance','history','sourceWarnings','sourceConflictPairs','source'),
  'rootPayload',jsonb_build_object('source',jsonb_build_object('kind','synthetic-100x40','notProductionData',true)),
  'collections',jsonb_build_array(
    jsonb_build_object('name','groups','table','groups','identity','id','count',100),
    jsonb_build_object('name','subjects','table','subjects','identity','id','count',1),
    jsonb_build_object('name','teachers','table','teachers','identity','id','count',100),
    jsonb_build_object('name','rooms','table','rooms','identity','id','count',100),
    jsonb_build_object('name','lessons','table','lessons','identity','id','count',4000),
    jsonb_build_object('name','exceptions','table','overrides','identity','mixed','count',0),
    jsonb_build_object('name','tasks','table','tasks','identity','id','count',0),
    jsonb_build_object('name','announcements','table','announcements','identity','id','count',0),
    jsonb_build_object('name','requests','table','extension_records','identity','id','count',0),
    jsonb_build_object('name','attendance','table','extension_records','identity','mixed','count',0),
    jsonb_build_object('name','history','table','audit_log','identity','mixed','count',0),
    jsonb_build_object('name','sourceWarnings','table','extension_records','identity','mixed','count',0),
    jsonb_build_object('name','sourceConflictPairs','table','extension_records','identity','mixed','count',0)),
  'records',(SELECT jsonb_agg(value ORDER BY section,position) FROM records),
  'derived',jsonb_build_object(
    'subgroups',(SELECT jsonb_agg(jsonb_build_object('collection','@derived/subgroups','table','subgroups',
      'rowKey','["'||g.id||'","'||label.name||'"]','position',label.n,'groupId',g.id,'name',label.name,'payload',label.name) ORDER BY g.n,label.n)
      FROM groups g CROSS JOIN (VALUES('А',0),('Б',1)) label(name,n)),
    'timeSlots',(SELECT jsonb_agg(jsonb_build_object('collection','@derived/timeSlots','table','time_slots',
      'rowKey','["'||start||'","'||finish||'",0]','position',n,'payload',jsonb_build_object('start',start,'end',finish,'endDayOffset',0)) ORDER BY n) FROM slots),
    'lessonTypes',(SELECT jsonb_agg(jsonb_build_object('collection','@derived/lessonTypes','table','lesson_types',
      'rowKey',name,'position',n,'payload',jsonb_build_object('name',name)) ORDER BY n) FROM types)
  )
);
