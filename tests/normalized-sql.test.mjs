import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  decomposePlatform,
  recomposePlatform,
} from "../backend/normalized.mjs";
import {
  syntheticFixture,
  buildRollbackSql,
} from "../scripts/normalized-dry-run.mjs";

const schema = await readFile(
  new URL(
    "../supabase/migrations/20261107215424_normalized_schedule_foundation.sql",
    import.meta.url,
  ),
  "utf8",
);
const probes = await readFile(
  new URL("../backend/normalized-probes.sql", import.meta.url),
  "utf8",
);
const rollback = await readFile(
  new URL("../backend/normalized-rollback.sql", import.meta.url),
  "utf8",
);
const compactFixture = await readFile(
  new URL("../backend/normalized-load-fixture.sql", import.meta.url),
  "utf8",
);
const source = JSON.parse(
  await readFile(new URL("../app/seed.json", import.meta.url), "utf8"),
);
const snapshot = decomposePlatform(source, { sourceRevision: 5 });
let db;

before(async () => {
  db = new PGlite();
  await db.exec(
    "create role anon; create role authenticated; create role service_role bypassrls;",
  );
  await db.exec(schema);
  await db.query("select public.uf_normalized_import($1::jsonb)", [
    JSON.stringify(snapshot),
  ]);
});
after(async () => {
  await db?.close();
});

test("fresh private SQL schema imports and reconstructs all source fields", async () => {
  const result = await db.query(
    "select public.uf_normalized_export() as snapshot",
  );
  assert.deepEqual(recomposePlatform(result.rows[0].snapshot), source);
  const counts = await db.query(
    "select (select count(*) from uniflow_data.groups)::integer groups,(select count(*) from uniflow_data.lessons)::integer lessons,(select count(*) from uniflow_data.teacher_subjects)::integer links",
  );
  assert.equal(counts.rows[0].groups, 19);
  assert.equal(counts.rows[0].lessons, 524);
  assert.ok(counts.rows[0].links > 0);
});

test("SQL corruption, foreign-key and actual client/service-role probes pass", async (t) => {
  await db.exec(
    "begin; create temp table uniflow_normalized_fixture(snapshot jsonb not null) on commit drop;",
  );
  try {
    await db.query("insert into uniflow_normalized_fixture values($1::jsonb)", [
      JSON.stringify(snapshot),
    ]);
    await db.exec(probes);
    const result = await db.query(
      "select name,passed,detail from uniflow_normalized_probes order by name",
    );
    assert.ok(result.rows.length >= 16);
    assert.deepEqual(
      result.rows.filter((row) => row.passed !== true),
      [],
    );
    for (const role of ["anon", "authenticated", "service_role"])
      assert.equal(
        result.rows.find((row) => row.name === role + "_rpc_execution").detail
          .tested,
        true,
      );
    const timings = await db.query(
      "select sample,row_count,milliseconds from uniflow_normalized_timings order by sample",
    );
    assert.equal(timings.rows.length, 5);
    assert.ok(timings.rows.every((row) => row.row_count > 0));
    t.diagnostic(
      JSON.stringify({
        sqlChecks: result.rows.length,
        database: "isolated Postgres WASM",
        querySamples: timings.rows,
      }),
    );
  } finally {
    await db.exec("rollback;");
  }
});

test("derived type ordering matches JavaScript for custom non-BMP labels", async () => {
  const candidate = structuredClone(source);
  const types = ["\uE000", "😀", "А", "Normal"];
  candidate.lessons = candidate.lessons
    .slice(0, types.length)
    .map((row, index) => ({ ...row, type: types[index] }));
  const normalized = decomposePlatform(candidate);
  await db.query("select uniflow_data.assert_snapshot($1::jsonb)", [
    JSON.stringify(normalized),
  ]);
  [
    normalized.derived.lessonTypes[0].position,
    normalized.derived.lessonTypes[1].position,
  ] = [1, 0];
  await assert.rejects(
    db.query("select uniflow_data.assert_snapshot($1::jsonb)", [
      JSON.stringify(normalized),
    ]),
    /derived_type_order_mismatch/,
  );
});

test("shadow rollback refuses operational data and empty-store reapplication is reproducible", async () => {
  await db.exec("update uniflow_data.documents set is_live=true where id=1;");
  await assert.rejects(
    db.exec(rollback),
    /normalized_rollback_refuses_operational_data/,
  );
  await db.exec(
    "rollback; update uniflow_data.documents set is_live=false where id=1;",
  );
  await db.exec(rollback);
  const absent = await db.query(
    "select count(*)::integer n from pg_namespace where nspname='uniflow_data'",
  );
  assert.equal(absent.rows[0].n, 0);
  await db.exec(schema);
  await db.query("select public.uf_normalized_import($1::jsonb)", [
    JSON.stringify(snapshot),
  ]);
  const result = await db.query(
    "select public.uf_normalized_export() as snapshot",
  );
  assert.deepEqual(recomposePlatform(result.rows[0].snapshot), source);
});

test("100 groups and 4000 lessons pass the complete SQL rehearsal in an isolated database", async (t) => {
  const loadDb = new PGlite();
  try {
    await loadDb.exec(
      "create role anon; create role authenticated; create role service_role bypassrls;",
    );
    const data = syntheticFixture();
    const normalized = decomposePlatform(data, { sourceRevision: 5 });
    const result = await loadDb.exec(
      buildRollbackSql(normalized, schema, probes, compactFixture),
    );
    const final = result.find((entry) =>
      entry.fields.some((field) => field.name === "normalized_dry_run"),
    )?.rows[0].normalized_dry_run;
    assert.ok(final);
    assert.ok(final.probeSummary.length >= 18);
    assert.deepEqual(
      final.probeSummary.filter((row) => row.passed !== true),
      [],
    );
    assert.deepEqual(recomposePlatform(final.normalized_export), data);
    assert.deepEqual(final.normalized_export, normalized);
    assert.equal(final.groupReadTimings.length, 5);
    assert.ok(final.groupReadTimings.every((row) => row.rows === 40));
    const absent = await loadDb.query(
      "select count(*)::integer n from pg_namespace where nspname='uniflow_data'",
    );
    assert.equal(absent.rows[0].n, 0);
    t.diagnostic(
      JSON.stringify({
        groups: 100,
        lessons: 4000,
        database: "isolated Postgres WASM",
        transaction: "ROLLBACK",
        groupReadTimings: final.groupReadTimings,
      }),
    );
  } finally {
    await loadDb.close();
  }
});
