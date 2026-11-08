import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./e2e/fixtures.mjs";
import { createTemplate } from "../app/manage/templates.mjs";
import {
  previewTransfer,
  transferPage,
} from "../app/manage/transfer-preview.mjs";
import {
  assertDraftRecoverable,
  recoverChanges,
} from "../app/manage/drafts.mjs";
import { conflictPairKey } from "../backend/core.mjs";
const owner = { role: "admin" };
const scope = { groupId: "g-main", subgroup: "А" };
const data = () => structuredClone(fixture);
const day = { ...scope, kind: "day", fromDay: 4, toDay: 1 };

test("day preview is read-only, keeps source IDs/provenance, copies common lessons into selected subgroup and exactly recovers", () => {
  const d = data();
  d.lessons[0].source = { sheet: "Kept", timeCell: "B2" };
  d.accounts = [{ private: "never display" }];
  const original = structuredClone(d),
    plan = previewTransfer(d, owner, day);
  assert.equal(plan.count, 2);
  assert.deepEqual(d, original);
  assert.deepEqual(plan.data.lessons.slice(0, d.lessons.length), d.lessons);
  assert.ok(
    plan.added.every(
      (row) =>
        row.day === 1 &&
        row.subgroup === "А" &&
        !d.lessons.some((old) => old.id === row.id),
    ),
  );
  assert.deepEqual(plan.added[0].source, d.lessons[0].source);
  assert.deepEqual(plan.data.accounts, d.accounts);
  assert.deepEqual(
    recoverChanges(d, assertDraftRecoverable(d, plan.data)).data,
    plan.data,
  );
});

test("parity copying includes only source parity, keeps night endings and date bounds", () => {
  const d = data();
  d.lessons[0].week = "odd";
  d.lessons[0].start = "23:00";
  d.lessons[0].end = "00:30";
  d.lessons[0].endDayOffset = 1;
  d.lessons[0].validFrom = "2026-11-01";
  d.lessons[0].validUntil = "2026-12-01";
  const plan = previewTransfer(d, owner, {
    ...scope,
    kind: "week",
    fromWeek: "odd",
    toWeek: "even",
  });
  assert.equal(plan.count, 1);
  assert.equal(plan.added[0].week, "even");
  assert.equal(plan.added[0].day, 4);
  assert.equal(plan.added[0].endDayOffset, 1);
  assert.equal(plan.added[0].validUntil, "2026-12-01");
  assert.match(transferPage(plan)[0].title, /\(\+1 день\)/);
  assert.match(transferPage(plan)[0].period, /2026-11-01/);
});

test("day and week templates retain chosen destinations and validate current catalogs", () => {
  const d = data();
  const template = createTemplate(d, {
    ...scope,
    kind: "day",
    day: 4,
    name: "Test",
  });
  const plan = previewTransfer(d, owner, {
    ...scope,
    kind: "template",
    template,
    toDay: 6,
  });
  assert.equal(plan.count, 2);
  assert.ok(plan.added.every((row) => row.day === 6));
  const weekly = createTemplate(d, { ...scope, kind: "week", name: "Week" });
  const empty = { ...d, lessons: [] };
  assert.ok(
    previewTransfer(empty, owner, {
      ...scope,
      kind: "template",
      template: weekly,
    }).added.every((row) => row.day === 4),
  );
  const missing = {
    ...empty,
    subjects: empty.subjects.filter((row) => row.id !== "math"),
  };
  assert.throws(
    () =>
      previewTransfer(missing, owner, {
        ...scope,
        kind: "template",
        template,
        toDay: 6,
      }),
    /справочнике/,
  );
});

test("invalid, empty, archived or unauthorized copies never alter the input", () => {
  const d = data(),
    old = structuredClone(d);
  for (const options of [
    { ...day, toDay: 4 },
    { ...day, fromDay: 6 },
    { ...day, kind: "invalid" },
  ])
    assert.throws(() => previewTransfer(d, owner, options));
  assert.throws(
    () => previewTransfer(d, { role: "teacher" }, day),
    /владельца/,
  );
  const archived = structuredClone(d);
  archived.groups[0].archivedAt = "2026-11-01";
  assert.throws(() => previewTransfer(archived, owner, day), /активную/);
  assert.deepEqual(d, old);
});

test("existing conflicts are not permission to create new copied conflicts", () => {
  const d = data();
  d.lessons.push({ ...d.lessons[0], id: "source-conflict" });
  d.sourceConflictPairs = [conflictPairKey(d.lessons[0], d.lessons.at(-1))];
  const old = structuredClone(d);
  assert.throws(() => previewTransfer(d, owner, day), /занят|Пересеч|пересеч/);
  assert.deepEqual(d, old);
});

test("nonrecoverable copied metadata and unrelated unrecoverable draft changes block review", () => {
  const d = data();
  d.lessons[0].future = { unsupported: "cannot save" };
  assert.throws(() => previewTransfer(d, owner, day), /точно восстановить/);
  delete d.lessons[0].future;
  const before = structuredClone(d),
    current = structuredClone(d);
  current.exceptions = [
    {
      id: "override",
      lessonId: "now-a",
      date: "2026-11-06",
      status: "cancelled",
      before: { private: "must not be lost" },
    },
  ];
  assert.throws(
    () => previewTransfer(current, owner, day, { before }),
    /точно восстановить/,
  );
  const good = structuredClone(before);
  good.rooms[0].name = "Changed in draft";
  const plan = previewTransfer(good, owner, day, { before });
  assert.deepEqual(
    recoverChanges(before, assertDraftRecoverable(before, plan.data)).data,
    plan.data,
  );
});

test("review pages contain forty closed display records and never expose metadata or markup as structure", () => {
  const d = data();
  d.lessons = Array.from({ length: 41 }, (_, i) => ({
    ...d.lessons[0],
    id: "source-" + i,
    day: 0,
    start: `${String(Math.floor(i / 12)).padStart(2, "0")}:${String((i % 12) * 5).padStart(2, "0")}`,
    end: `${String(Math.floor(i / 12)).padStart(2, "0")}:${String((i % 12) * 5 + 4).padStart(2, "0")}`,
    teacherId: "",
    roomId: "",
  }));
  d.subjects[0].name = "<img src=x onerror=alert(1)>";
  d.subjects[0].privateNote = "PRIVATE_CATALOG";
  const plan = previewTransfer(d, owner, { ...day, fromDay: 0, toDay: 1 });
  assert.equal(transferPage(plan, 0).length, 40);
  assert.equal(transferPage(plan, 1).length, 1);
  assert.deepEqual(Object.keys(transferPage(plan)[0]), [
    "id",
    "title",
    "text",
    "period",
  ]);
  assert.ok(!JSON.stringify(transferPage(plan)).includes("PRIVATE_CATALOG"));
  assert.match(transferPage(plan)[0].text, /<img/);
  assert.throws(() => transferPage(plan, -1));
});
