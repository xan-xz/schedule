import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { recomposePlatform } from "../backend/normalized.mjs";
import {
  migrationBody,
  extractPlatform,
} from "../scripts/normalized-dry-run.mjs";

const execute = promisify(execFile);
const cli = fileURLToPath(
  new URL("../scripts/normalized-dry-run.mjs", import.meta.url),
);
const tempRoot = resolve(tmpdir());
const canary = "PRIVATE_OTHER_BACKUP_FIELD_MUST_NOT_LEAK";
async function workspace(t) {
  const path = await mkdtemp(join(tempRoot, "uniflow-normalized-cli-"));
  t.after(async () => {
    assert.equal(dirname(resolve(path)), tempRoot);
    assert.ok(path.startsWith(join(tempRoot, "uniflow-normalized-cli-")));
    await rm(path, { recursive: true, force: true });
  });
  return path;
}
async function run(args) {
  try {
    const result = await execute(process.execPath, [cli, ...args]);
    return { code: 0, ...result };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}
function fixture() {
  return {
    groups: [{ id: "g", name: "Group", subgroups: ["А"] }],
    subjects: [{ id: "s", name: "Subject" }],
    teachers: [{ id: "t", name: "Teacher", subjects: ["s"] }],
    rooms: [{ id: "r", name: "Room" }],
    lessons: [
      {
        id: "l",
        groupId: "g",
        subjectId: "s",
        teacherId: "t",
        roomId: "r",
        day: 0,
        start: "08:00",
        end: "08:50",
        subgroup: "all",
        week: "all",
        type: "Practice",
      },
    ],
    sourceWarnings: [{ kind: "synthetic" }],
    sourceConflictPairs: [{ first: "l", second: "l" }],
    source: { note: "Quoted ' value $$ ; COMMIT; -- remains JSON, never SQL" },
  };
}

test("private backup extraction includes only uf_platform; generated SQL is a single rollback packet", async (t) => {
  const dir = await workspace(t);
  const input = join(dir, "backup.json");
  const sqlPath = join(dir, "private.sql");
  const reportPath = join(dir, "report.json");
  const data = fixture();
  await writeFile(
    input,
    JSON.stringify({
      uf_platform: { id: 1, revision: 5, updated_at: "fixture", data },
      uf_signal: [{ token: canary }],
      uf_versions: [{ data: canary }],
      group_schedule: [{ secret: canary }],
    }),
  );
  const result = await run([
    "--input",
    input,
    "--sql",
    sqlPath,
    "--report",
    reportPath,
  ]);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), report);
  assert.equal(report.inputKind, "backup.uf_platform");
  assert.equal(report.sourceRevision, 5);
  assert.equal(report.counts.groups, 1);
  assert.equal(report.counts.lessons, 1);
  assert.equal(report.counts.warnings, 1);
  assert.equal(report.counts.conflictPairs, 1);
  assert.equal(report.databaseExecuted, false);
  assert.equal(report.activeWriterChanged, false);
  assert.match(report.checksum, /^[a-f0-9]{64}$/);
  const sql = await readFile(sqlPath, "utf8");
  assert.equal((sql.match(/^BEGIN;$/gm) || []).length, 1);
  assert.equal((sql.match(/^ROLLBACK;$/gm) || []).length, 1);
  assert.doesNotMatch(sql, /^COMMIT\s*;/im);
  assert.match(sql, /ROLLBACK;\s*$/);
  const inserted = sql.match(
    /INSERT INTO uniflow_normalized_fixture\(snapshot\) VALUES \((\$uniflow_snapshot_[a-f0-9]+\$)([\s\S]*?)\1::jsonb\);/,
  );
  assert.ok(inserted, "one dollar-quoted snapshot literal");
  assert.deepEqual(recomposePlatform(JSON.parse(inserted[2])), data);
  assert.equal(sql.split(inserted[2]).length - 1, 1);
  for (const output of [sql, result.stdout, result.stderr])
    assert.ok(!output.includes(canary));
  assert.ok(!result.stdout.includes(data.source.note));
  assert.match(sql, /EXPLAIN \(ANALYZE,BUFFERS,FORMAT JSON\)/);
  assert.match(sql, /'normalized_export'/);
  assert.match(sql, /'probeSummary'/);
  assert.match(sql, /'groupReadTimings'/);
});

