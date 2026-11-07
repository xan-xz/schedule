import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import {
  decomposePlatform,
  recomposePlatform,
  platformChecksum,
} from "../backend/normalized.mjs";

const migrationUrl = new URL(
  "../supabase/migrations/20261107215424_normalized_schedule_foundation.sql",
  import.meta.url,
);
const probesUrl = new URL("../backend/normalized-probes.sql", import.meta.url);
const loadFixtureUrl = new URL(
  "../backend/normalized-load-fixture.sql",
  import.meta.url,
);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const failure = (code) => Object.assign(new Error(code), { code });
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const elapsed = (start) => Number((performance.now() - start).toFixed(3));

export function extractPlatform(input) {
  let row = input;
  let inputKind = "platform";
  if (object(input) && Object.hasOwn(input, "uf_platform")) {
    row = input.uf_platform;
    inputKind = "backup.uf_platform";
  }
  if (Array.isArray(row)) {
    if (row.length !== 1) throw failure("INVALID_PLATFORM");
    [row] = row;
  }
  if (!object(row)) throw failure("INVALID_PLATFORM");
  if (Array.isArray(row.groups) && Array.isArray(row.lessons))
    return { data: row, sourceRevision: 1, inputKind };
  if (
    !object(row.data) ||
    !Array.isArray(row.data.groups) ||
    !Array.isArray(row.data.lessons) ||
    !positive(row.revision)
  )
    throw failure("INVALID_PLATFORM");
  return {
    data: row.data,
    sourceRevision: row.revision,
    inputKind: inputKind === "platform" ? "platform-row" : inputKind,
  };
}

export function syntheticFixture() {
  const data = {
    groups: [],
    subjects: [{ id: "synthetic-subject", name: "Synthetic subject" }],
    teachers: [],
    rooms: [],
    lessons: [],
    exceptions: [],
    tasks: [],
    announcements: [],
    requests: [],
    attendance: [],
    history: [],
    sourceWarnings: [],
    sourceConflictPairs: [],
    source: { kind: "synthetic-100x40", notProductionData: true },
  };
  for (let group = 0; group < 100; group++) {
    const id = "synthetic-group-" + group;
    const teacherId = "synthetic-teacher-" + group;
    const roomId = "synthetic-room-" + group;
    data.groups.push({
      id,
      name: "Synthetic group " + group,
      subgroups: ["А", "Б"],
    });
    data.teachers.push({
      id: teacherId,
      name: "Synthetic teacher " + group,
      subjects: ["synthetic-subject"],
    });
    data.rooms.push({
      id: roomId,
      name: "Synthetic room " + group,
      capacity: 30,
    });
    for (let lesson = 0; lesson < 40; lesson++) {
      const hour = String(8 + (lesson % 8)).padStart(2, "0");
      data.lessons.push({
        id: "synthetic-lesson-" + group + "-" + lesson,
        groupId: id,
        subjectId: "synthetic-subject",
        teacherId,
        roomId,
        subgroup: "all",
        day: Math.floor(lesson / 8),
        start: hour + ":00",
        end: hour + ":50",
        week: "all",
        type: ["Practice", "Lecture", "Lab", "Seminar"][lesson % 4],
      });
    }
  }
  return data;
}

/** Remove only the checked migration's outer transaction, never function bodies. */
export function migrationBody(sql) {
  const lines = sql.replaceAll("\r\n", "\n").split("\n");
  const first = lines.findIndex(
    (line) => line.trim() && !line.trim().startsWith("--"),
  );
  let last = lines.length - 1;
  while (last >= 0 && !lines[last].trim()) last--;
  if (
    !/^begin;$/i.test(lines[first]?.trim() || "") ||
    !/^commit;$/i.test(lines[last]?.trim() || "")
  )
    throw failure("INVALID_MIGRATION_WRAPPER");
  lines[first] = "";
  lines[last] = "";
  if (lines.some((line) => /^(?:begin|commit|rollback)\s*;/i.test(line.trim())))
    throw failure("INVALID_MIGRATION_WRAPPER");
  return lines.join("\n").trim();
}

