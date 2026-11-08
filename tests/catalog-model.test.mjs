import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  mutate,
  validate,
  catalogImpact,
  occurrences,
  isGroupActive,
} from "../backend/core.mjs";
import { lessonsForDate, changesForDate, timeline } from "../app/lib/time.mjs";
import { findConflicts } from "../app/conflicts.mjs";
const owner = { role: "admin", name: "Owner" };
const date = "2026-11-09";
function fixture() {
  return {
    groups: [
      { id: "g", name: "Group", subgroups: ["А", "Б"], future: { keep: true } },
      { id: "g2", name: "Other", subgroups: ["А", "Б"] },
    ],
    subjects: [
      { id: "s", name: "Subject", color: "#224466" },
      { id: "s2", name: "Other" },
    ],
    teachers: [
      { id: "t", name: "Teacher", subjects: ["s", "s2"] },
      { id: "t2", name: "Other", subjects: ["s", "s2"] },
    ],
    rooms: [
      { id: "r", name: "101", capacity: 30, future: { owner: "PRIVATE" } },
      { id: "r2", name: "102", capacity: 30 },
    ],
    lessons: [
      {
        id: "l",
        day: 0,
        week: "all",
        start: "09:00",
        end: "09:50",
        groupId: "g",
        subgroup: "А",
        subjectId: "s",
        teacherId: "t",
        roomId: "r",
        source: { row: 42 },
        sharedSessionId: "original",
      },
    ],
    exceptions: [],
    tasks: [],
    announcements: [],
    requests: [],
    attendance: [],
    holidays: [],
    history: [],
    sourceWarnings: [{ row: 42, warning: "original" }],
    sourceConflictPairs: [],
    future: { retain: true },
  };
}
const edit = (data, op, payload) => mutate(data, owner, op, payload).data;
function linked(data) {
  data.exceptions.push({
    id: "ex",
    lessonId: "l",
    date,
    status: "cancelled",
    roomId: "r",
    subjectId: "s",
    future: { keep: "ex" },
  });
  data.tasks.push({
    id: "task",
    title: "Task",
    description: "",
    groupId: "g",
    subgroup: "А",
    subjectId: "s",
    teacherId: "t",
    roomId: "r",
    due: date,
    future: { keep: "task" },
  });
  data.announcements.push({
    id: "news",
    title: "News",
    body: "Body",
    roles: ["student"],
    groupId: "g",
    teacherId: "t",
    subjectId: "s",
    roomId: "r",
  });
  data.requests.push({
    id: "req",
    lessonId: "l",
    date,
    status: "rejected",
    teacherId: "t",
    roomId: "r",
    groupId: "g",
    subjectId: "s",
    future: { keep: "private" },
  });
  data.attendance.push({
    lessonId: "l",
    date,
    studentId: "private-student",
    status: "present",
    groupId: "g",
    teacherId: "t",
    roomId: "r",
    subjectId: "s",
    future: { keep: "private" },
  });
  data.holidays.push({
    id: "holiday",
    start: "2026-12-01",
    end: "2026-12-02",
    groupId: "g",
    roomId: "r",
  });
  return data;
}

test("catalog partial edit preserves unknown metadata, array position and all source identity", () => {
  const data = fixture();
  const before = structuredClone(data);
  const result = edit(data, "catalog.save", {
    entity: "groups",
    item: { id: "g", name: "Renamed", language: "", code: "NEW" },
  });
  assert.equal(result.groups[0].name, "Renamed");
  assert.deepEqual(result.groups[0].future, data.groups[0].future);
  assert.deepEqual(result.groups[0].subgroups, ["А", "Б"]);
  for (const key of [
    "lessons",
    "sourceWarnings",
    "sourceConflictPairs",
    "future",
  ])
    assert.deepEqual(result[key], data[key]);
  assert.deepEqual(data, before);
  assert.throws(
    () =>
      edit(data, "catalog.save", {
        entity: "groups",
        item: { id: "g", future: { replace: true } },
      }),
    /Неизвестное поле/,
  );
});

