import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./e2e/fixtures.mjs";
import { validate } from "../backend/core.mjs";
import {
  previewTransfer,
  transferPage,
} from "../app/manage/transfer-preview.mjs";
import { createTemplate } from "../app/manage/templates.mjs";
import {
  assertDraftRecoverable,
  recoverChanges,
} from "../app/manage/drafts.mjs";
const owner = { role: "admin" },
  scope = { groupId: "g-main", subgroup: "А" };
const options = {
  ...scope,
  kind: "day",
  fromDay: 4,
  toDay: 1,
  mode: "replace-destination",
};
function data() {
  const d = structuredClone(fixture);
  d.lessons.push({ ...d.lessons[0], id: "target", day: 1 });
  return d;
}

test("day replacement removes only explicitly owned target rows and recovers every reviewed addition/removal", () => {
  const d = data();
  d.groups.push({ id: "other", name: "Other", subgroups: ["А"] });
  d.lessons.push(
    {
      ...d.lessons[0],
      id: "common",
      day: 1,
      subgroup: "all",
      start: "15:00",
      end: "15:50",
    },
    {
      ...d.lessons[0],
      id: "other-subgroup",
      day: 1,
      subgroup: "Б",
      start: "16:00",
      end: "16:50",
    },
    {
      ...d.lessons[0],
      id: "other-group",
      day: 1,
      groupId: "other",
      start: "17:00",
      end: "17:50",
    },
  );
  const before = structuredClone(d),
    plan = previewTransfer(d, owner, options);
  assert.deepEqual(d, before);
  assert.equal(plan.count, 2);
  assert.equal(plan.removedCount, 1);
  assert.equal(plan.totalChanges, 3);
  assert.deepEqual(
    plan.removed.map((r) => r.id),
    ["target"],
  );
  for (const id of [
    "common",
    "other-subgroup",
    "other-group",
    "now-a",
    "next",
    "later-b",
  ])
    assert.deepEqual(
      plan.data.lessons.find((r) => r.id === id),
      d.lessons.find((r) => r.id === id),
    );
  assert.ok(plan.added.every((r) => r.day === 1 && r.subgroup === "А"));
  assert.deepEqual(
    recoverChanges(d, assertDraftRecoverable(d, plan.data)).data,
    plan.data,
  );
  assert.equal(transferPage(plan)[0].kind, "removed");
  assert.throws(
    () => previewTransfer(d, owner, { ...options, mode: "append" }),
    /занят|пересеч/,
  );
});

test("parity replacement removes only exact target parity and preserves every-week rows", () => {
  const d = data();
  d.lessons[0].week = "odd";
  d.lessons.find((r) => r.id === "target").day = 4;
  d.lessons.find((r) => r.id === "target").week = "even";
  const plan = previewTransfer(d, owner, {
    ...scope,
    kind: "week",
    fromWeek: "odd",
    toWeek: "even",
    mode: "replace-destination",
  });
  assert.deepEqual(
    plan.removed.map((r) => r.id),
    ["target"],
  );
  assert.equal(plan.added.length, 1);
  assert.equal(plan.added[0].week, "even");
  assert.deepEqual(
    plan.data.lessons.find((r) => r.id === "next"),
    d.lessons.find((r) => r.id === "next"),
  );
  assert.ok(
    plan.data.lessons.some((r) => r.id === "now-a" && r.week === "odd"),
  );
});

test("day and week template replacement clears the chosen destination while preserving other scopes", () => {
  const d = structuredClone(fixture),
    all = { groupId: "g-main", subgroup: "all" };
  const day = createTemplate(d, { ...all, name: "Day", kind: "day", day: 4 });
  let plan = previewTransfer(d, owner, {
    ...all,
    kind: "template",
    template: day,
    toDay: 4,
    mode: "replace-destination",
  });
  assert.equal(plan.removedCount, 3);
  assert.equal(plan.count, 3);
  const week = createTemplate(d, { ...all, name: "Week", kind: "week" });
  d.lessons.push({ ...d.lessons[0], id: "extra", day: 6 });
  plan = previewTransfer(d, owner, {
    ...all,
    kind: "template",
    template: week,
    mode: "replace-destination",
  });
  assert.equal(plan.removedCount, 4);
  assert.equal(plan.count, 3);
  assert.ok(!plan.data.lessons.some((r) => r.day === 6));
  assert.deepEqual(
    recoverChanges(d, assertDraftRecoverable(d, plan.data)).data,
    plan.data,
  );
});

