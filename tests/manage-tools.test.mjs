import test from "node:test";
import assert from "node:assert/strict";
import {
  parseScheduleCsv,
  previewScheduleCsv,
  exportScheduleCsv,
  copyDay,
  copyWeek,
} from "../app/manage/tools.mjs";
import { conflictPairKey } from "../backend/core.mjs";
function fixture() {
  return {
    groups: [
      { id: "g", name: "Group", subgroups: ["А", "Б"] },
      { id: "other", name: "Other", subgroups: ["А", "Б"] },
    ],
    teachers: [{ id: "t", name: "Teacher", subjects: ["s"] }],
    subjects: [{ id: "s", name: "Subject" }],
    rooms: [{ id: "r", name: "101", capacity: 30 }],
    lessons: [
      {
        id: "l1",
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
        source: { cell: "B2" },
      },
    ],
    exceptions: [],
    tasks: [],
    announcements: [],
    requests: [],
    attendance: [],
    history: [],
    sourceWarnings: ["Keep"],
    sourceConflictPairs: [],
  };
}
const scope = { groupId: "g", subgroup: "all" };
test("CSV accepts BOM, commas/semicolons and RFC4180 quoted multiline catalog names", () => {
  const d = fixture();
  d.lessons = [];
  d.subjects[0].name = 'Subject; "quoted"\nsecond line';
  const csv =
    '\uFEFFday;start;end;subject;room;teacher;type;subgroup;week\r\n0;09:00;09:50;"Subject; ""quoted""\nsecond line";101;Teacher;Lecture;А;odd';
  const saved = parseScheduleCsv(csv, d, scope);
  assert.equal(saved.lessons.length, 1);
  assert.equal(saved.lessons[0].subjectId, "s");
  assert.deepEqual(d.lessons, []);
});
test("CSV defaults to append and refuses collisions instead of replacing schedule", () => {
  const d = fixture(),
    csv =
      "day,start,end,subject,room,teacher,type,subgroup,week\n0,09:00,09:50,Subject,101,Teacher,Lecture,А,odd";
  assert.throws(() => parseScheduleCsv(csv, d, scope), /занята|занят/);
  assert.equal(d.lessons.length, 1);
  const good = csv.replace("0,09:00", "1,09:00");
  const saved = parseScheduleCsv(good, d, scope);
  assert.equal(saved.lessons.length, 2);
  assert.deepEqual(saved.sourceWarnings, d.sourceWarnings);
});
test("CSV exact export roundtrip preserves source IDs, metadata and grandfathered pairs", () => {
  const d = fixture();
  d.lessons.push({ ...d.lessons[0], id: "l2", subgroup: "Б" });
  d.sourceConflictPairs = [conflictPairKey(...d.lessons)];
  const saved = parseScheduleCsv(exportScheduleCsv(d, scope), d, {
    ...scope,
    mode: "replace-scope",
  });
  assert.equal(saved.lessons.length, 2);
  assert.deepEqual(
    saved.lessons.map((l) => l.id),
    ["l1", "l2"],
  );
  assert.deepEqual(saved.lessons[0].source, { cell: "B2" });
  assert.deepEqual(saved.sourceConflictPairs, d.sourceConflictPairs);
});
test("CSV rejects unknown/ambiguous catalog values, invalid day, duplicate headers and broken quotes", () => {
  const d = fixture();
  d.lessons = [];
  for (const csv of [
    "day,start,end,subject\n0,09:00,09:50,Missing",
    "day,start,end,subject\n7,09:00,09:50,Subject",
    "day,start,end,subject,subject\n0,09:00,09:50,Subject,Subject",
    'day,start,end,subject\n0,09:00,09:50,"Subject',
  ])
    assert.throws(() => parseScheduleCsv(csv, d, scope));
  d.subjects.push({ id: "s2", name: "Subject" });
  assert.throws(
    () =>
      parseScheduleCsv(
        "day,start,end,subject\n0,09:00,09:50,Subject",
        d,
        scope,
      ),
    /неоднозначное/,
  );
});
test("partial-scope replacement preserves common and other-group lessons, rejects common import", () => {
  const d = fixture();
  d.lessons.push(
    { ...d.lessons[0], id: "common", day: 2, subgroup: "all" },
    { ...d.lessons[0], id: "other", day: 3, groupId: "other" },
  );
  const saved = parseScheduleCsv(
    "day,start,end,subject,subgroup\n1,11:00,11:50,Subject,А",
    d,
    { groupId: "g", subgroup: "А", mode: "replace-scope" },
  );
  assert.ok(saved.lessons.some((l) => l.id === "common"));
  assert.ok(saved.lessons.some((l) => l.id === "other"));
  assert.equal(
    saved.lessons.some((l) => l.id === "l1"),
    false,
  );
  assert.throws(
    () =>
      parseScheduleCsv(
        "day,start,end,subject,subgroup\n1,11:00,11:50,Subject,all",
        d,
        { groupId: "g", subgroup: "А" },
      ),
    /обе/,
  );
});
test("replacement never silently drops linked overrides or attendance", () => {
  const d = fixture();
  d.exceptions = [{ lessonId: "l1", date: "2026-11-02", status: "cancelled" }];
  assert.throws(() =>
    parseScheduleCsv("day,start,end,subject\n1,11:00,11:50,Subject", d, {
      ...scope,
      mode: "replace-scope",
    }),
  );
  assert.equal(d.exceptions.length, 1);
});
test("CSV protects spreadsheet formula cells and remains importable", () => {
  const d = fixture();
  d.subjects[0].name = '=HYPERLINK("bad")';
  const csv = exportScheduleCsv(d, scope);
  assert.match(csv, /'=HYPERLINK/);
  assert.equal(
    parseScheduleCsv(csv, d, { ...scope, mode: "replace-scope" }).lessons[0]
      .subjectId,
    "s",
  );
});
test("CSV preview is read-only and identifies an append without changing source data", () => {
  const d = fixture(),
    before = structuredClone(d);
  const review = previewScheduleCsv(
    "day,start,end,subject\n1,10:00,10:50,Subject",
    d,
    scope,
  );
  assert.deepEqual(d, before);
  assert.deepEqual(review.counts, {
    added: 1,
    updated: 0,
    removed: 0,
    unchanged: 1,
  });
  assert.equal(review.changes[0].before, null);
  assert.equal(review.changes[0].after.day, 1);
  assert.deepEqual(review.data.sourceWarnings, before.sourceWarnings);
});
test("CSV replacement preview separates additions, ID edits and deletions with lossless metadata", () => {
  const d = fixture();
  d.lessons[0].future = { nested: ["retained"] };
  d.lessons.push({ ...d.lessons[0], id: "remove", day: 2 });
  const before = structuredClone(d);
  const review = previewScheduleCsv(
    "day,start,end,subject,id\n0,10:00,10:50,Subject,l1\n1,10:00,10:50,Subject,",
    d,
    { ...scope, mode: "replace-scope" },
  );
  assert.deepEqual(review.counts, {
    added: 1,
    updated: 1,
    removed: 1,
    unchanged: 0,
  });
  const edited = review.data.lessons.find((row) => row.id === "l1");
  assert.deepEqual(edited.source, { cell: "B2" });
  assert.deepEqual(edited.future, { nested: ["retained"] });
  assert.deepEqual(d, before);
});
test("unchanged CSV export has no semantic changes, including implicit same-day ending", () => {
  const d = fixture();
  const review = previewScheduleCsv(exportScheduleCsv(d, scope), d, {
    ...scope,
    mode: "replace-scope",
  });
  assert.deepEqual(review.counts, {
    added: 0,
    updated: 0,
    removed: 0,
    unchanged: 1,
  });
  assert.deepEqual(review.changes, []);
});
test("CSV preview rejects invalid data, links, unknown columns and resource conflicts without mutation", () => {
  const d = fixture(),
    before = structuredClone(d);
  for (const csv of [
    "day,start,end,subject\n0,09:00,09:50,Subject",
    "day,start,end,subject,group\n1,09:00,09:50,Subject,other",
    "day,start,end,subject\n1,09:00,09:50,Missing",
  ])
    assert.throws(() => previewScheduleCsv(csv, d, scope));
  d.exceptions = [{ lessonId: "l1", date: "2026-11-02", status: "cancelled" }];
  assert.throws(() =>
    previewScheduleCsv("day,start,end,subject\n1,10:00,10:50,Subject", d, {
      ...scope,
      mode: "replace-scope",
    }),
  );
  d.exceptions = [];
  assert.deepEqual(d, before);
});
test("CSV preview enforces input row and UTF-8 byte bounds before application", () => {
  const d = fixture();
  assert.throws(
    () =>
      previewScheduleCsv(
        "day,start,end,subject\n" + "1,10:00,10:50,Subject\n".repeat(1001),
        d,
        scope,
      ),
    /1000/,
  );
  assert.throws(() => previewScheduleCsv("я".repeat(500001), d, scope), /1 МБ/);
});
test("CSV review scopes removals to the exact subgroup and never removes common or other-group rows", () => {
  const d = fixture();
  d.lessons.push(
    { ...d.lessons[0], id: "common", day: 2, subgroup: "all" },
    { ...d.lessons[0], id: "other", day: 3, groupId: "other" },
  );
  const review = previewScheduleCsv(
    "day,start,end,subject\n1,10:00,10:50,Subject",
    d,
    { groupId: "g", subgroup: "А", mode: "replace-scope" },
  );
  assert.deepEqual(review.counts, {
    added: 1,
    updated: 0,
    removed: 1,
    unchanged: 0,
  });
  assert.equal(
    review.changes.find((row) => row.kind === "removed").before.id,
    "l1",
  );
  assert.ok(review.data.lessons.some((row) => row.id === "common"));
  assert.ok(review.data.lessons.some((row) => row.id === "other"));
});
test("copyDay appends new IDs, leaves original/source/other groups untouched and validates resources", () => {
  const d = fixture();
  const copied = copyDay(d, { ...scope, fromDay: 0, toDay: 1 });
  assert.equal(copied.lessons.length, 2);
  assert.notEqual(copied.lessons[1].id, "l1");
  assert.equal(copied.lessons[1].day, 1);
  assert.deepEqual(copied.lessons[1].source, { cell: "B2" });
  assert.equal(d.lessons.length, 1);
  assert.throws(
    () => copyDay(copied, { ...scope, fromDay: 0, toDay: 1 }),
    /занята|занят/,
  );
  assert.throws(() => copyDay(d, { ...scope, fromDay: 0, toDay: 0 }));
});
test("copyWeek copies only parity-specific lessons and fails on destination conflicts", () => {
  const d = fixture();
  const copied = copyWeek(d, { ...scope, fromWeek: "odd", toWeek: "even" });
  assert.equal(copied.lessons.length, 2);
  assert.equal(copied.lessons[1].week, "even");
  assert.notEqual(copied.lessons[1].id, "l1");
  assert.throws(
    () => copyWeek(copied, { ...scope, fromWeek: "odd", toWeek: "even" }),
    /занята|занят/,
  );
  d.lessons[0].week = "all";
  assert.throws(
    () => copyWeek(d, { ...scope, fromWeek: "odd", toWeek: "even" }),
    /Общие пары/,
  );
});
