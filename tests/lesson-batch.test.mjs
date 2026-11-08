import { syntheticFixture } from "../scripts/normalized-dry-run.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeLessonBatch,
  buildLessonBatch,
} from "../backend/lesson-batch.mjs";
import { mutate, validate, previewLessonBatch } from "../backend/core.mjs";
const owner = { role: "admin", name: "Owner" };
function fixture() {
  return {
    groups: [
      {
        id: "g",
        name: "One",
        subgroups: ["А", "Б"],
        future: { private: "group marker" },
      },
      { id: "g2", name: "Two", subgroups: ["А", "Б"] },
    ],
    subjects: [
      { id: "s", name: "Subject" },
      { id: "s2", name: "Other" },
    ],
    teachers: [
      { id: "t", name: "Teacher", subjects: ["s", "s2"] },
      { id: "t2", name: "Other", subjects: ["s", "s2"] },
    ],
    rooms: [
      { id: "r", name: "101", capacity: 30 },
      { id: "r2", name: "102", capacity: 30 },
    ],
    lessons: [
      {
        id: "one",
        groupId: "g",
        subgroup: "all",
        subjectId: "s",
        teacherId: "t",
        roomId: "r",
        day: 0,
        week: "all",
        start: "09:00",
        end: "09:50",
        type: "Лекция",
        source: { sheet: "Original", cell: "C42", private: "source marker" },
        future: { private: "lesson marker", nested: [1, null, false] },
      },
      {
        id: "two",
        groupId: "g2",
        subgroup: "А",
        subjectId: "s",
        teacherId: "t2",
        roomId: "r2",
        day: 0,
        week: "all",
        start: "11:00",
        end: "11:50",
        type: "Практика",
      },
    ],
    exceptions: [],
    tasks: [],
    announcements: [],
    requests: [
      {
        id: "request",
        lessonId: "one",
        date: "2026-11-09",
        status: "rejected",
        before: { private: "request history" },
      },
    ],
    attendance: [
      {
        lessonId: "one",
        date: "2026-11-09",
        studentId: "private student",
        status: "present",
        after: { private: "attendance history" },
      },
    ],
    history: [{ id: "old", before: { private: "old immutable history" } }],
    sourceWarnings: [{ private: "warning marker" }],
    sourceConflictPairs: [],
    future: { private: "root marker" },
  };
}
const payload = (change, ids = ["one"]) => ({ ids, change });
const apply = (input, change, ids = ["one"]) =>
  mutate(input, owner, "lesson.batch", payload(change, ids)).data;

test("strict normalization accepts one action only and keeps exact IDs/type literals", () => {
  const value = payload({ kind: "type", value: "  Семинар  " }, [" one "]);
  assert.deepEqual(normalizeLessonBatch(value), value);
  for (const bad of [
    null,
    {},
    { ...value, metadata: "no" },
    { ids: [], change: value.change },
    { ids: ["one", "one"], change: value.change },
    {
      ids: Array.from({ length: 1001 }, (_, i) => "l" + i),
      change: value.change,
    },
    { ids: ["x".repeat(101)], change: value.change },
    { ids: [1], change: value.change },
    payload({ kind: "roomId", value: "r", teacherId: "t" }),
    payload({ kind: "patch", value: { source: "forged" } }),
    payload({ kind: "subjectId", value: "" }),
    payload({ kind: "type", value: " " }),
    payload({ kind: "type", value: "x".repeat(41) }),
    payload({ kind: "type", value: "Семинар", sourceConflictPairs: [] }),
  ])
    assert.throws(
      () => normalizeLessonBatch(bad),
      (error) => error.status === 400,
    );
  const max = payload(
    { kind: "type", value: "T" },
    Array.from({ length: 1000 }, (_, i) => "l" + i),
  );
  assert.equal(normalizeLessonBatch(max).ids.length, 1000);
});