export function buildRollbackSql(snapshot, ddl, probes, fixtureSql = "") {
  let delimiter;
  const json = JSON.stringify(snapshot);
  do delimiter = "$uniflow_snapshot_" + randomUUID().replaceAll("-", "") + "$";
  while (json.includes(delimiter));
  return `-- PRIVATE dry-run input. Do not commit this generated file or expose its output.
-- Run as one transaction in an isolated/staged database. No active writer cutover.
BEGIN;
SET LOCAL statement_timeout = '180s';
${migrationBody(ddl)}

CREATE TEMP TABLE uniflow_normalized_fixture(snapshot jsonb NOT NULL) ON COMMIT DROP;
${
  fixtureSql
    ? `CREATE TEMP TABLE uniflow_normalized_fixture_parameters(source_revision bigint NOT NULL) ON COMMIT DROP;
INSERT INTO uniflow_normalized_fixture_parameters VALUES (${snapshot.sourceRevision});
${fixtureSql}`
    : `INSERT INTO uniflow_normalized_fixture(snapshot) VALUES (${delimiter}${json}${delimiter}::jsonb);`
}
SELECT public.uf_normalized_import(snapshot) AS normalized_import FROM uniflow_normalized_fixture;

${probes.trim()}

SELECT jsonb_build_object(
  'normalized_export', public.uf_normalized_export(),
  'probeSummary', (SELECT jsonb_agg(jsonb_build_object('name',name,'passed',passed,'detail',detail) ORDER BY name) FROM uniflow_normalized_probes),
  'groupReadTimings', (SELECT jsonb_agg(jsonb_build_object('sample',sample,'rows',row_count,'milliseconds',milliseconds) ORDER BY sample) FROM uniflow_normalized_timings),
  'groupReadExplain', (SELECT plan FROM uniflow_normalized_timings WHERE sample=1),
  'activeWriterChanged', false,
  'transactionDisposition', 'ROLLBACK'
) AS normalized_dry_run;
ROLLBACK;
`;
}

function argumentsFor(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (
      !["--input", "--fixture", "--revision", "--sql", "--report"].includes(
        name,
      ) ||
      Object.hasOwn(options, name)
    )
      throw failure("USAGE");
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw failure("USAGE");
    options[name] = value;
  }
  if (!!options["--input"] === !!options["--fixture"]) throw failure("USAGE");
  if (options["--fixture"] && options["--fixture"] !== "100x40")
    throw failure("USAGE");
  if (
    options["--revision"] &&
    (!/^[1-9]\d*$/.test(options["--revision"]) ||
      !positive(Number(options["--revision"])))
  )
    throw failure("USAGE");
  return options;
}

async function ensureNewOutputs(paths, inputPath) {
  if (new Set(paths).size !== paths.length || paths.includes(inputPath))
    throw failure("OUTPUT_PATH_CONFLICT");
  for (const path of paths) {
    try {
      await lstat(path);
      throw failure("OUTPUT_EXISTS");
    } catch (error) {
      if (error.code !== "ENOENT")
        throw failure(
          error.code === "OUTPUT_EXISTS"
            ? "OUTPUT_EXISTS"
            : "OUTPUT_UNAVAILABLE",
        );
    }
  }
}

