import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, basename, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  visible as filterForUser,
  mutate,
  validate,
} from "../backend/core.mjs";
import { projectPublicData } from "../backend/public-data.mjs";
import { DEFAULT_APPEARANCE_POLICY } from "../backend/appearance-policy.mjs";
import { projectInitialSnapshot } from "../app/lib/initial-snapshot.mjs";
import { serializeInertSnapshot } from "../scripts/inline-release-snapshot.mjs";
import {
  decomposePlatform,
  recomposePlatform,
  platformChecksum,
  validateGroupScopedEdit,
} from "../backend/normalized.mjs";

const seed = JSON.parse(
  await readFile(new URL("../app/seed.json", import.meta.url), "utf8"),
);
const privateText = "PRIVATE_TEACHING_7A";
const id = (number) =>
  "00000000-0000-4000-8000-" + String(number).padStart(12, "0");
function configured() {
  const data = structuredClone(seed);
  data.siteSettings = {
    ...(data.siteSettings || {}),
    appearance: structuredClone(DEFAULT_APPEARANCE_POLICY),
    teaching: {
      version: 1,
      lessonTypes: [
        { id: id(1), name: privateText + "_type", enabled: true },
        { id: id(2), name: privateText + "_old", enabled: false },
      ],
      bellSchedules: [
        {
          id: id(3),
          name: privateText + "_bells",
          enabled: true,
          slots: [
            {
              id: id(5),
              name: privateText + "_first",
              start: "08:00",
              end: "09:00",
              endDayOffset: 0,
            },
            {
              id: id(6),
              name: privateText + "_night",
              start: "23:00",
              end: "01:00",
              endDayOffset: 1,
            },
          ],
        },
        {
          id: id(4),
          name: privateText + "_retired",
          enabled: false,
          slots: [
            {
              id: id(7),
              name: privateText + "_second",
              start: "10:00",
              end: "11:00",
              endDayOffset: 0,
            },
          ],
        },
      ],
      defaultBellScheduleId: id(3),
    },
    futureOwnerSibling: {
      text: privateText + "_future",
      exact: [null, false, 0, { retained: true }],
    },
  };
  return data;
}
function assertSourceUnchanged(data) {
  assert.equal(data.lessons.length, 524);
  assert.equal(data.groups.length, 19);
  assert.equal(data.sourceWarnings.length, 54);
  assert.equal(data.sourceConflictPairs.length, 133);
  for (const key of [
    "groups",
    "subjects",
    "teachers",
    "rooms",
    "lessons",
    "exceptions",
    "requests",
    "attendance",
    "source",
    "sourceWarnings",
    "sourceConflictPairs",
  ])
    assert.deepEqual(data[key], seed[key], key);
}
function assertPrivate(value) {
  assert.doesNotMatch(JSON.stringify(value), new RegExp(privateText));
  assert.equal(Object.hasOwn(value.siteSettings || {}, "teaching"), false);
  assert.equal(
    Object.hasOwn(value.siteSettings || {}, "futureOwnerSibling"),
    false,
  );
  assert.deepEqual(value.siteSettings, {
    appearance: DEFAULT_APPEARANCE_POLICY,
  });
}

test("teaching presets and unknown settings siblings stay owner-only across actual role and public DTO boundaries", () => {
  const data = configured(),
    original = structuredClone(data);
  assert.deepEqual(filterForUser(data, { role: "admin" }), original);
  const scope = {
    id: "fixture-learner",
    groupId: seed.groups[0].id,
    subgroup: "all",
    teacherId: seed.teachers[0].id,
  };
  for (const role of ["guest", "student", "teacher"])
    assertPrivate(filterForUser(data, { ...scope, role }));
  assertPrivate(projectPublicData(data));
  const envelope = { revision: 5, updatedAt: "2026-11-08T00:00:00Z", data };
  assertPrivate(projectInitialSnapshot(envelope).data);
  assert.doesNotMatch(
    serializeInertSnapshot(envelope),
    new RegExp(privateText),
  );
  assert.deepEqual(data, original);
  assertSourceUnchanged(data);
});

test("unrelated owner policy edits preserve teaching and future sibling metadata without rewriting the 524-lesson source", () => {
  const data = configured(),
    original = structuredClone(data);
  const edited = mutate(
    data,
    { role: "admin", name: "Fixture owner" },
    "appearance.save",
    {
      policy: {
        ...structuredClone(DEFAULT_APPEARANCE_POLICY),
        defaultPalette: "ocean",
      },
    },
  ).data;
  assert.deepEqual(
    edited.siteSettings.teaching,
    original.siteSettings.teaching,
  );
  assert.deepEqual(
    edited.siteSettings.futureOwnerSibling,
    original.siteSettings.futureOwnerSibling,
  );
  assert.equal(edited.siteSettings.appearance.defaultPalette, "ocean");
  assertSourceUnchanged(edited);
  assert.deepEqual(data, original);
});

