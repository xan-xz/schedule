import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./e2e/fixtures.mjs";
import { mutate } from "../backend/core.mjs";
import {
  previewJsonImport,
  jsonImportPage,
  jsonImportFingerprint,
} from "../app/manage/json-import-preview.mjs";
const owner = { role: "admin", name: "Владелец" };
const data = () => ({
  ...structuredClone(fixture),
  source: null,
  sourceWarnings: [],
});
const raw = (d) => JSON.stringify({ format: "uniflow-2", ...d });
test("global JSON preview describes effective additions/removals/edits without changing either input or private collections", () => {
  const d = data(),
    input = structuredClone(d);
  input.rooms[0].name = "Обновлена";
  input.lessons.pop();
  input.lessons.push({ ...input.lessons[0], id: "new", day: 1 });
  input.groups.push({ id: "other", name: "Другая", subgroups: ["А"] });
  input.tasks = [];
  input.history = [{ private: "ignored" }];
  input.announcements = [{ body: "ignored" }];
  input.attendance = [{ private: "ignored" }];
  input.role = "admin";
  const before = structuredClone(d),
    original = structuredClone(input),
    plan = previewJsonImport(raw(input), d, owner);
  assert.equal(plan.totalChanges, 4);
  assert.deepEqual(
    plan.summary.find((x) => x.section === "lessons"),
    {
      section: "lessons",
      label: "Постоянные занятия",
      beforeCount: 3,
      afterCount: 3,
      added: 1,
      removed: 1,
      changed: 0,
    },
  );
  for (const key of [
    "tasks",
    "history",
    "announcements",
    "requests",
    "attendance",
  ])
    assert.deepEqual(plan.data[key], d[key]);
  assert.deepEqual(d, before);
  assert.deepEqual(input, original);
});
test("canonical equality and no-op ignore JSON property ordering, export envelope and forbidden private payload", () => {
  const d = data(),
    input = Object.fromEntries(Object.entries(d).reverse());
  input.groups = input.groups.map((x) =>
    Object.fromEntries(Object.entries(x).reverse()),
  );
  input.accounts = [{ token: "ignored" }];
  const plan = previewJsonImport(raw(input), d, owner);
  assert.equal(plan.totalChanges, 0);
  assert.deepEqual(jsonImportPage(plan), []);
  assert.equal(
    jsonImportFingerprint({ b: 1, a: [{ z: 2, x: 3 }] }),
    jsonImportFingerprint({ a: [{ x: 3, z: 2 }], b: 1 }),
  );
});
test("existing lesson IDs, source provenance and unchanged unknown metadata survive supported field edits", () => {
  const d = data();
  d.lessons[0].source = { sheet: "Лист", timeCell: "B2" };
  d.lessons[0].future = { retain: 1 };
  const input = structuredClone(d);
  input.lessons[0].type = "Семинар";
  const plan = previewJsonImport(raw(input), d, owner);
  assert.equal(plan.data.lessons[0].id, d.lessons[0].id);
  assert.deepEqual(plan.data.lessons[0].source, d.lessons[0].source);
  assert.deepEqual(plan.data.lessons[0].future, { retain: 1 });
  assert.equal(plan.totalChanges, 1);
});
test("unsupported metadata edits, inserted ordering, reordered rows and nonrecoverable exceptions fail before apply", () => {
  const d = data();
  d.lessons[0].future = { retain: 1 };
  for (const edit of [
    (x) => {
      x.lessons[0].future.retain = 2;
    },
    (x) => {
      x.subjects.reverse();
    },
    (x) => {
      x.rooms.splice(1, 0, { id: "inserted", name: "Новая", capacity: 20 });
    },
    (x) => {
      x.exceptions.push({
        lessonId: "now-a",
        date: "2026-11-06",
        status: "cancelled",
      });
    },
  ]) {
    const input = structuredClone(d);
    edit(input);
    assert.throws(
      () => previewJsonImport(raw(input), d, owner),
      /локальной копии/,
    );
  }
});
test("closed display projection counts owner notes but hides their values and untouched operational text", () => {
  const d = data();
  d.rooms[0].note = "SECRET_OLD";
  d.tasks[0].description = "SECRET_TASK";
  const input = structuredClone(d);
  input.rooms[0].note = "SECRET_NEW";
  const plan = previewJsonImport(raw(input), d, owner),
    page = jsonImportPage(plan);
  assert.equal(page[0].hiddenChanged, true);
  assert.doesNotMatch(
    JSON.stringify(page),
    /SECRET_OLD|SECRET_NEW|SECRET_TASK|description/,
  );
  assert.equal(plan.data.rooms[0].note, "SECRET_NEW");
});
test("opaque source, period and teaching changes are distinguished without dumping raw metadata", () => {
  const d = data(),
    input = structuredClone(d);
  d.validUntil = "2026-12-31";
  input.validUntil = null;
  input.source = { file: "SECRET_FILE" };
  input.holidays = [{ start: "2026-11-07", end: "2026-11-07" }];
  const plan = previewJsonImport(raw(input), d, owner);
  assert.equal(plan.totalChanges, 3);
  assert.equal(Object.hasOwn(plan.data, "validUntil"), false);
  assert.doesNotMatch(JSON.stringify(jsonImportPage(plan)), /SECRET_FILE/);
});
test("legacy absent terms and private settings siblings are preserved; null clears only explicit bounds", () => {
  const d = data();
  d.validFrom = "2026-11-01";
  d.validUntil = "2026-12-31";
  d.siteSettings = { privateSibling: { marker: "retain" } };
  const input = structuredClone(d);
  delete input.validFrom;
  delete input.validUntil;
  delete input.siteSettings;
  input.rooms[0].name = "Другая";
  const plan = previewJsonImport(raw(input), d, owner);
  assert.equal(plan.data.validFrom, d.validFrom);
  assert.equal(plan.data.validUntil, d.validUntil);
  assert.deepEqual(plan.data.siteSettings, d.siteSettings);
});
test("catalog replacement intents remain anchored to the original server snapshot, while existing draft edits are retained", () => {
  const before = data(),
    draft = mutate(before, owner, "catalog.replace", {
      entity: "rooms",
      id: "204",
      replacementId: "205",
    }).data;
  const input = structuredClone(draft);
  input.rooms[0].name = "Ещё одна правка";
  const plan = previewJsonImport(raw(input), draft, owner, {
    before,
    replacements: [{ entity: "rooms", id: "204", replacementId: "205" }],
  });
  assert.equal(
    plan.data.rooms.some((x) => x.id === "204"),
    false,
  );
  assert.equal(plan.data.lessons[0].roomId, "205");
  const bad = structuredClone(input);
  bad.rooms.push(before.rooms[0]);
  assert.throws(() =>
    previewJsonImport(raw(bad), draft, owner, {
      before,
      replacements: [{ entity: "rooms", id: "204", replacementId: "205" }],
    }),
  );
});
test("only the selected forty changes become text, with exact final-page contents", () => {
  const d = data();
  d.rooms.push(
    ...Array.from({ length: 501 }, (_, i) => ({
      id: "r-" + i,
      name: "Комната " + i,
      capacity: 20,
    })),
  );
  const input = structuredClone(d);
  input.rooms.forEach((x) => (x.name += " новая"));
  const plan = previewJsonImport(raw(input), d, owner);
  assert.equal(plan.totalChanges, 503);
  assert.equal(jsonImportPage(plan, 0).length, 40);
  assert.equal(jsonImportPage(plan, 12).length, 23);
  assert.throws(() => jsonImportPage(plan, -1));
});
test("malformed format, byte limit and non-owner input reject with no mutation", () => {
  const d = data(),
    before = structuredClone(d);
  for (const input of [
    "{",
    "[]",
    raw({ ...d, format: "other" }),
    "я".repeat(500001),
  ])
    assert.throws(() => previewJsonImport(input, d, owner));
  assert.throws(() => previewJsonImport(raw(d), d, { role: "teacher" }));
  assert.deepEqual(d, before);
});
test("conflicting times, broken references and forged source permissions cannot prepare an import", () => {
  const d = data();
  for (const edit of [
    (x) => {
      x.lessons[0].roomId = "missing";
    },
    (x) => {
      x.lessons[1].start = "08:10";
      x.sourceConflictPairs = ["forged"];
    },
    (x) => {
      x.groups = [];
    },
  ]) {
    const input = structuredClone(d);
    edit(input);
    assert.throws(() => previewJsonImport(raw(input), d, owner));
  }
});
test("empty-source compatibility follows the existing engine, and reference deletion is not hidden by private file payload", () => {
  const d = data(),
    input = structuredClone(d);
  input.rooms = [];
  input.lessons.forEach((x) => {
    x.roomId = "";
  });
  d.requests = [
    { id: "archived", roomId: "204", lessonId: "now-a", status: "rejected" },
  ];
  input.requests = [];
  assert.throws(() => previewJsonImport(raw(input), d, owner));
});