test("setTime and shiftTime reject malformed values, invalid duration and unknown fields", () => {
  for (const change of [
    { kind: "setTime", start: "09:00", end: "10:00" },
    { kind: "setTime", start: "24:00", end: "01:00", endDayOffset: 0 },
    { kind: "setTime", start: "10:00", end: "09:00", endDayOffset: 0 },
    { kind: "setTime", start: "09:00", end: "09:00", endDayOffset: 0 },
    { kind: "setTime", start: "09:00", end: "10:00", endDayOffset: 1 },
    { kind: "setTime", start: "23:00", end: "01:00", endDayOffset: true },
    { kind: "shiftTime", minutes: 0 },
    { kind: "shiftTime", minutes: 1.5 },
    { kind: "shiftTime", minutes: 1440 },
    { kind: "shiftTime", minutes: -1440 },
    { kind: "shiftTime", minutes: "30" },
    { kind: "shiftTime", minutes: 10, day: 1 },
  ])
    assert.throws(
      () => normalizeLessonBatch(payload(change)),
      (error) => error.status === 400,
    );
  assert.equal(
    normalizeLessonBatch(
      payload({
        kind: "setTime",
        start: "09:00",
        end: "09:00",
        endDayOffset: 1,
      }),
    ).change.endDayOffset,
    1,
  );
});

test("all scalar actions apply losslessly and retain record ordering, private collections and immutable snapshots", () => {
  for (const change of [
    { kind: "roomId", value: "r2" },
    { kind: "teacherId", value: "t2" },
    { kind: "subjectId", value: "s2" },
    { kind: "type", value: "  Семинар  " },
  ]) {
    const input = fixture(),
      before = structuredClone(input),
      after = apply(input, change);
    assert.equal(after.lessons[0][change.kind], change.value);
    assert.deepEqual(
      after.lessons.map((row) => row.id),
      ["one", "two"],
    );
    for (const key of ["source", "future"])
      assert.deepEqual(after.lessons[0][key], input.lessons[0][key]);
    assert.deepEqual(after.lessons[1], input.lessons[1]);
    for (const key of [
      "exceptions",
      "requests",
      "attendance",
      "tasks",
      "announcements",
      "sourceWarnings",
      "sourceConflictPairs",
      "future",
    ])
      assert.deepEqual(after[key], input[key], key);
    assert.deepEqual(after.history[1], input.history[0]);
    assert.equal(after.history[0].action, "lesson.batch");
    assert.deepEqual(input, before);
  }
});

test("preview is closed, counts only changed rows/groups and exposes neither metadata nor private beforeimages", () => {
  const input = fixture();
  input.lessons[1].type = "Семинар";
  const before = structuredClone(input);
  const result = previewLessonBatch(
    input,
    payload({ kind: "type", value: "Семинар" }, ["two", "one"]),
  );
  assert.equal(result.valid, true);
  assert.equal(result.error, null);
  assert.equal(result.selectedCount, 2);
  assert.equal(result.changedCount, 1);
  assert.equal(result.unchangedCount, 1);
  assert.deepEqual(result.groups, [{ id: "g", name: "One", count: 1 }]);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].id, "one");
  assert.equal(result.changes[0].groupName, "One");
  assert.equal(result.changes[0].before.type, "Лекция");
  assert.equal(result.changes[0].after.type, "Семинар");
  for (const secret of [
    "source marker",
    "lesson marker",
    "request history",
    "attendance history",
    "old immutable history",
    "root marker",
    "warning marker",
    "group marker",
    "private student",
  ])
    assert.equal(JSON.stringify(result).includes(secret), false, secret);
  assert.equal(Object.hasOwn(result.changes[0].before, "source"), false);
  assert.deepEqual(input, before);
});

test("duplicate, unknown or changed IDs reject the entire request without partial preview changes", () => {
  for (const ids of [["one", "missing"], ["one", "one"], [" one "]]) {
    const input = fixture(),
      before = structuredClone(input),
      request = payload({ kind: "type", value: "Семинар" }, ids),
      preview = previewLessonBatch(input, request);
    assert.equal(preview.valid, false);
    assert.deepEqual(preview.changes, []);
    assert.deepEqual(preview.groups, []);
    assert.equal(preview.changedCount, 0);
    assert.equal(typeof preview.error, "string");
    assert.throws(
      () => mutate(input, owner, "lesson.batch", request),
      (error) => error.status === 400,
    );
    assert.deepEqual(input, before);
  }
});

