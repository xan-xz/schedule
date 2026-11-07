import test from "node:test";
import assert from "node:assert/strict";
import {
  createTemplate,
  applyTemplate,
  loadTemplates,
  saveTemplate,
  renameTemplate,
  deleteTemplate,
} from "../beta/manage/templates.mjs";

function fixture() {
  return {
    groups: [
      { id: "g", name: "Group", subgroups: ["А", "Б"] },
      { id: "other", name: "Other", subgroups: ["А", "Б"] },
    ],
    subjects: [{ id: "s", name: "Subject", privateNote: "not copied" }],
    teachers: [
      { id: "t", name: "Teacher", subjects: ["s"], password: "not copied" },
    ],
    rooms: [{ id: "r", name: "101", capacity: 30 }],
    lessons: [
      {
        id: "l",
        groupId: "g",
        subgroup: "А",
        day: 0,
        week: "odd",
        start: "09:00",
        end: "09:50",
        subjectId: "s",
        teacherId: "t",
        roomId: "r",
        type: "Lecture",
        source: { cell: "C2" },
        sharedSessionId: "shared",
      },
    ],
    exceptions: [],
    tasks: [],
    announcements: [],
    requests: [],
    attendance: [],
    history: [],
    accounts: [{ password: "do not copy" }],
    token: "not copied",
    sourceConflictPairs: [],
    sourceWarnings: ["keep"],
  };
}
const options = {
  name: "Monday",
  kind: "day",
  day: 0,
  groupId: "g",
  subgroup: "А",
};
function memory() {
  const data = new Map();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  };
}
test("named day captures only scoped regular schedule and referenced public labels, never private state", () => {
  const d = fixture(),
    before = structuredClone(d),
    template = createTemplate(d, options);
  assert.equal(template.name, "Monday");
  assert.equal(template.lessons.length, 1);
  assert.deepEqual(template.refs.subjects, [{ id: "s", name: "Subject" }]);
  assert.deepEqual(
    Object.keys(template.lessons[0]).sort(),
    [
      "day",
      "week",
      "start",
      "end",
      "subjectId",
      "teacherId",
      "roomId",
      "type",
      "subgroup",
    ].sort(),
  );
  assert.doesNotMatch(
    JSON.stringify(template),
    /accounts|token|password|privateNote|sourceConflictPairs|sharedSessionId|C2/,
  );
  assert.deepEqual(d, before);
});
test("day application adds new IDs only in target scope, preserves all existing data and checks whole draft", () => {
  const d = fixture(),
    before = structuredClone(d),
    template = createTemplate(d, options);
  const result = applyTemplate(d, template, {
    groupId: "other",
    subgroup: "Б",
    toDay: 1,
  });
  assert.equal(result.lessons.length, 2);
  assert.notEqual(result.lessons[1].id, d.lessons[0].id);
  assert.equal(result.lessons[1].groupId, "other");
  assert.equal(result.lessons[1].subgroup, "Б");
  assert.equal(result.lessons[1].day, 1);
  assert.deepEqual(result.sourceWarnings, d.sourceWarnings);
  assert.deepEqual(result.accounts, d.accounts);
  assert.deepEqual(d, before);
  assert.throws(
    () => applyTemplate(d, template, { groupId: "g", subgroup: "А", toDay: 0 }),
    /занята|занят/,
  );
  assert.deepEqual(d, before);
});
test("week template preserves day, parity and overnight/date bounds; date overrides are not included", () => {
  const d = fixture();
  d.lessons[0] = {
    ...d.lessons[0],
    start: "23:00",
    end: "01:00",
    endDayOffset: 1,
    validFrom: "2026-11-01",
    validUntil: "2026-12-01",
  };
  d.exceptions = [
    {
      lessonId: "l",
      date: "2026-11-02",
      status: "cancelled",
      note: "not copied",
    },
  ];
  const template = createTemplate(d, { ...options, kind: "week" });
  const target = structuredClone(d);
  target.lessons[0].day = 1;
  target.exceptions[0].date = "2026-11-03";
  const result = applyTemplate(target, template, {
    groupId: "other",
    subgroup: "Б",
  });
  assert.equal(result.lessons[1].day, 0);
  assert.equal(result.lessons[1].week, "odd");
  assert.equal(result.lessons[1].endDayOffset, 1);
  assert.equal(result.lessons[1].validUntil, "2026-12-01");
  assert.equal(result.exceptions.length, 1);
  assert.equal(result.exceptions[0].lessonId, "l");
  assert.doesNotMatch(JSON.stringify(template), /cancelled|note/);
});
test("applying invalid catalog refs and all-subgroup audiences fails without implicit remapping or grandfathering", () => {
  const d = fixture();
  const template = createTemplate(d, options);
  const noTeacher = fixture();
  noTeacher.teachers = [];
  assert.throws(
    () =>
      applyTemplate(noTeacher, template, {
        groupId: "g",
        subgroup: "А",
        toDay: 1,
      }),
    /Teacher/,
  );
  const both = createTemplate(d, { ...options, subgroup: "all" });
  assert.throws(
    () => applyTemplate(d, both, { groupId: "other", subgroup: "Б", toDay: 1 }),
    /обе/,
  );
  const bad = {
    ...template,
    lessons: [
      { ...template.lessons[0], sharedSessionId: "bypass", source: "no" },
    ],
    sourceConflictPairs: ["forged"],
  };
  const clean = applyTemplate(d, bad, {
    groupId: "g",
    subgroup: "А",
    toDay: 1,
  });
  assert.equal(clean.lessons[1].sharedSessionId, undefined);
  assert.deepEqual(clean.sourceConflictPairs, []);
});
test("save/rename/delete are local, bounded, mode-separated and never silently overwrite same-name templates", () => {
  const store = memory(),
    first = createTemplate(fixture(), options),
    second = createTemplate(fixture(), { ...options, name: "Tuesday" });
  saveTemplate("demo", first, store);
  saveTemplate("demo", second, store);
  assert.equal(loadTemplates("live", store).length, 0);
  assert.equal(loadTemplates("demo", store).length, 2);
  assert.throws(
    () =>
      saveTemplate(
        "demo",
        createTemplate(fixture(), { ...options, name: "monday" }),
        store,
      ),
    /уже есть/,
  );
  assert.throws(
    () => renameTemplate("demo", second.id, "MONDAY", store),
    /уже есть/,
  );
  renameTemplate("demo", first.id, "Renamed", store);
  assert.equal(loadTemplates("demo", store)[0].name, "Renamed");
  deleteTemplate("demo", first.id, store);
  assert.equal(loadTemplates("demo", store).length, 1);
  assert.equal(loadTemplates("demo", store)[0].id, second.id);
  assert.throws(() => deleteTemplate("demo", "missing", store), /не найден/);
});
test("malformed, overlarge or unavailable storage is safe and does not erase recoverable old data", () => {
  const store = memory(),
    key = "uf.schedule.templates.v1.demo",
    template = createTemplate(fixture(), options);
  store.setItem(key, "{broken");
  assert.deepEqual(loadTemplates("demo", store), []);
  assert.throws(() => saveTemplate("demo", template, store), /не перезаписаны/);
  assert.equal(store.getItem(key), "{broken");
  store.setItem(key, "x".repeat(250001));
  assert.deepEqual(loadTemplates("demo", store), []);
  assert.throws(() => saveTemplate("demo", template, store), /не перезаписаны/);
  const quota = {
    getItem: () => null,
    setItem: () => {
      throw Error("quota");
    },
  };
  assert.throws(() => saveTemplate("live", template, quota), /место/);
  assert.throws(
    () => createTemplate(fixture(), { ...options, name: "   " }),
    /Название/,
  );
  assert.throws(() => loadTemplates("unknown", store), /режим/);
});
test("template catalog caps are enforced without deleting existing templates", () => {
  const store = memory();
  for (let i = 0; i < 20; i++)
    saveTemplate(
      "demo",
      createTemplate(fixture(), { ...options, name: "Template " + i }),
      store,
    );
  assert.throws(
    () =>
      saveTemplate(
        "demo",
        createTemplate(fixture(), { ...options, name: "Extra" }),
        store,
      ),
    /не больше 20/,
  );
  assert.equal(loadTemplates("demo", store).length, 20);
  const d = fixture();
  d.lessons = Array.from({ length: 101 }, (_, i) => ({
    ...d.lessons[0],
    id: "l" + i,
  }));
  assert.throws(() => createTemplate(d, options), /100 занятий/);
});
