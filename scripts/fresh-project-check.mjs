import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = new URL("../", import.meta.url);
const checksum = (text) => createHash("sha256").update(text).digest("hex");

export async function readFreshProjectSources() {
  const bootstrap = await readFile(
    new URL("backend/fresh-project-bootstrap.sql", root),
    "utf8",
  );
  const fixture = await readFile(
    new URL("tests/fixtures/managed-auth-schema.sql", root),
    "utf8",
  );
  const names = (await readdir(new URL("supabase/migrations/", root)))
    .filter((name) => /^\d{14}_[A-Za-z0-9_]+\.sql$/u.test(name))
    .sort();
  if (
    !names.length ||
    new Set(names.map((name) => name.slice(0, 14))).size !== names.length
  )
    throw Error("Missing or duplicate immutable migration versions");
  const migrations = await Promise.all(
    names.map(async (name) => {
      const sql = await readFile(
        new URL("supabase/migrations/" + name, root),
        "utf8",
      );
      return { name, version: name.slice(0, 14), sha256: checksum(sql), sql };
    }),
  );
  return {
    bootstrap,
    fixture,
    migrations,
    bootstrapSha256: checksum(bootstrap),
    fixtureSha256: checksum(fixture),
  };
}

/** No connection string, environment token, HTTP client or deployment mode.
 * This runner always creates and destroys its own isolated in-memory database.
 * Managed Auth tables below are empty SQL infrastructure fixtures, not GoTrue.
 */
export async function rehearseFreshProject() {
  const sources = await readFreshProjectSources();
  const db = new PGlite();
  try {
    await db.exec(sources.fixture);
    await db.exec(sources.bootstrap);
    for (const migration of sources.migrations) await db.exec(migration.sql);
    const result = await db.query(`select
      (select count(*)::integer from public.uf_accounts) as accounts,
      (select count(*)::integer from public.schedule_settings) as shared_credentials,
      (select count(*)::integer from public.uf_sessions) as legacy_sessions,
      (select count(*)::integer from public.schedule_sessions) as shared_sessions,
      (select count(*)::integer from auth.users) as fixture_auth_users,
      (select count(*)::integer from auth.sessions) as fixture_auth_sessions,
      (select count(*)::integer from auth.mfa_factors) as fixture_auth_factors,
      (select setup_complete from public.owner_access_config where id=1) as owner_active,
      (select revision from public.uf_platform where id=1) as platform_revision,
      (select revision from public.uf_signal where id=1) as signal_revision,
      to_regclass('public.group_schedule') is null as obsolete_store_absent,
      to_regclass('supabase_migrations.schema_migrations') is null as no_history_manufactured`);
    const counts = result.rows[0];
    if (
      counts.accounts ||
      counts.shared_credentials ||
      counts.legacy_sessions ||
      counts.shared_sessions ||
      counts.fixture_auth_users ||
      counts.fixture_auth_sessions ||
      counts.fixture_auth_factors ||
      counts.owner_active ||
      counts.platform_revision !== 1 ||
      counts.signal_revision !== 1 ||
      !counts.obsolete_store_absent ||
      !counts.no_history_manufactured
    )
      throw Error("Unexpected state after isolated fresh-project rehearsal");
    return {
      format: "uniflow-fresh-project-check-v1",
      database: "isolated in-memory PostgreSQL (PGlite)",
      managedAuth:
        "empty SQL infrastructure fixture; no GoTrue, provider login, mail or MFA proof",
      historyWritten: false,
      bootstrapSha256: sources.bootstrapSha256,
      fixtureSha256: sources.fixtureSha256,
      migrations: sources.migrations.map(({ name, version, sha256 }) => ({
        name,
        version,
        sha256,
      })),
      counts,
    };
  } finally {
    await db.close();
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    if (process.argv.length !== 2)
      throw Error(
        "This isolated checker accepts no connection or deployment options",
      );
    console.log(JSON.stringify(await rehearseFreshProject(), null, 2));
  } catch (error) {
    console.error("Fresh-project rehearsal failed: " + error.message);
    process.exitCode = 1;
  }
}
