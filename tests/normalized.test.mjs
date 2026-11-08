import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { mutate, validate } from "../backend/core.mjs";
import {
  decomposePlatform,
  recomposePlatform,
  canonicalJson,
  platformChecksum,
  validateGroupScopedEdit,
  REQUIRED_ID_COLLECTIONS,
} from "../backend/normalized.mjs";

const seed = JSON.parse(
  await readFile(new URL("../app/seed.json", import.meta.url), "utf8"),
);
const clone = structuredClone;
const owner = { id: "fixture-owner", role: "admin", name: "Synthetic owner" };
function generated(groups = 2, lessonsPerGroup = 1) {
  const data = {
    groups: [],
    teachers: [],
    subjects: [{ id: "subject", name: "Subject" }],
    rooms: [],
    lessons: [],
    exceptions: [],
    tasks: [],
    announcements: [],
    requests: [],
    attendance: [],
    history: [],
  };
  for (let group = 0; group < groups; group++) {
    const id = "g-" + group,
      teacher = "t-" + group,
      room = "r-" + group;
    data.groups.push({ id, name: "Group " + group, subgroups: ["А", "Б"] });
    data.teachers.push({
      id: teacher,
      name: "Teacher " + group,
      subjects: ["subject"],
    });
    data.rooms.push({ id: room, name: "Room " + group, capacity: 30 });
    for (let lesson = 0; lesson < lessonsPerGroup; lesson++) {
      const hour = String(8 + (lesson % 8)).padStart(2, "0");
      data.lessons.push({
        id: "l-" + group + "-" + lesson,
        groupId: id,
        subjectId: "subject",
        teacherId: teacher,
        roomId: room,
        subgroup: "all",
        day: Math.floor(lesson / 8),
        week: "all",
        start: hour + ":00",
        end: hour + ":50",
        type: "Lecture",
        source: {
          sheet: "Synthetic source",
          cell: "A" + (lesson + 1),
          row: lesson + 1,
        },
      });
    }
  }
  return data;
}

test("the current 19-group/524-lesson source roundtrips exactly with its provenance and exceptions", async () => {
  assert.equal(validate(seed), true);
  const normalized = decomposePlatform(seed, { sourceRevision: 5 });
  const restored = recomposePlatform(normalized);
  assert.deepEqual(restored, seed);
  assert.deepEqual(Object.keys(restored), Object.keys(seed));
  assert.equal(normalized.sourceRevision, 5);
  assert.equal(
    normalized.collections.find((row) => row.name === "groups").count,
    19,
  );
  assert.equal(
    normalized.collections.find((row) => row.name === "lessons").count,
    524,
  );
  assert.equal(restored.sourceWarnings.length, 54);
  assert.equal(restored.sourceConflictPairs.length, 133);
  assert.deepEqual(restored.source, seed.source);
  assert.deepEqual(
    restored.lessons.map((lesson) => lesson.source),
    seed.lessons.map((lesson) => lesson.source),
  );
  assert.equal(await platformChecksum(restored), await platformChecksum(seed));
});

test("decomposition is deterministic and returned payloads do not alias the caller", () => {
  const original = generated();
  assert.deepEqual(decomposePlatform(original), decomposePlatform(original));
  const result = decomposePlatform(original);
  result.records.find((row) => row.collection === "groups").payload.name =
    "Changed output";
  assert.equal(original.groups[0].name, "Group 0");
  const restored = recomposePlatform(decomposePlatform(original));
  restored.lessons[0].source.cell = "Modified output";
  assert.equal(original.lessons[0].source.cell, "A1");
});