test("linked overrides, attendance and requests block replacement without cascading away private records", () => {
  for (const kind of ["exceptions", "attendance", "requests"]) {
    const d = data();
    const row = { lessonId: "target", date: "2026-11-03" };
    if (kind === "exceptions")
      d.exceptions = [{ ...row, id: "override", status: "cancelled" }];
    if (kind === "attendance")
      d.attendance = [{ ...row, studentId: "student", status: "present" }];
    if (kind === "requests")
      d.requests = [
        {
          ...row,
          id: "request",
          teacherId: "teacher",
          start: "10:00",
          end: "10:50",
          roomId: "204",
          reason: "Keep",
          status: "pending",
        },
      ];
    const old = structuredClone(d);
    validate(d);
    assert.throws(() => previewTransfer(d, owner, options));
    assert.deepEqual(d, old);
  }
});

test("replacement never removes shared target rows or other groups to make a collision disappear", () => {
  const d = data();
  d.lessons.push({ ...d.lessons[1], id: "target-common", day: 1 });
  const old = structuredClone(d);
  assert.throws(() => previewTransfer(d, owner, options), /занят|пересеч/);
  assert.deepEqual(d, old);
  const all = previewTransfer(d, owner, { ...options, subgroup: "all" });
  assert.deepEqual(
    all.removed.map((r) => r.id),
    ["target", "target-common"],
  );
  assert.equal(all.count, 3);
  d.groups.push({ id: "other", name: "Other", subgroups: ["А"] });
  d.lessons.push({
    ...d.lessons[0],
    id: "unrelated-group",
    groupId: "other",
    day: 1,
    start: "18:00",
    end: "18:50",
  });
  const template = createTemplate(d, {
    ...scope,
    name: "Night",
    kind: "day",
    day: 4,
  });
  template.lessons[0].start = "18:00";
  template.lessons[0].end = "18:50";
  assert.throws(
    () =>
      previewTransfer(d, owner, {
        ...scope,
        kind: "template",
        template,
        toDay: 1,
        mode: "replace-destination",
      }),
    /занят|пересеч/,
  );
});

test("unsafe deleted metadata, unknown modes and empty sources are rejected before mutation", () => {
  const d = data();
  d.lessons.find((r) => r.id === "target").future = {
    private: "not recoverable",
  };
  const before = structuredClone(d);
  assert.throws(() => previewTransfer(d, owner, options), /точно восстановить/);
  assert.throws(
    () => previewTransfer(d, owner, { ...options, mode: "replace-everything" }),
    /добавление|замену/,
  );
  assert.throws(
    () => previewTransfer(d, owner, { ...options, fromDay: 6 }),
    /нет пар/,
  );
  assert.deepEqual(d, before);
});

test("replacement pages include all removals before additions with closed display fields", () => {
  const d = data();
  d.lessons = d.lessons.filter((r) => r.id !== "target");
  d.lessons.push(
    ...Array.from({ length: 41 }, (_, i) => ({
      ...d.lessons[0],
      id: "old-" + i,
      day: 1,
      teacherId: "",
      roomId: "",
      start: `${String(Math.floor(i / 12)).padStart(2, "0")}:${String((i % 12) * 5).padStart(2, "0")}`,
      end: `${String(Math.floor(i / 12)).padStart(2, "0")}:${String((i % 12) * 5 + 4).padStart(2, "0")}`,
    })),
  );
  const plan = previewTransfer(d, owner, options);
  assert.equal(plan.totalChanges, 43);
  assert.equal(transferPage(plan, 0).length, 40);
  assert.equal(transferPage(plan, 1).length, 3);
  assert.ok(transferPage(plan, 0).every((r) => r.kind === "removed"));
  assert.equal(
    transferPage(plan, 1).filter((r) => r.kind === "added").length,
    2,
  );
  assert.deepEqual(Object.keys(transferPage(plan)[0]), [
    "id",
    "kind",
    "title",
    "text",
    "period",
  ]);
});