test("semantic time no-op preserves absent offset and clearing already empty optional refs preserves literal presence", () => {
  const input = fixture();
  for (const change of [
    { kind: "type", value: "Лекция" },
    { kind: "setTime", start: "09:00", end: "09:50", endDayOffset: 0 },
  ]) {
    const plan = buildLessonBatch(input, payload(change));
    assert.deepEqual(plan.changedIds, []);
    assert.equal(Object.hasOwn(plan.lessons[0], "endDayOffset"), false);
    const result = previewLessonBatch(input, payload(change));
    assert.equal(result.valid, false);
    assert.equal(result.selectedCount, 1);
    assert.equal(result.unchangedCount, 1);
    assert.equal(result.changedCount, 0);
    assert.deepEqual(result.changes, []);
    assert.throws(
      () => apply(input, change),
      (error) => error.status === 400,
    );
  }
  for (const kind of ["roomId", "teacherId"])
    for (const previous of [null, "", undefined]) {
      const data = fixture();
      if (previous === undefined) delete data.lessons[0][kind];
      else data.lessons[0][kind] = previous;
      const plan = buildLessonBatch(data, payload({ kind, value: "" }));
      assert.deepEqual(plan.changedIds, []);
      assert.equal(
        Object.hasOwn(plan.lessons[0], kind),
        Object.hasOwn(data.lessons[0], kind),
      );
      assert.equal(plan.lessons[0][kind], previous);
      assert.throws(
        () => apply(data, { kind, value: "" }),
        (error) => error.status === 400,
      );
    }
  assert.equal(input.history.length, 1);
  assert.equal(input.announcements.length, 0);
});

test("fixed time applies explicit offset only when needed and preserves weekly assignment/bounds", () => {
  const input = fixture();
  input.lessons[0].week = "odd";
  input.lessons[0].validFrom = "2026-01-01";
  input.lessons[0].validUntil = "2026-12-31";
  const after = apply(input, {
    kind: "setTime",
    start: "23:00",
    end: "01:00",
    endDayOffset: 1,
  });
  assert.equal(after.lessons[0].endDayOffset, 1);
  assert.equal(after.lessons[0].day, 0);
  assert.equal(after.lessons[0].week, "odd");
  assert.equal(after.lessons[0].validFrom, "2026-01-01");
  assert.deepEqual(after.lessons[0].source, input.lessons[0].source);
  const earlier = apply(input, {
    kind: "setTime",
    start: "08:00",
    end: "08:50",
    endDayOffset: 0,
  });
  assert.equal(Object.hasOwn(earlier.lessons[0], "endDayOffset"), false);
});

test("shift preserves duration across midnight without moving the start weekday/parity", () => {
  for (const [
    start,
    end,
    offset,
    minutes,
    expectedStart,
    expectedEnd,
    expectedOffset,
  ] of [
    ["23:00", "01:00", 1, -120, "21:00", "23:00", 0],
    ["23:00", "01:00", 1, 30, "23:30", "01:30", 1],
    ["20:00", "21:00", 0, 210, "23:30", "00:30", 1],
    ["00:00", "00:00", 1, 1439, "23:59", "23:59", 1],
  ]) {
    const input = fixture();
    Object.assign(input.lessons[0], {
      start,
      end,
      endDayOffset: offset,
      day: 6,
      week: "odd",
    });
    const result = apply(input, { kind: "shiftTime", minutes }).lessons[0];
    assert.equal(result.start, expectedStart);
    assert.equal(result.end, expectedEnd);
    assert.equal(result.endDayOffset, expectedOffset);
    assert.equal(result.day, 6);
    assert.equal(result.week, "odd");
  }
});

test("late shift failure never returns a partial first-row plan or changes input", () => {
  const input = fixture();
  input.lessons[0].start = "00:30";
  input.lessons[0].end = "01:30";
  const before = structuredClone(input);
  const request = payload({ kind: "shiftTime", minutes: -60 }, ["two", "one"]);
  const preview = previewLessonBatch(input, request);
  assert.equal(preview.valid, false);
  assert.deepEqual(preview.changes, []);
  assert.throws(
    () => mutate(input, owner, "lesson.batch", request),
    (error) => error.status === 400,
  );
  assert.deepEqual(input, before);
  const late = fixture();
  late.lessons[1].start = "23:30";
  late.lessons[1].end = "23:50";
  assert.throws(() =>
    apply(late, { kind: "shiftTime", minutes: 60 }, ["one", "two"]),
  );
});