test("unknown fields and all future arrays preserve their values, duplicate IDs and original shape", () => {
  const source = generated();
  source.futureConfig = {
    nested: { original: [null, false, 0, { arbitrary: "value" }] },
  };
  source.futureRecords = [
    { id: "duplicate", arbitrary: 1 },
    { id: "duplicate", arbitrary: 2 },
    null,
    "string",
    [1, 2],
    false,
  ];
  source.timeSlots = [{ id: '["08:00","08:50",0]', future: true }];
  source.lessonTypes = [{ id: "Lecture", future: true }];
  source.subgroups = [{ id: "future-subgroup", future: true }];
  source.lessons[0].future = { nested: "keep" };
  source.sourceWarnings = [
    { id: "same", future: true },
    { id: "same", future: false },
  ];
  const normalized = decomposePlatform(source);
  assert.deepEqual(recomposePlatform(normalized), source);
  for (const collection of [
    "futureRecords",
    "timeSlots",
    "lessonTypes",
    "subgroups",
    "sourceWarnings",
  ])
    assert.equal(
      normalized.collections.find((row) => row.name === collection).table,
      "extension_records",
    );
  assert.equal(
    normalized.records.find((row) => row.collection === "futureRecords").indexes
      .groupId,
    undefined,
  );
  assert.notEqual(
    normalized.records.find((row) => row.collection === "timeSlots").collection,
    normalized.derived.timeSlots[0].collection,
  );
});

test("missing, null, scalar, object and empty-array root values remain distinct", () => {
  const source = {
    nullable: null,
    empty: [],
    scalar: false,
    object: { empty: [] },
    groups: null,
    lessons: {},
  };
  const restored = recomposePlatform(decomposePlatform(source));
  assert.deepEqual(restored, source);
  assert.equal(Object.hasOwn(restored, "missing"), false);
  assert.equal(Object.hasOwn(restored, "nullable"), true);
  assert.equal(Array.isArray(restored.empty), true);
});

test("original entity IDs remain stable under insertion and array reorder", () => {
  const source = generated();
  const before = decomposePlatform(source);
  source.groups.reverse();
  source.groups.unshift({ id: "new-group", name: "New", subgroups: ["А"] });
  source.lessons.reverse();
  const after = decomposePlatform(source);
  for (const row of before.records.filter((record) =>
    ["groups", "lessons"].includes(record.collection),
  )) {
    const existing = after.records.find(
      (record) =>
        record.collection === row.collection &&
        record.sourceId === row.sourceId,
    );
    assert.equal(existing.rowKey, row.rowKey);
    assert.equal(existing.rowKey, row.payload.id);
  }
});

test("known required-ID entities reject missing or duplicate identifiers instead of rewriting them", () => {
  for (const collection of REQUIRED_ID_COLLECTIONS) {
    assert.throws(
      () =>
        decomposePlatform({ [collection]: [{ id: "same" }, { id: "same" }] }),
      (error) =>
        error.code === "NORMALIZED_INVALID" && error.collection === collection,
    );
    assert.throws(
      () => decomposePlatform({ [collection]: [{ name: "Missing ID" }] }),
      (error) => error.code === "NORMALIZED_INVALID",
    );
  }
});

test("valid ID-less overrides and attendance use stable natural keys and inherit the lesson's group", () => {
  const source = generated();
  source.exceptions = [
    {
      lessonId: "l-0-0",
      date: "2026-11-09",
      status: "cancelled",
      future: { keep: true },
    },
  ];
  source.attendance = [
    {
      lessonId: "l-0-0",
      date: "2026-11-09",
      studentId: "student-fixture",
      status: "present",
    },
  ];
  const normalized = decomposePlatform(source);
  const override = normalized.records.find(
    (row) => row.collection === "exceptions",
  );
  const attendance = normalized.records.find(
    (row) => row.collection === "attendance",
  );
  assert.equal(override.table, "overrides");
  assert.deepEqual(override.groupIds, ["g-0"]);
  assert.deepEqual(attendance.groupIds, ["g-0"]);
  assert.equal(override.sourceId, null);
  assert.deepEqual(recomposePlatform(normalized), source);
  const reordered = clone(source);
  reordered.exceptions.unshift({
    lessonId: "l-1-0",
    date: "2026-11-09",
    status: "cancelled",
  });
  assert.equal(
    decomposePlatform(reordered).records.find(
      (row) =>
        row.collection === "exceptions" && row.payload.lessonId === "l-0-0",
    ).rowKey,
    override.rowKey,
  );
});