test("authored catalog fields reject malformed values and lifecycle cannot be forged through save", () => {
  for (const [entity, item] of [
    ["groups", { id: "g", subgroups: ["А", "А"] }],
    ["groups", { id: "g", subgroups: ["all"] }],
    ["groups", { id: "g", archivedAt: null }],
    ["groups", { id: "g", language: "javascript" }],
    ["subjects", { id: "s", shortName: "x".repeat(61) }],
    ["subjects", { id: "s", color: "url(https://invalid)" }],
    ["rooms", { id: "r", capacity: 0 }],
    ["rooms", { id: "r", floor: 2 }],
    ["rooms", { id: "r", note: "x".repeat(1001) }],
    ["teachers", { id: "t", subjects: ["s", "s"] }],
  ])
    assert.throws(
      () => edit(fixture(), "catalog.save", { entity, item }),
      undefined,
      JSON.stringify(item),
    );
  const data = edit(fixture(), "catalog.save", {
    entity: "rooms",
    item: {
      id: "r",
      building: "A",
      floor: "цоколь",
      note: "Owner only",
      capacityEstimated: true,
    },
  });
  assert.equal(data.rooms[0].floor, "цоколь");
});

test("catalog duplicate copies authored metadata only, generates UUID and no fake lessons/assignments/invite", () => {
  for (const entity of ["groups", "subjects", "teachers", "rooms"]) {
    const data = fixture();
    const source = data[entity][0];
    source.provenance = { source: "must not copy" };
    if (entity === "groups") {
      source.code = "INVITE";
      source.archivedAt = "2026-01-01T00:00:00.000Z";
    }
    const result = edit(data, "catalog.duplicate", {
      entity,
      id: source.id,
      name: "Copy",
    });
    const copy = result[entity].at(-1);
    assert.match(copy.id, /^[a-f0-9-]{36}$/);
    assert.notEqual(copy.id, source.id);
    assert.equal(copy.name, "Copy");
    assert.equal(Object.hasOwn(copy, "provenance"), false);
    assert.equal(Object.hasOwn(copy, "future"), false);
    assert.equal(Object.hasOwn(copy, "archivedAt"), false);
    if (entity === "groups") assert.equal(copy.code, "");
    if (entity === "teachers") assert.deepEqual(copy.subjects, []);
    assert.deepEqual(result.lessons, data.lessons);
  }
});

test("impact includes unique direct, cancelled, indirect lesson, private and teacher-assignment references", () => {
  const data = linked(fixture());
  assert.deepEqual(catalogImpact(data, "rooms", "r"), {
    counts: {
      lessons: 1,
      exceptions: 1,
      tasks: 1,
      announcements: 1,
      requests: 1,
      attendance: 1,
      holidays: 1,
      teachers: 0,
    },
    total: 7,
    blockers: [],
  });
  assert.equal(catalogImpact(data, "subjects", "s").counts.teachers, 2);
  delete data.requests[0].roomId;
  delete data.attendance[0].roomId;
  assert.equal(catalogImpact(data, "rooms", "r").counts.requests, 1);
  assert.equal(catalogImpact(data, "rooms", "r").counts.attendance, 1);
});

test("delete refuses isolated references in every operational collection including cancelled override and rejected request", () => {
  const all = linked(fixture());
  for (const collection of [
    "exceptions",
    "tasks",
    "announcements",
    "requests",
    "attendance",
    "holidays",
  ]) {
    const data = fixture();
    data.lessons[0].roomId = "r2";
    data[collection] = structuredClone(all[collection]);
    assert.throws(
      () => edit(data, "catalog.delete", { entity: "rooms", id: "r" }),
      /используется/,
      collection,
    );
    assert.equal(validate(data), true);
  }
  const result = edit(fixture(), "catalog.delete", {
    entity: "rooms",
    id: "r2",
  });
  assert.equal(result.rooms.length, 1);
});