export async function dryRun(argv) {
  const totalStart = performance.now();
  const options = argumentsFor(argv);
  const inputPath = options["--input"]
    ? resolve(options["--input"])
    : undefined;
  const sqlPath = options["--sql"] ? resolve(options["--sql"]) : undefined;
  const reportPath = options["--report"]
    ? resolve(options["--report"])
    : undefined;
  await ensureNewOutputs([sqlPath, reportPath].filter(Boolean), inputPath);
  const readStart = performance.now();
  let extracted;
  if (inputPath) {
    let raw;
    try {
      raw = await readFile(inputPath, "utf8");
    } catch {
      throw failure("INPUT_UNAVAILABLE");
    }
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      throw failure("INVALID_JSON");
    }
    extracted = extractPlatform(input);
  } else
    extracted = {
      data: syntheticFixture(),
      sourceRevision: 1,
      inputKind: "synthetic-100x40",
    };
  const readMilliseconds = elapsed(readStart);
  const revision = options["--revision"]
    ? Number(options["--revision"])
    : extracted.sourceRevision;
  const decomposeStart = performance.now();
  const snapshot = decomposePlatform(extracted.data, {
    sourceRevision: revision,
  });
  const decomposeMilliseconds = elapsed(decomposeStart);
  const recomposeStart = performance.now();
  const restored = recomposePlatform(snapshot);
  assert.deepEqual(restored, extracted.data);
  const recomposeMilliseconds = elapsed(recomposeStart);
  const checksumStart = performance.now();
  const checksum = await platformChecksum(extracted.data);
  assert.equal(await platformChecksum(restored), checksum);
  const checksumMilliseconds = elapsed(checksumStart);
  let sql;
  let ddl;
  let probes;
  if (sqlPath) {
    if (!extracted.data.groups.length || !extracted.data.lessons.length)
      throw failure("SQL_PROBES_REQUIRE_GROUP_AND_LESSON");
    [ddl, probes] = await Promise.all([
      readFile(migrationUrl, "utf8"),
      readFile(probesUrl, "utf8"),
    ]);
    const fixtureSql = options["--fixture"]
      ? await readFile(loadFixtureUrl, "utf8")
      : "";
    sql = buildRollbackSql(snapshot, ddl, probes, fixtureSql);
  }
  const count = (key) =>
    Array.isArray(extracted.data[key]) ? extracted.data[key].length : 0;
  const report = {
    format: "uniflow-normalized-dry-run-v1",
    inputKind: extracted.inputKind,
    sourceRevision: revision,
    counts: {
      groups: count("groups"),
      lessons: count("lessons"),
      subjects: count("subjects"),
      teachers: count("teachers"),
      rooms: count("rooms"),
      tasks: count("tasks"),
      warnings: count("sourceWarnings"),
      conflictPairs: count("sourceConflictPairs"),
      normalizedRecords: snapshot.records.length,
      collections: snapshot.collections.length,
      derivedSubgroups: snapshot.derived.subgroups.length,
      derivedTimeSlots: snapshot.derived.timeSlots.length,
      derivedLessonTypes: snapshot.derived.lessonTypes.length,
    },
    checksum,
    localRoundTripMatched: true,
    databaseExecuted: false,
    activeWriterChanged: false,
    ...(sql
      ? {
          generatedSqlBytes: Buffer.byteLength(sql),
          generatedSqlChecksum: digest(sql),
          ddlChecksum: digest(ddl),
          probesChecksum: digest(probes),
        }
      : {}),
    localTimingsMs: {
      readOrGenerate: readMilliseconds,
      decompose: decomposeMilliseconds,
      recompose: recomposeMilliseconds,
      checksums: checksumMilliseconds,
      total: elapsed(totalStart),
    },
  };
  try {
    if (sqlPath) await writeFile(sqlPath, sql, { flag: "wx", mode: 0o600 });
    if (reportPath)
      await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
  } catch (error) {
    throw failure(
      error.code === "EEXIST" ? "OUTPUT_EXISTS" : "OUTPUT_UNAVAILABLE",
    );
  }
  return report;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.stdout.write(
      JSON.stringify(await dryRun(process.argv.slice(2)), null, 2) + "\n",
    );
  } catch (error) {
    const codes = new Set([
      "USAGE",
      "OUTPUT_PATH_CONFLICT",
      "OUTPUT_EXISTS",
      "OUTPUT_UNAVAILABLE",
      "INPUT_UNAVAILABLE",
      "INVALID_JSON",
      "INVALID_PLATFORM",
      "INVALID_MIGRATION_WRAPPER",
      "SQL_PROBES_REQUIRE_GROUP_AND_LESSON",
    ]);
    const code = codes.has(error.code) ? error.code : "INVALID_PLATFORM";
    process.stderr.write(JSON.stringify({ ok: false, code }) + "\n");
    process.exitCode = 1;
  }
}