test("normalized teaching remains lossless root metadata and never replaces the lesson-derived slots or types", async () => {
  const data = configured(),
    original = structuredClone(data);
  const baseline = decomposePlatform(seed, { sourceRevision: 5 });
  const normalized = decomposePlatform(data, { sourceRevision: 5 });
  assert.deepEqual(normalized.rootPayload.siteSettings, data.siteSettings);
  assert.deepEqual(normalized.derived.timeSlots, baseline.derived.timeSlots);
  assert.deepEqual(
    normalized.derived.lessonTypes,
    baseline.derived.lessonTypes,
  );
  assert.deepEqual(normalized.records, baseline.records);
  assert.doesNotMatch(
    JSON.stringify(normalized.derived),
    new RegExp(privateText),
  );
  const restored = recomposePlatform(normalized);
  assert.deepEqual(restored, original);
  assert.equal(await platformChecksum(restored), await platformChecksum(data));
  assert.notEqual(
    await platformChecksum(restored),
    await platformChecksum(seed),
  );
  assertSourceUnchanged(restored);
  assert.deepEqual(data, original);
  const changed = structuredClone(data);
  changed.siteSettings.teaching.lessonTypes[0].name += " changed";
  assert.throws(
    () =>
      validateGroupScopedEdit(data, changed, data.groups[0].id, {
        validateModel: validate,
      }),
    /metadata/,
  );
});

test("the real release builder keeps teaching out of seed, bootstrap and inert HTML while retaining private source files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uniflow-teaching-privacy-"));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("uniflow-teaching-privacy-"));
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(join(directory, "app"));
  await mkdir(join(directory, "backend"));
  const data = configured(),
    rawSeed = JSON.stringify(data);
  const envelope = JSON.stringify({
    source: "release-snapshot",
    revision: 5,
    updatedAt: "2026-11-08T00:00:00Z",
    data,
  });
  const files = {
    "app/index.html":
      '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src \'self\'; style-src \'self\';"><link rel="stylesheet" href="./styles.css"><script type="module" src="./app.mjs"></script></head><body><main id="main"></main></body></html>',
    "app/app.mjs": "export const fixture = true;\n",
    "app/styles.css": "body { color: #222; }\n",
    "app/sw.js": "const VERSION = 'v5-test';\n",
    "app/seed.json": rawSeed,
    "app/bootstrap.json": envelope,
    "backend/core.mjs": "export const fixtureModel = true;\n",
  };
  for (const [path, text] of Object.entries(files))
    await writeFile(join(directory, path), text);
  for (const name of ["appearance-policy", "public-data", "group-state"])
    await writeFile(
      join(directory, "backend", name + ".mjs"),
      await readFile(new URL("../backend/" + name + ".mjs", import.meta.url)),
    );
  await writeFile(
    join(directory, "compatibility.json"),
    await readFile(new URL("../compatibility.json", import.meta.url)),
  );
  const builder = fileURLToPath(
    new URL("../scripts/build.mjs", import.meta.url),
  );
  const result = spawnSync(
    process.execPath,
    [builder, "--source-ref", "1".repeat(40)],
    { cwd: directory, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const publicSeed = JSON.parse(
    await readFile(join(directory, "dist/seed.json"), "utf8"),
  );
  const publicBootstrap = JSON.parse(
    await readFile(join(directory, "dist/bootstrap.json"), "utf8"),
  );
  assertPrivate(publicSeed);
  assertPrivate(publicBootstrap.data);
  assert.equal(publicSeed.lessons.length, 524);
  assert.equal(publicBootstrap.data.lessons.length, 524);
  assert.deepEqual(publicSeed.lessons, publicBootstrap.data.lessons);
  const html = await readFile(join(directory, "dist/index.html"), "utf8");
  assert.doesNotMatch(html, new RegExp(privateText));
  const inert = html.match(
    /<script type="application\/json" id="uniflow-public-snapshot">([\s\S]*?)<\/script>/,
  )?.[1];
  assert.ok(
    inert,
    "full current source must be checked in the actual inert data block",
  );
  assertPrivate(JSON.parse(inert).snapshot.data);
  assert.equal(
    await readFile(join(directory, "app/seed.json"), "utf8"),
    rawSeed,
  );
  assert.equal(
    await readFile(join(directory, "app/bootstrap.json"), "utf8"),
    envelope,
  );
  assert.deepEqual(data, configured());
});