test("historical nested before/after snapshots block destructive edits and are never rewritten", () => {
  const data = fixture();
  data.requests.push({
    id: "request",
    lessonId: "l",
    date,
    status: "rejected",
    before: { nested: { roomId: "r2" } },
  });
  const impact = catalogImpact(data, "rooms", "r2");
  assert.equal(impact.counts.requests, 1);
  assert.equal(impact.blockers[0].path, "before.nested");
  for (const op of ["catalog.delete", "catalog.replace"])
    assert.throws(() =>
      edit(data, op, { entity: "rooms", id: "r2", replacementId: "r" }),
    );
  const imported = structuredClone(data);
  imported.rooms = imported.rooms.filter((row) => row.id !== "r2");
  assert.throws(
    () => edit(data, "import", { data: imported }),
    /Исторический снимок/,
  );
  assert.equal(data.requests[0].before.nested.roomId, "r2");
});

test("explicit replacement repoints every operational reference without cascading rows or metadata", () => {
  const data = linked(fixture());
  const original = structuredClone(data);
  const result = edit(data, "catalog.replace", {
    entity: "rooms",
    id: "r",
    replacementId: "r2",
  });
  assert.equal(result.rooms.length, 1);
  for (const collection of [
    "lessons",
    "exceptions",
    "tasks",
    "announcements",
    "requests",
    "attendance",
    "holidays",
  ]) {
    assert.equal(result[collection].length, data[collection].length);
    assert.equal(result[collection][0].roomId, "r2");
    assert.deepEqual(result[collection][0].future, data[collection][0].future);
  }
  assert.equal(result.lessons[0].id, "l");
  assert.equal(result.lessons[0].sharedSessionId, "original");
  assert.deepEqual(result.lessons[0].source, { row: 42 });
  assert.deepEqual(data, original);
});

test("subject replacement deduplicates teacher assignment while subgroup/subject mismatches reject atomically", () => {
  const data = fixture();
  const result = edit(data, "catalog.replace", {
    entity: "subjects",
    id: "s",
    replacementId: "s2",
  });
  assert.deepEqual(result.teachers[0].subjects, ["s2"]);
  assert.equal(result.lessons[0].subjectId, "s2");
  data.groups[1].subgroups = ["Б"];
  assert.throws(
    () =>
      edit(data, "catalog.replace", {
        entity: "groups",
        id: "g",
        replacementId: "g2",
      }),
    /Подгруппа/,
  );
  data.teachers[1].subjects = [];
  assert.throws(
    () =>
      edit(data, "catalog.replace", {
        entity: "teachers",
        id: "t",
        replacementId: "t2",
      }),
    /не назначен/,
  );
  assert.equal(data.lessons[0].groupId, "g");
});

test("reassignment cannot forge conflict exemptions or silently merge colliding resource slots", () => {
  const data = fixture();
  data.lessons.push({
    ...data.lessons[0],
    id: "other",
    groupId: "g2",
    teacherId: "t2",
    roomId: "r2",
    sharedSessionId: "",
  });
  assert.equal(validate(data), true);
  assert.throws(
    () =>
      edit(data, "catalog.replace", {
        entity: "rooms",
        id: "r",
        replacementId: "r2",
      }),
    /Аудитория уже занята/,
  );
  assert.deepEqual(data.sourceConflictPairs, []);
});