test("shared sessions change atomically before one whole-model validation", () => {
  const input = fixture();
  input.lessons[0].sharedSessionId = "session";
  input.lessons[1] = {
    ...structuredClone(input.lessons[0]),
    id: "two",
    groupId: "g2",
  };
  assert.equal(validate(input), true);
  const one = { ...input.lessons[0], start: "09:10", end: "10:00" };
  assert.throws(() => mutate(input, owner, "lesson.save", one));
  const request = payload({ kind: "shiftTime", minutes: 10 }, ["one", "two"]);
  const preview = previewLessonBatch(input, request);
  assert.equal(preview.valid, true);
  assert.equal(preview.changedCount, 2);
  const after = mutate(input, owner, "lesson.batch", request).data;
  assert.equal(validate(after), true);
  assert.deepEqual(
    after.lessons.map((row) => row.start),
    ["09:10", "09:10"],
  );
  assert.deepEqual(
    after.lessons.map((row) => row.sharedSessionId),
    ["session", "session"],
  );
});

test("bad catalog assignment, teacher subject mismatch and new collision reject every selected change", () => {
  for (const change of [
    { kind: "roomId", value: "missing" },
    { kind: "teacherId", value: "missing" },
    { kind: "subjectId", value: "missing" },
  ]) {
    const input = fixture(),
      request = payload(change, ["one", "two"]);
    assert.equal(previewLessonBatch(input, request).valid, false);
    assert.throws(
      () => mutate(input, owner, "lesson.batch", request),
      (error) => error.status === 400,
    );
  }
  const input = fixture();
  input.teachers[1].subjects = ["s2"];
  assert.equal(
    previewLessonBatch(input, payload({ kind: "teacherId", value: "t2" }))
      .valid,
    false,
  );
  const collision = fixture();
  Object.assign(collision.lessons[1], { start: "09:00", end: "09:50" });
  assert.equal(validate(collision), true);
  const request = payload({ kind: "roomId", value: "r2" });
  const result = previewLessonBatch(collision, request);
  assert.equal(result.valid, false);
  assert.equal(result.changedCount, 1);
  assert.equal(result.changes.length, 1);
  assert.match(result.error, /Аудитория/);
  assert.throws(() => mutate(collision, owner, "lesson.batch", request));
  assert.deepEqual(collision.sourceConflictPairs, []);
});

test("only owner can apply a batch and malformed source preview returns a static message without a stack", () => {
  for (const role of ["guest", "student", "teacher"])
    assert.throws(
      () =>
        mutate(
          fixture(),
          { role },
          "lesson.batch",
          payload({ kind: "type", value: "Семинар" }),
        ),
      (error) => error.status === 403,
    );
  const input = fixture();
  input.groups = { private: "do not reveal" };
  const result = previewLessonBatch(
    input,
    payload({ kind: "type", value: "Семинар" }),
  );
  assert.equal(result.valid, false);
  assert.equal(JSON.stringify(result).includes("do not reveal"), false);
  assert.equal(result.error.includes("TypeError"), false);
  assert.equal(result.error.includes(" at "), false);
});

test("the bounded4000-lesson synthetic model validates,5001 rejects and other collections retain3000 cap", () => {
  const data = syntheticFixture();
  assert.equal(data.lessons.length, 4000);
  assert.equal(validate(data), true);
  const tooMany = structuredClone(data);
  tooMany.lessons.push(
    ...Array.from({ length: 1001 }, (_, i) => ({
      ...data.lessons[0],
      id: "extra-" + i,
    })),
  );
  assert.equal(tooMany.lessons.length, 5001);
  assert.throws(
    () => validate(tooMany),
    (error) => error.status === 400 && error.message.includes("lessons"),
  );
  const catalog = fixture();
  catalog.rooms = Array.from({ length: 3001 }, (_, i) => ({
    id: "room-" + i,
    name: "Room " + i,
    capacity: 30,
  }));
  assert.throws(
    () => validate(catalog),
    (error) => error.status === 400 && error.message.includes("rooms"),
  );
});