test("namespaced optional identity keys cannot collide with literal IDs or arbitrary values", () => {
  const source = generated();
  source.exceptions = [
    {
      id: '["lesson-date","l-0-0","2026-11-09"]',
      lessonId: "l-1-0",
      date: "2026-11-09",
      status: "cancelled",
    },
    { lessonId: "l-0-0", date: "2026-11-09", status: "cancelled" },
  ];
  const normalized = decomposePlatform(source);
  const keys = normalized.records
    .filter((row) => row.collection === "exceptions")
    .map((row) => row.rowKey);
  assert.equal(new Set(keys).size, 2);
  assert.deepEqual(recomposePlatform(normalized), source);
});

test("shared sessions, warning source cells and conflict fingerprints are opaque and never repaired", () => {
  const source = clone(seed);
  source.lessons[0].sharedSessionId = "same-session-original";
  source.lessons[1].sharedSessionId = "same-session-original";
  const fingerprints = clone(source.sourceConflictPairs);
  const restored = recomposePlatform(decomposePlatform(source));
  assert.deepEqual(restored, source);
  assert.deepEqual(restored.sourceConflictPairs, fingerprints);
  assert.deepEqual(restored.sourceWarnings, source.sourceWarnings);
  assert.equal(restored.lessons[0].sharedSessionId, "same-session-original");
});

test("derived catalogs are separate read indexes and do not inject fields into the source", () => {
  const source = generated(2, 8);
  const normalized = decomposePlatform(source);
  assert.equal(normalized.derived.subgroups.length, 4);
  assert.equal(normalized.derived.timeSlots.length, 8);
  assert.equal(normalized.derived.lessonTypes.length, 1);
  assert.ok(
    normalized.records
      .filter((row) => row.collection === "lessons")
      .every((row) =>
        normalized.derived.timeSlots.some(
          (slot) => slot.rowKey === row.indexes.timeSlotKey,
        ),
      ),
  );
  normalized.derived.timeSlots[0].payload.start = "00:00";
  assert.deepEqual(recomposePlatform(normalized), source);
  assert.equal(Object.hasOwn(source, "timeSlots"), false);
});

test("unordered SQL rows reconstruct the original collection and array ordering", () => {
  const normalized = decomposePlatform(seed);
  normalized.records.reverse();
  normalized.collections.reverse();
  assert.deepEqual(recomposePlatform(normalized), seed);
});

test("tampered manifests, missing rows, duplicate positions and mismatched identities fail closed", () => {
  const original = decomposePlatform(generated());
  for (const change of [
    (value) => value.records.pop(),
    (value) => {
      value.records.find(
        (row) => row.collection === "groups" && row.position === 1,
      ).position = 0;
    },
    (value) => {
      value.records[0].payload.id = "changed-without-key";
    },
    (value) => {
      value.records[0].collection = "unmanifested";
    },
    (value) => {
      value.rootKeys.push("unrepresented");
    },
    (value) => {
      value.rootPayload.extra = "unmanifested";
    },
    (value) => {
      value.records[0] = null;
    },
  ]) {
    const tampered = clone(original);
    change(tampered);
    assert.throws(
      () => recomposePlatform(tampered),
      (error) => error.code === "NORMALIZED_INVALID",
    );
  }
});

test("non-JSON and cyclic values are rejected rather than lost by JSON coercion", () => {
  const cycle = {};
  cycle.self = cycle;
  const hidden = {};
  Object.defineProperty(hidden, "secret", { value: 1 });
  const getter = {};
  Object.defineProperty(getter, "value", {
    enumerable: true,
    get() {
      throw Error("Getter must never execute");
    },
  });
  for (const value of [
    undefined,
    NaN,
    Infinity,
    new Date(),
    new Map(),
    { nested: undefined },
    [undefined],
    cycle,
    hidden,
    getter,
  ])
    assert.throws(
      () => decomposePlatform({ future: value }),
      (error) => error.code === "NORMALIZED_INVALID",
    );
});

test("special JSON property names cannot pollute prototypes", () => {
  const source = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":[{"prototype":{"polluted":true}}],"future":[{"__proto__":{"x":1}}]}',
  );
  const restored = recomposePlatform(decomposePlatform(source));
  assert.deepEqual(restored, source);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.hasOwn(restored, "__proto__"), true);
});

