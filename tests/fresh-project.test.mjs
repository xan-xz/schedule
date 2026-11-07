import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { validate } from "../backend/core.mjs";
import { decomposePlatform } from "../backend/normalized.mjs";
import {
  readFreshProjectSources,
  rehearseFreshProject,
} from "../scripts/fresh-project-check.mjs";

const sources = await readFreshProjectSources();
let db;
before(async () => {
  db = new PGlite();
  await db.exec(sources.fixture);
  await db.exec(sources.bootstrap);
  for (const migration of sources.migrations) await db.exec(migration.sql);
});
after(async () => db?.close());

const state = async () =>
  (
    await db.query(`select
  (select revision from public.uf_platform where id=1) revision,
  (select data from public.uf_platform where id=1) data,
  (select revision from public.uf_signal where id=1) signal,
  (select count(*)::integer from public.uf_versions) versions`)
  ).rows[0];

test("isolated runner replays bootstrap and every immutable migration without manufacturing history or provider proof", async () => {
  const report = await rehearseFreshProject();
  assert.equal(report.historyWritten, false);
  assert.match(report.managedAuth, /fixture; no GoTrue/u);
  assert.equal(report.migrations.length, sources.migrations.length);
  assert.ok(report.migrations.length >= 4);
  assert.deepEqual(
    report.migrations.map((row) => row.version),
    sources.migrations.map((row) => row.version).sort(),
  );
  for (const row of report.migrations)
    assert.match(row.sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(report.counts, {
    accounts: 0,
    shared_credentials: 0,
    legacy_sessions: 0,
    shared_sessions: 0,
    fixture_auth_users: 0,
    fixture_auth_sessions: 0,
    fixture_auth_factors: 0,
    owner_active: false,
    platform_revision: 1,
    signal_revision: 1,
    obsolete_store_absent: true,
    no_history_manufactured: true,
  });
});

test("bootstrap contains a valid empty platform and no preset identity, credentials or timetable", async () => {
  const current = await state();
  validate(current.data);
  assert.equal(current.revision, 1);
  assert.equal(current.signal, 1);
  assert.equal(current.versions, 0);
  assert.ok(
    Object.values(current.data).every(
      (value) => Array.isArray(value) && value.length === 0,
    ),
  );
  const result = (
    await db.query(
      `select owner_uid,factor_id,setup_complete from public.owner_access_config where id=1`,
    )
  ).rows[0];
  assert.deepEqual(result, {
    owner_uid: null,
    factor_id: null,
    setup_complete: false,
  });
  assert.equal(
    (
      await db.query(
        "select to_regclass('public.group_schedule') is null omitted",
      )
    ).rows[0].omitted,
    true,
  );
});

test("fresh guard refuses tables, views, sequences, routine overloads, types and application schemas before DDL", async () => {
  const isolated = new PGlite();
  try {
    await isolated.exec(sources.fixture);
    const cases = [
      [
        "create table public.uf_platform(id integer)",
        "drop table public.uf_platform",
      ],
      [
        "create table public.group_schedule(id integer)",
        "drop table public.group_schedule",
      ],
      [
        "create view public.uf_leftover as select 1 as id",
        "drop view public.uf_leftover",
      ],
      [
        "create sequence public.schedule_leftover",
        "drop sequence public.schedule_leftover",
      ],
      [
        "create function public.uf_commit(smallint) returns integer language sql as 'select 1'",
        "drop function public.uf_commit(smallint)",
      ],
      [
        "create type public.uf_leftover as enum('fixture')",
        "drop type public.uf_leftover",
      ],
      ["create schema uniflow_private", "drop schema uniflow_private"],
      ["create schema uniflow_data", "drop schema uniflow_data"],
    ];
    for (const [create, drop] of cases) {
      await isolated.exec(create);
      const before = await isolated.query(
        "select oid,relname from pg_class where relnamespace='public'::regnamespace order by oid",
      );
      await assert.rejects(
        isolated.exec(sources.bootstrap),
        /fresh_project_existing_application_objects/u,
      );
      await isolated.exec("rollback");
      assert.deepEqual(
        (
          await isolated.query(
            "select oid,relname from pg_class where relnamespace='public'::regnamespace order by oid",
          )
        ).rows,
        before.rows,
      );
      assert.equal(
        (
          await isolated.query(
            "select to_regclass('public.uf_signal') is null absent",
          )
        ).rows[0].absent,
        true,
      );
      await isolated.exec(drop);
    }
  } finally {
    await isolated.close();
  }
});

test("fresh guard refuses a populated migration history without changing it", async () => {
  const isolated = new PGlite();
  try {
    await isolated.exec(sources.fixture);
    await isolated.exec(
      "create schema supabase_migrations; create table supabase_migrations.schema_migrations(version text primary key); insert into supabase_migrations.schema_migrations values('fixture-only-not-a-real-version');",
    );
    await assert.rejects(
      isolated.exec(sources.bootstrap),
      /fresh_project_existing_migration_history/u,
    );
    await isolated.exec("rollback");
    assert.equal(
      (
        await isolated.query(
          "select count(*)::integer n from supabase_migrations.schema_migrations",
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await isolated.query(
          "select to_regclass('public.uf_platform') is null absent",
        )
      ).rows[0].absent,
      true,
    );
  } finally {
    await isolated.close();
  }
});

test("unrelated public data with empty Auth is rejected before application DDL", async () => {
  const isolated = new PGlite();
  try {
    await isolated.exec(sources.fixture);
    await isolated.exec(
      "create table public.unrelated_records(id integer primary key,body text); insert into public.unrelated_records values(1,'unrelated SQL fixture')",
    );
    await assert.rejects(
      isolated.exec(sources.bootstrap),
      /fresh_project_existing_public_relations/u,
    );
    await isolated.exec("rollback");
    assert.deepEqual(
      (await isolated.query("select id,body from public.unrelated_records"))
        .rows,
      [{ id: 1, body: "unrelated SQL fixture" }],
    );
    assert.equal(
      (await isolated.query("select count(*)::integer n from auth.users"))
        .rows[0].n,
      0,
    );
    assert.equal(
      (
        await isolated.query(
          "select to_regclass('public.uf_platform') is null absent",
        )
      ).rows[0].absent,
      true,
    );
  } finally {
    await isolated.close();
  }
});

test("catalogued extension-owned SQL fixture relations do not masquerade as application data", async () => {
  const isolated = new PGlite({ extensions: { pgcrypto } });
  try {
    await isolated.exec(sources.fixture);
    await isolated.exec(
      "create extension pgcrypto; create table public.extension_fixture(id integer); alter extension pgcrypto add table public.extension_fixture",
    );
    await isolated.exec(sources.bootstrap);
    assert.equal(
      (
        await isolated.query(
          "select revision from public.uf_platform where id=1",
        )
      ).rows[0].revision,
      1,
    );
    assert.equal(
      (
        await isolated.query(
          "select to_regclass('public.extension_fixture') is not null retained",
        )
      ).rows[0].retained,
      true,
    );
  } finally {
    await isolated.close();
  }
});

test("SQL-infrastructure guard refuses a synthetic pre-existing Auth user without changing the fixture", async () => {
  const isolated = new PGlite();
  try {
    await isolated.exec(sources.fixture);
    await isolated.exec(
      "insert into auth.users(id,email) values('01010101-0101-4101-8101-010101010101','fixture@example.invalid')",
    );
    await assert.rejects(
      isolated.exec(sources.bootstrap),
      /fresh_project_existing_auth_users/u,
    );
    await isolated.exec("rollback");
    assert.equal(
      (await isolated.query("select count(*)::integer n from auth.users"))
        .rows[0].n,
      1,
    );
    assert.equal(
      (
        await isolated.query(
          "select count(*)::integer n from pg_trigger where tgrelid='auth.users'::regclass and not tgisinternal",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await isolated.query(
          "select to_regclass('public.uf_platform') is null absent",
        )
      ).rows[0].absent,
      true,
    );
  } finally {
    await isolated.close();
  }
});

test("missing managed infrastructure is refused rather than manufactured", async () => {
  const isolated = new PGlite();
  try {
    await assert.rejects(
      isolated.exec(sources.bootstrap),
      /fresh_project_missing_managed_role/u,
    );
    await isolated.exec("rollback");
    assert.equal(
      (await isolated.query("select to_regnamespace('auth') is null absent"))
        .rows[0].absent,
      true,
    );
    assert.equal(
      (
        await isolated.query(
          "select to_regclass('public.uf_platform') is null absent",
        )
      ).rows[0].absent,
      true,
    );
    await isolated.exec(sources.fixture);
    await isolated.exec("alter table auth.users drop column phone_change");
    await assert.rejects(
      isolated.exec(sources.bootstrap),
      /fresh_project_missing_managed_auth_column/u,
    );
    await isolated.exec("rollback");
    assert.equal(
      (
        await isolated.query(
          "select to_regclass('public.uf_platform') is null absent",
        )
      ).rows[0].absent,
      true,
    );
  } finally {
    await isolated.close();
  }
});

test("the populated fresh baseline cannot be bootstrapped a second time", async () => {
  const before = await state();
  await assert.rejects(
    db.exec(sources.bootstrap),
    /fresh_project_existing_application_objects/u,
  );
  await db.exec("rollback");
  assert.deepEqual(await state(), before);
});

test("service-only CAS updates document, signal and previous version together", async () => {
  await db.exec("begin; set local role service_role;");
  try {
    const data = structuredClone((await state()).data);
    data.source = { kind: "isolated-fixture-only" };
    const result = (
      await db.query("select public.uf_commit($1,$2::jsonb,$3,$4) value", [
        1,
        JSON.stringify(data),
        "Fixture actor",
        "Fixture edit",
      ])
    ).rows[0].value;
    assert.equal(result.revision, 2);
    const current = await state();
    assert.equal(current.revision, 2);
    assert.equal(current.signal, 2);
    assert.equal(current.versions, 1);
    assert.deepEqual(current.data, data);
  } finally {
    await db.exec("rollback");
  }
});

test("NULL/stale CAS, NULL payload and missing platform never produce a commit", async () => {
  const before = await state();
  for (const [expected, data, error] of [
    [null, before.data, /version_conflict/u],
    [0, before.data, /version_conflict/u],
    [1, null, /invalid_payload/u],
    [1, [], /invalid_payload/u],
  ]) {
    await db.exec("begin");
    try {
      await assert.rejects(
        db.query("select public.uf_commit($1,$2::jsonb,$3,$4)", [
          expected,
          JSON.stringify(data),
          "Fixture actor",
          "Fixture edit",
        ]),
        error,
      );
    } finally {
      await db.exec("rollback");
    }
    assert.deepEqual(await state(), before);
  }
  await db.exec("begin; delete from public.uf_platform where id=1");
  try {
    await assert.rejects(
      db.query(
        "select public.uf_commit(1,$1::jsonb,'Fixture actor','Fixture edit')",
        [JSON.stringify(before.data)],
      ),
      /platform_not_initialized/u,
    );
  } finally {
    await db.exec("rollback");
  }
  assert.deepEqual(await state(), before);
});

test("a late signal update failure rolls back the earlier history/document writes", async () => {
  const before = await state();
  await db.exec(
    "begin; alter table public.uf_signal add constraint fixture_no_revision_change check(revision=1)",
  );
  try {
    await db.exec(`do $$ begin
      begin
        perform public.uf_commit(1,(select data from public.uf_platform where id=1),'Fixture actor','Fixture edit');
        raise exception 'expected_fixture_constraint_failure';
      exception when check_violation then null; end;
    end $$;`);
    assert.deepEqual(await state(), before);
  } finally {
    await db.exec("rollback");
  }
});

test("client roles can read only the revision signal and cannot invoke write/auth RPCs", async () => {
  const before = await state();
  for (const role of ["anon", "authenticated"]) {
    await db.exec("begin; set local role " + role);
    try {
      assert.equal(
        (await db.query("select revision from public.uf_signal where id=1"))
          .rows[0].revision,
        1,
      );
    } finally {
      await db.exec("rollback");
    }
    for (const sql of [
      "select * from public.uf_platform",
      "select * from public.uf_accounts",
      "select public.uf_commit(1,'{}','Fixture','Fixture')",
      "select public.owner_access_command('status','{}')",
      "select public.uf_normalized_export()",
    ]) {
      await db.exec("begin; set local role " + role);
      try {
        await assert.rejects(db.exec(sql), /permission denied/u);
      } finally {
        await db.exec("rollback");
      }
    }
  }
  assert.deepEqual(await state(), before);
});

test("all immutable migrations support an empty normalized import with no Auth identities", async () => {
  const snapshot = decomposePlatform((await state()).data);
  await db.exec("begin; set local role service_role");
  try {
    const result = (
      await db.query("select public.uf_normalized_import($1::jsonb) value", [
        JSON.stringify(snapshot),
      ])
    ).rows[0].value;
    assert.equal(result.imported, true);
    assert.equal(result.groups, 0);
    assert.equal(result.lessons, 0);
    assert.equal(result.activeWriterChanged, false);
  } finally {
    await db.exec("rollback");
  }
  const counts = (
    await db.query(
      "select (select count(*)::integer from auth.users) users,(select count(*)::integer from auth.sessions) sessions,(select count(*)::integer from auth.mfa_factors) factors",
    )
  ).rows[0];
  assert.deepEqual(counts, { users: 0, sessions: 0, factors: 0 });
});