test("import intents use fresh private rows and allow a newly created target without trusting uploaded private arrays", () => {
  const fresh = linked(fixture());
  const draft = edit(fresh, "catalog.save", {
    entity: "rooms",
    item: { id: "new-room", name: "New", capacity: 40 },
  });
  const candidate = edit(draft, "catalog.replace", {
    entity: "rooms",
    id: "r",
    replacementId: "new-room",
  });
  fresh.requests[0].future = { changedAfterDraft: true };
  fresh.requests.push({
    id: "late",
    lessonId: "l",
    date,
    status: "pending",
    roomId: "r",
    future: { private: "late" },
  });
  candidate.requests = [{ forged: true }];
  candidate.attendance = [{ forged: true }];
  const result = edit(fresh, "import", {
    data: candidate,
    catalogReplacements: [
      { entity: "rooms", id: "r", replacementId: "new-room" },
    ],
  });
  assert.equal(result.requests.length, 2);
  assert.equal(result.requests[1].roomId, "new-room");
  assert.deepEqual(result.requests[0].future, { changedAfterDraft: true });
  assert.equal(result.attendance[0].roomId, "new-room");
  assert.equal(result.attendance[0].studentId, "private-student");
  assert.deepEqual(result.sourceWarnings, fresh.sourceWarnings);
  assert.deepEqual(result.sourceConflictPairs, fresh.sourceConflictPairs);
  assert.throws(
    () => edit(fresh, "import", { data: candidate }),
    /Ссылка справочника/,
  );
});

test("replacement intents reject chains, cycles, duplicate sources, unknown fields and stale source/target", () => {
  const data = fixture();
  const candidate = edit(data, "catalog.replace", {
    entity: "rooms",
    id: "r",
    replacementId: "r2",
  });
  for (const intents of [
    [{ entity: "rooms", id: "r", replacementId: "r2", before: "private" }],
    [
      { entity: "rooms", id: "r", replacementId: "r2" },
      { entity: "rooms", id: "r", replacementId: "r2" },
    ],
    [
      { entity: "rooms", id: "r", replacementId: "r2" },
      { entity: "rooms", id: "r2", replacementId: "r" },
    ],
    [{ entity: "rooms", id: "missing", replacementId: "r2" }],
    [{ entity: "rooms", id: "r", replacementId: "missing" }],
  ])
    assert.throws(() =>
      edit(data, "import", { data: candidate, catalogReplacements: intents }),
    );
  assert.throws(
    () =>
      edit(data, "import", {
        data,
        catalogReplacements: [
          { entity: "rooms", id: "r", replacementId: "r2" },
        ],
      }),
    /Источник или цель/,
  );
});

test("archive hides public recurring/moved/previous-night events and releases resources but retains owner editing", () => {
  let data = fixture();
  data.lessons[0].start = "23:00";
  data.lessons[0].end = "01:00";
  data.lessons[0].endDayOffset = 1;
  data.exceptions.push({
    id: "ex",
    lessonId: "l",
    date,
    status: "moved",
    targetDate: "2026-11-11",
  });
  const archived = edit(data, "group.archive", { id: "g", archived: true });
  assert.equal(isGroupActive(archived.groups[0]), false);
  assert.equal(occurrences(archived, "2026-11-11").length, 1);
  assert.deepEqual(
    occurrences(archived, "2026-11-11", { activeOnly: true }),
    [],
  );
  assert.deepEqual(lessonsForDate(archived, "2026-11-11"), []);
  assert.deepEqual(changesForDate(archived, date), []);
  assert.equal(
    timeline(archived, { groupId: "g" }, new Date("2026-11-12T00:30:00+05:00"))
      .current,
    null,
  );
  assert.deepEqual(archived.lessons, data.lessons);
  assert.deepEqual(archived.exceptions, data.exceptions);
});

test("restore validates new active collisions and canonical null overrides archive aliases without reviving deleted groups", () => {
  const data = fixture();
  data.groups[0].archived = true;
  assert.equal(isGroupActive(data.groups[0]), false);
  const restored = edit(data, "group.archive", { id: "g", archived: false });
  assert.equal(restored.groups[0].archivedAt, null);
  assert.equal(restored.groups[0].archived, true);
  assert.equal(isGroupActive(restored.groups[0]), true);
  const archived = edit(fixture(), "group.archive", {
    id: "g",
    archived: true,
  });
  archived.lessons.push({
    ...archived.lessons[0],
    id: "other",
    groupId: "g2",
    teacherId: "t2",
    sharedSessionId: "",
  });
  assert.equal(validate(archived), true);
  assert.deepEqual(findConflicts(archived), []);
  assert.throws(
    () => edit(archived, "group.archive", { id: "g", archived: false }),
    /Аудитория уже занята/,
  );
  archived.groups[0].deleted = true;
  assert.throws(
    () => edit(archived, "group.archive", { id: "g", archived: false }),
    /Удалённую группу/,
  );
  assert.equal(isGroupActive({ deleted: true, archivedAt: null }), false);
  assert.equal(isGroupActive(undefined), true);
});