test("100x40 synthetic fixture is deterministic and reports local checks without executing a database", async () => {
  const first = await run(["--fixture", "100x40", "--revision", "17"]);
  const second = await run(["--fixture", "100x40", "--revision", "17"]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  const a = JSON.parse(first.stdout),
    b = JSON.parse(second.stdout);
  assert.equal(a.counts.groups, 100);
  assert.equal(a.counts.lessons, 4000);
  assert.equal(a.counts.teachers, 100);
  assert.equal(a.counts.rooms, 100);
  assert.equal(a.sourceRevision, 17);
  assert.equal(a.checksum, b.checksum);
  assert.equal(a.localRoundTripMatched, true);
  assert.equal(a.databaseExecuted, false);
  assert.equal(a.activeWriterChanged, false);
  assert.ok(
    Object.values(a.localTimingsMs).every(
      (value) => Number.isFinite(value) && value >= 0,
    ),
  );
});

test("existing output or input collision never overwrites files or creates the other output", async (t) => {
  const dir = await workspace(t);
  const input = join(dir, "input.json"),
    existing = join(dir, "existing.json"),
    missing = join(dir, "must-not-exist.sql");
  await writeFile(input, JSON.stringify(fixture()));
  await writeFile(existing, "sentinel");
  const result = await run([
    "--input",
    input,
    "--sql",
    missing,
    "--report",
    existing,
  ]);
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stderr), {
    ok: false,
    code: "OUTPUT_EXISTS",
  });
  assert.equal(await readFile(existing, "utf8"), "sentinel");
  await assert.rejects(lstat(missing), { code: "ENOENT" });
  const collision = await run(["--input", input, "--sql", input]);
  assert.equal(collision.code, 1);
  assert.equal(JSON.parse(collision.stderr).code, "OUTPUT_PATH_CONFLICT");
  assert.deepEqual(JSON.parse(await readFile(input, "utf8")), fixture());
});

test("invalid JSON and CLI options fail with content-free JSON diagnostics", async (t) => {
  const dir = await workspace(t);
  const input = join(dir, "bad.json");
  await writeFile(input, '{"secret":"' + canary);
  for (const [args, code] of [
    [["--input", input], "INVALID_JSON"],
    [["--fixture", "100x40", "--revision", "9007199254740992"], "USAGE"],
    [["--input", input, "--fixture", "100x40"], "USAGE"],
    [["--fixture", "100x40", "--unknown", "x"], "USAGE"],
    [["--fixture", "100x40", "--revision", "1", "--revision", "2"], "USAGE"],
  ]) {
    const result = await run(args);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), { ok: false, code });
    assert.ok(!result.stderr.includes(canary));
    assert.ok(!result.stderr.includes(input));
  }
});

test("migration packet rejects an unexpected transaction wrapper instead of silently stripping SQL", () => {
  assert.equal(
    migrationBody("-- migration\nbegin;\nselect 1;\ncommit;\n"),
    "-- migration\n\nselect 1;",
  );
  assert.throws(() => migrationBody("begin;\nselect 1;\ncommit;\nselect 2;"), {
    code: "INVALID_MIGRATION_WRAPPER",
  });
  assert.throws(() => migrationBody("begin;\ncommit;\nselect 1;\ncommit;"), {
    code: "INVALID_MIGRATION_WRAPPER",
  });
  assert.throws(
    () =>
      extractPlatform({
        uf_platform: [
          { revision: 1, data: fixture() },
          { revision: 2, data: fixture() },
        ],
      }),
    { code: "INVALID_PLATFORM" },
  );
});