test("canonical checksum ignores object key order but preserves array order and every value", async () => {
  assert.equal(
    canonicalJson({ z: 1, a: { second: 2, first: 1 } }),
    canonicalJson({ a: { first: 1, second: 2 }, z: 1 }),
  );
  assert.equal(
    await platformChecksum({ b: 2, a: 1 }),
    await platformChecksum({ a: 1, b: 2 }),
  );
  assert.notEqual(
    await platformChecksum([1, 2]),
    await platformChecksum([2, 1]),
  );
  assert.notEqual(
    await platformChecksum({ missing: null }),
    await platformChecksum({}),
  );
});

test("a group-scoped legacy lesson edit remains valid after normalization and preserves other groups", () => {
  const before = generated();
  before.lessons[0].future = { keep: true };
  const after = mutate(before, owner, "lesson.save", {
    ...before.lessons[0],
    start: "09:00",
    end: "09:50",
  }).data;
  const normalized = decomposePlatform(after);
  assert.deepEqual(recomposePlatform(normalized), after);
  const scope = validateGroupScopedEdit(
    decomposePlatform(before),
    normalized,
    "g-0",
    { validateModel: validate },
  );
  assert.equal(scope.groupId, "g-0");
  assert.ok(scope.changed.some((row) => row.collection === "lessons"));
  assert.deepEqual(
    after.lessons.filter((lesson) => lesson.groupId === "g-1"),
    before.lessons.filter((lesson) => lesson.groupId === "g-1"),
  );
  assert.deepEqual(
    after.lessons.find((lesson) => lesson.id === "l-0-0").future,
    { keep: true },
  );
});

test("group-scoped checks reject edits to another group, global catalogs or source conflict allowances", () => {
  const before = generated();
  const variants = [
    () =>
      mutate(before, owner, "lesson.save", {
        ...before.lessons[1],
        start: "09:00",
        end: "09:50",
      }).data,
    () => {
      const value = clone(before);
      value.subjects[0].name = "Global change";
      return value;
    },
    () => {
      const value = clone(before);
      value.sourceConflictPairs = ["forged exception"];
      return value;
    },
  ];
  for (const variant of variants)
    assert.throws(
      () =>
        validateGroupScopedEdit(before, variant(), "g-0", {
          validateModel: validate,
        }),
      (error) => error.code === "NORMALIZED_INVALID",
    );
  assert.throws(
    () => validateGroupScopedEdit(before, before, "g-0"),
    (error) => error.code === "NORMALIZED_INVALID",
  );
});

test("normalization does not bypass cross-group room collisions or the bounded validator's size limit", () => {
  const before = generated();
  const colliding = clone(before);
  colliding.lessons[0].roomId = colliding.lessons[1].roomId;
  assert.throws(
    () =>
      validateGroupScopedEdit(
        before,
        recomposePlatform(decomposePlatform(colliding)),
        "g-0",
        { validateModel: validate },
      ),
    /Аудитория уже занята/,
  );
  assert.throws(
    () => validate(generated(100, 51)),
    /Неверный формат раздела lessons/,
  );
});

test("100 groups × 40 lessons roundtrip with deterministic keys and indexed projections", async (t) => {
  const source = generated(100, 40),
    timings = [];
  let normalized;
  for (let iteration = 0; iteration < 3; iteration++) {
    const start = performance.now();
    normalized = decomposePlatform(source, { sourceRevision: 5 });
    assert.deepEqual(recomposePlatform(normalized), source);
    timings.push(performance.now() - start);
  }
  const median = timings.slice().sort((a, b) => a - b)[1];
  assert.equal(
    normalized.collections.find((row) => row.name === "lessons").count,
    4000,
  );
  assert.equal(normalized.derived.subgroups.length, 200);
  assert.equal(normalized.derived.timeSlots.length, 8);
  assert.equal(
    await platformChecksum(recomposePlatform(normalized)),
    await platformChecksum(source),
  );
  t.diagnostic(
    JSON.stringify({
      fixtureGroups: 100,
      fixtureLessons: 4000,
      normalizationRoundtripMedianMs: Math.round(median),
      measuredRunsMs: timings.map(Math.round),
      scope: "local serialization only; no database/API load claim",
    }),
  );
});