test("all new catalog operations require owner role even when UI and payload claim otherwise", () => {
  for (const role of ["guest", "student", "teacher"])
    for (const op of [
      "catalog.save",
      "catalog.delete",
      "catalog.replace",
      "catalog.duplicate",
      "group.archive",
    ])
      assert.throws(
        () =>
          mutate(fixture(), { role }, op, {
            entity: "rooms",
            id: "r2",
            replacementId: "r",
            name: "Copy",
            archived: true,
            item: { id: "r", name: "Edit" },
            role: "admin",
          }),
        (error) => error.status === 403,
      );
});

test("original 524-lesson fixture survives renaming, metadata duplicates and archive/restore with every source field intact", () => {
  const original = JSON.parse(
    readFileSync(new URL("../app/seed.json", import.meta.url), "utf8"),
  );
  let data = structuredClone(original);
  for (const entity of ["groups", "teachers", "subjects", "rooms"]) {
    const id = data[entity][0].id;
    data = edit(data, "catalog.save", {
      entity,
      item: { id, name: "Renamed " + entity },
    });
    data = edit(data, "catalog.duplicate", {
      entity,
      id,
      name: "Copy " + entity,
    });
  }
  data = edit(data, "group.archive", { id: data.groups[0].id, archived: true });
  data = edit(data, "group.archive", {
    id: data.groups[0].id,
    archived: false,
  });
  assert.equal(validate(data), true);
  assert.equal(data.lessons.length, 524);
  assert.equal(data.sourceWarnings.length, 54);
  assert.equal(data.sourceConflictPairs.length, 133);
  for (const key of [
    "lessons",
    "exceptions",
    "requests",
    "attendance",
    "source",
    "sourceWarnings",
    "sourceConflictPairs",
  ])
    assert.deepEqual(data[key], original[key]);
});

test("new group aliases cannot hijack any other id/name/code, while unchanged historical aliases survive unrelated edits", () => {
  const data = fixture();
  data.groups[1].code = "INVITE";
  for (const item of [
    { id: "g", code: "g2" },
    { id: "g", code: "Other" },
    { id: "g", code: "INVITE" },
    { id: "g", name: "INVITE" },
    { id: "g", name: "g2" },
  ])
    assert.throws(
      () => edit(data, "catalog.save", { entity: "groups", item }),
      /совпадает/,
    );
  const imported = structuredClone(data);
  imported.groups[0].code = "g2";
  assert.throws(() => edit(data, "import", { data: imported }), /совпадает/);
  data.groups[0].code = "Other";
  assert.equal(
    edit(data, "catalog.save", {
      entity: "groups",
      item: { id: "g", specialty: "Preserved historical alias" },
    }).groups[0].code,
    "Other",
  );
  for (const subgroups of [
    ["А", " А "],
    [" А ", "Б"],
    ["", "Б"],
  ])
    assert.throws(() =>
      edit(fixture(), "catalog.save", {
        entity: "groups",
        item: { id: "g", subgroups },
      }),
    );
});

test("changed imported subgroup labels follow authored validation without rewriting unchanged legacy whitespace", () => {
  const data = fixture();
  data.groups[0].subgroups = [" А ", "Б"];
  data.lessons[0].subgroup = " А ";
  assert.equal(
    edit(data, "catalog.save", {
      entity: "groups",
      item: { id: "g", specialty: "Unrelated metadata" },
    }).groups[0].subgroups[0],
    " А ",
  );
  const candidate = structuredClone(data);
  candidate.groups[0].subgroups = ["А", " А ", "Б"];
  assert.throws(() => edit(data, "import", { data: candidate }), /подгруппы/);
});
