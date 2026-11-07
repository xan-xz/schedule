-- Run only after the foundation DDL and the single fixture import, inside BEGIN/ROLLBACK.
-- No Auth tables, compatibility document, external connections, or active writer changes.
CREATE TEMP TABLE uniflow_normalized_probes (
  name text PRIMARY KEY,
  passed boolean,
  detail jsonb NOT NULL
) ON COMMIT DROP;
CREATE TEMP TABLE uniflow_normalized_timings (
  sample integer PRIMARY KEY,
  row_count integer NOT NULL,
  milliseconds numeric NOT NULL,
  plan jsonb
) ON COMMIT DROP;

CREATE FUNCTION pg_temp.normalized_expect_rejected(probe_name text, candidate jsonb, expected_reason text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE rejected boolean := false; reason text; state text;
BEGIN
  BEGIN
    PERFORM uniflow_data.assert_snapshot(candidate);
  EXCEPTION WHEN OTHERS THEN
    rejected := true;
    GET STACKED DIAGNOSTICS reason = MESSAGE_TEXT, state = RETURNED_SQLSTATE;
  END;
  IF NOT rejected OR reason IS DISTINCT FROM expected_reason OR state <> 'P0001' THEN
    RAISE EXCEPTION 'normalized_probe_failed: %', probe_name;
  END IF;
  INSERT INTO uniflow_normalized_probes VALUES
    (probe_name, true, jsonb_build_object('rejectedWith', expected_reason));
END;
$$;

DO $corruption$
DECLARE s jsonb; candidate jsonb; lesson_index integer;
BEGIN
  SELECT snapshot INTO STRICT s FROM uniflow_normalized_fixture;
  PERFORM uniflow_data.assert_snapshot(s);
  INSERT INTO uniflow_normalized_probes VALUES ('valid_snapshot', true, '{}');
  SELECT ordinality::integer - 1 INTO STRICT lesson_index
    FROM jsonb_array_elements(s->'records') WITH ORDINALITY x
    WHERE x.value->>'collection' = 'lessons' LIMIT 1;
  IF jsonb_array_length(s->'derived'->'timeSlots') = 0 THEN
    RAISE EXCEPTION 'normalized_probes_require_derived_slot';
  END IF;

  candidate := jsonb_set(s, '{rootKeys}', (s->'rootKeys') || jsonb_build_array(s->'rootKeys'->0));
  PERFORM pg_temp.normalized_expect_rejected('duplicate_root_keys', candidate, 'duplicate_or_invalid_manifest');
  candidate := jsonb_set(s, '{collections}', (s->'collections') || jsonb_build_array(s->'collections'->0));
  PERFORM pg_temp.normalized_expect_rejected('duplicate_collection_manifest', candidate, 'duplicate_or_invalid_manifest');
  candidate := jsonb_set(s, '{rootPayload,__probe_unmanifested}', 'true');
  PERFORM pg_temp.normalized_expect_rejected('closed_root_manifest', candidate, 'unmanifested_root_value');
  candidate := jsonb_set(s, '{collections,0,table}', '"__unknown_table"');
  PERFORM pg_temp.normalized_expect_rejected('closed_collection_manifest', candidate, 'invalid_collection_manifest');
  candidate := jsonb_set(s, '{records,0,collection}', '"__unmanifested"');
  PERFORM pg_temp.normalized_expect_rejected('unmanifested_record', candidate, 'invalid_normalized_record');
  candidate := jsonb_set(s, ARRAY['records', lesson_index::text, 'sourceId'], '"__forged_source"');
  PERFORM pg_temp.normalized_expect_rejected('forged_source_id', candidate, 'normalized_source_id_mismatch');
  candidate := jsonb_set(s, ARRAY['records', lesson_index::text, 'indexes', 'roomId'], '"__forged_room"');
  PERFORM pg_temp.normalized_expect_rejected('forged_indexes', candidate, 'normalized_projection_mismatch');
  candidate := jsonb_set(s, ARRAY['records', lesson_index::text, 'groupIds'], '["__forged_group"]');
  PERFORM pg_temp.normalized_expect_rejected('forged_group_ids', candidate, 'normalized_projection_mismatch');
  candidate := jsonb_set(s, '{derived,timeSlots,0,payload,start}', '"00:01"');
  PERFORM pg_temp.normalized_expect_rejected('forged_derived_slot', candidate, 'derived_slot_mismatch');
  IF jsonb_array_length(s->'derived'->'timeSlots') >= 2 THEN
    candidate := jsonb_set(jsonb_set(s, '{derived,timeSlots,0,position}', s#>'{derived,timeSlots,1,position}'),
      '{derived,timeSlots,1,position}', s#>'{derived,timeSlots,0,position}');
    PERFORM pg_temp.normalized_expect_rejected('swapped_derived_slot_positions', candidate, 'derived_slot_order_mismatch');
  ELSE
    INSERT INTO uniflow_normalized_probes VALUES
      ('swapped_derived_slot_positions',NULL,'{"tested":false,"reason":"fewer_than_two_time_slots"}');
  END IF;
  IF jsonb_array_length(s->'derived'->'lessonTypes') >= 2 THEN
    candidate := jsonb_set(jsonb_set(s, '{derived,lessonTypes,0,position}', s#>'{derived,lessonTypes,1,position}'),
      '{derived,lessonTypes,1,position}', s#>'{derived,lessonTypes,0,position}');
    PERFORM pg_temp.normalized_expect_rejected('swapped_derived_type_positions', candidate, 'derived_type_order_mismatch');
  ELSE
    INSERT INTO uniflow_normalized_probes VALUES
      ('swapped_derived_type_positions',NULL,'{"tested":false,"reason":"fewer_than_two_lesson_types"}');
  END IF;
END;
$corruption$;

DO $foreign_key$
DECLARE rejected boolean := false; changed integer;
BEGIN
  IF EXISTS (SELECT FROM uniflow_data.rooms WHERE source_id = '__probe_missing_room__') THEN
    RAISE EXCEPTION 'normalized_probe_fixture_collision';
  END IF;
  BEGIN
    UPDATE uniflow_data.lessons
      SET payload = jsonb_set(payload, '{roomId}', '"__probe_missing_room__"')
      WHERE row_key = (SELECT row_key FROM uniflow_data.lessons ORDER BY position LIMIT 1);
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed <> 1 THEN RAISE EXCEPTION 'normalized_probe_missing_lesson'; END IF;
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN foreign_key_violation THEN
    rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'normalized_probe_failed: unknown_room_fk'; END IF;
  INSERT INTO uniflow_normalized_probes VALUES
    ('unknown_room_fk', true, '{"rejectedWith":"23503","failedUpdateRolledBack":true}');
END;
$foreign_key$;

DO $acl$
DECLARE target text; table_count integer; s jsonb; original_role text := current_user;
  switched boolean; denied boolean; reached boolean; skip_state text;
BEGIN
  SELECT snapshot INTO STRICT s FROM uniflow_normalized_fixture;
  SELECT count(*) INTO table_count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='uniflow_data' AND c.relkind='r';
  IF table_count <> 20 OR EXISTS (
    SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='uniflow_data' AND c.relkind='r' AND (
      NOT c.relrowsecurity OR has_table_privilege('anon',c.oid,'SELECT')
      OR has_table_privilege('anon',c.oid,'INSERT') OR has_table_privilege('anon',c.oid,'UPDATE')
      OR has_table_privilege('anon',c.oid,'DELETE') OR has_table_privilege('authenticated',c.oid,'SELECT')
      OR has_table_privilege('authenticated',c.oid,'INSERT') OR has_table_privilege('authenticated',c.oid,'UPDATE')
      OR has_table_privilege('authenticated',c.oid,'DELETE')
    )
  ) OR has_schema_privilege('anon','uniflow_data','USAGE')
    OR has_schema_privilege('authenticated','uniflow_data','USAGE') THEN
    RAISE EXCEPTION 'normalized_probe_failed: private_table_acl';
  END IF;
  INSERT INTO uniflow_normalized_probes VALUES
    ('private_table_acl',true,jsonb_build_object('tables',table_count,'rlsEnabled',true,'clientGrants',false));

  FOREACH target IN ARRAY ARRAY['service_role','anon','authenticated'] LOOP
    switched := false;
    skip_state := NULL;
    BEGIN
      EXECUTE format('SET LOCAL ROLE %I',target);
      switched := true;
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS skip_state = RETURNED_SQLSTATE;
    END;
    IF NOT switched THEN
      EXECUTE format('SET LOCAL ROLE %I',original_role);
      INSERT INTO uniflow_normalized_probes VALUES
        (target||'_rpc_execution',NULL,jsonb_build_object('tested',false,'reason','role_switch_not_permitted','sqlstate',skip_state));
      CONTINUE;
    END IF;
    BEGIN
      IF target='service_role' THEN
        IF public.uf_normalized_export() IS DISTINCT FROM s THEN
          RAISE EXCEPTION 'normalized_probe_failed: service_export';
        END IF;
        PERFORM uniflow_data.assert_snapshot(s);
        reached := false;
        BEGIN
          PERFORM public.uf_normalized_import(s);
        EXCEPTION WHEN raise_exception THEN
          IF SQLERRM='normalized_import_already_initialized' THEN reached:=true; ELSE RAISE; END IF;
        END;
        IF NOT reached THEN RAISE EXCEPTION 'normalized_probe_failed: service_import_guard'; END IF;
      ELSE
        denied:=false;
        BEGIN PERFORM public.uf_normalized_export();
        EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
        IF NOT denied THEN RAISE EXCEPTION 'normalized_probe_failed: client_export'; END IF;
        denied:=false;
        BEGIN PERFORM public.uf_normalized_import(s);
        EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
        IF NOT denied THEN RAISE EXCEPTION 'normalized_probe_failed: client_import'; END IF;
        denied:=false;
        BEGIN PERFORM uniflow_data.assert_snapshot(s);
        EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
        IF NOT denied THEN RAISE EXCEPTION 'normalized_probe_failed: client_helper'; END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      EXECUTE format('SET LOCAL ROLE %I',original_role);
      RAISE;
    END;
    EXECUTE format('SET LOCAL ROLE %I',original_role);
    INSERT INTO uniflow_normalized_probes VALUES
      (target||'_rpc_execution',true,jsonb_build_object('tested',true,'allowed',target='service_role'));
  END LOOP;
END;
$acl$;

ANALYZE uniflow_data.groups;
ANALYZE uniflow_data.lessons;
DO $timings$
DECLARE sample_number integer; group_count integer; target_group text;
  began timestamptz; result jsonb; read_rows integer; explain_plan jsonb;
BEGIN
  SELECT count(*) INTO group_count FROM uniflow_data.groups;
  IF group_count=0 THEN RAISE EXCEPTION 'normalized_probes_require_group'; END IF;
  FOR sample_number IN 1..5 LOOP
    SELECT source_id INTO target_group FROM uniflow_data.groups ORDER BY position
      OFFSET ((sample_number-1)%group_count) LIMIT 1;
    began:=clock_timestamp();
    SELECT coalesce(jsonb_agg(payload ORDER BY day,start_time,position),'[]') INTO result
      FROM uniflow_data.lessons WHERE group_id=target_group;
    read_rows:=jsonb_array_length(result);
    INSERT INTO uniflow_normalized_timings VALUES
      (sample_number,read_rows,round((extract(epoch FROM clock_timestamp()-began)*1000)::numeric,3),NULL);
  END LOOP;
  SELECT source_id INTO target_group FROM uniflow_data.groups ORDER BY position LIMIT 1;
  EXECUTE 'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT coalesce(jsonb_agg(payload ORDER BY day,start_time,position),''[]'') FROM uniflow_data.lessons WHERE group_id=$1'
    INTO explain_plan USING target_group;
  UPDATE uniflow_normalized_timings SET plan=explain_plan WHERE sample=1;
  IF public.uf_normalized_export() IS DISTINCT FROM (SELECT snapshot FROM uniflow_normalized_fixture) THEN
    RAISE EXCEPTION 'normalized_probe_failed: export_unchanged';
  END IF;
  INSERT INTO uniflow_normalized_probes VALUES
    ('export_unchanged',true,'{"snapshotMatches":true,"failedMutationsRolledBack":true}');
END;
$timings$;
