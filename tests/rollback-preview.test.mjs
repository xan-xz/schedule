import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./e2e/fixtures.mjs";
import {
  buildRollbackData,
  previewRollback,
  rollbackFingerprint,
} from "../backend/rollback-preview.mjs";
const options = { revision: 8, target: 7 };
const prepare = (current, old) =>
  buildRollbackData(current, old, 7, "Владелец", {
    id: "audit-preview",
    at: "2026-11-06T04:00:00Z",
  }).data;

test("restore model retains current history, validates, and never mutates either source", () => {
  const current = structuredClone(fixture),
    old = structuredClone(fixture);
  current.history = [
    {
      id: "later",
      at: "2026-11-06T04:00:00Z",
      actor: "Владелец",
      action: "edit",
      summary: "Keep",
    },
  ];
  old.history = [{ id: "ancient" }];
  old.lessons[0].roomId = "205";
  const before = structuredClone({ current, old }),
    result = prepare(current, old);
  assert.equal(result.lessons[0].roomId, "205");
  assert.equal(result.history[0].action, "rollback");
  assert.equal(result.history[1].id, "later");
  assert.equal(
    result.history.some((x) => x.id === "ancient"),
    false,
  );
  assert.deepEqual({ current, old }, before);
});
test("preview reports exact record additions, removals, edits and shared-record ordering", async () => {
  const current = structuredClone(fixture),
    old = structuredClone(fixture);
  old.lessons[0].roomId = "205";
  old.lessons.pop();
  old.lessons.push({ ...old.lessons[0], id: "extra", day: 1 });
  old.subjects.reverse();
  const plan = await previewRollback(current, prepare(current, old), options);
  const lessons = plan.summary.find((x) => x.section === "lessons");
  assert.deepEqual(
    [lessons.added, lessons.removed, lessons.changed],
    [1, 1, 1],
  );
  assert.equal(
    plan.summary.find((x) => x.section === "subjects").orderChanged,
    true,
  );
  assert.equal(plan.totalChanges, 4);
  assert.equal(plan.changes.length, 4);
  assert.match(plan.fingerprint, /^[a-f0-9]{64}$/);
});
test("hash and no-op detection ignore object key order and the retained audit log", async () => {
  const current = structuredClone(fixture),
    old = Object.fromEntries(
      Object.entries(structuredClone(fixture)).reverse(),
    );
  const a = prepare(current, old),
    b = buildRollbackData(current, old, 7, "Владелец", {
      id: "different",
      at: "2026-11-07T04:00:00Z",
    }).data;
  const p = await previewRollback(current, a, options);
  assert.equal(p.totalChanges, 0);
  assert.equal(p.fingerprint, await rollbackFingerprint(current, b, 8, 7));
  assert.notEqual(p.fingerprint, await rollbackFingerprint(current, b, 9, 7));
});
test("closed preview hides unknown names, room notes, operational content and root metadata", async () => {
  const current = structuredClone(fixture),
    old = structuredClone(fixture);
  old.lessons[0].name = "SECRET_UNKNOWN_NAME";
  old.lessons[0].privateFuture = "SECRET_FUTURE";
  old.rooms[0].note = "SECRET_NOTE";
  old.tasks[0].description = "SECRET_DESCRIPTION";
  old.privateRoot = { value: "SECRET_ROOT" };
  const plan = await previewRollback(current, prepare(current, old), options),
    text = JSON.stringify(plan);
  for (const secret of [
    "SECRET_UNKNOWN_NAME",
    "SECRET_FUTURE",
    "SECRET_NOTE",
    "SECRET_DESCRIPTION",
    "SECRET_ROOT",
    "privateRoot",
    "privateFuture",
  ])
    assert.equal(text.includes(secret), false);
  assert.ok(plan.changes.some((x) => x.hiddenChanged));
  assert.equal(plan.summary.find((x) => x.section === "other").changed, 1);
});
test("page output is capped at forty changes with a stable cross-page fingerprint", async () => {
  const current = structuredClone(fixture),
    old = structuredClone(fixture);
  current.lessons = Array.from({ length: 1001 }, (_, i) => ({
    ...current.lessons[0],
    id: "row-" + i,
    day: Math.floor(i / 720),
    start: "00:00",
    end: "00:01",
    teacherId: "",
    roomId: "",
  }));
  old.lessons = current.lessons.map((row) => ({ ...row, type: "Семинар" }));
  const a = await previewRollback(current, old, options),
    b = await previewRollback(current, old, { ...options, page: 25 });
  assert.equal(a.totalChanges, 1001);
  assert.equal(a.changes.length, 40);
  assert.equal(b.changes.length, 1);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(a.totalPages, 26);
  assert.ok(Buffer.byteLength(JSON.stringify(a), "utf8") < 150000);
});
test("opaque arrays remain visible as section changes, and absent versus null is not a no-op", async () => {
  const current = structuredClone(fixture),
    old = structuredClone(fixture);
  old.holidays = [];
  old.siteSettings = null;
  const plan = await previewRollback(current, old, options);
  assert.equal(plan.summary.find((x) => x.section === "holidays").changed, 1);
  assert.equal(
    plan.summary.find((x) => x.section === "siteSettings").changed,
    1,
  );
});
test("a changed hidden field invalidates the fingerprint even when its content is not displayed", async () => {
  const current = structuredClone(fixture),
    old = structuredClone(fixture),
    a = await previewRollback(current, old, options);
  old.lessons[0].privateFuture = { value: 1 };
  const b = await previewRollback(current, old, options);
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.equal(b.changes[0].hiddenChanged, true);
});
test("bad page and revision inputs reject; invalid target references cannot prepare a rollback", async () => {
  for (const patch of [
    { page: -1 },
    { page: 1.1 },
    { revision: 0 },
    { target: -1 },
  ])
    await assert.rejects(
      previewRollback(fixture, fixture, { ...options, ...patch }),
    );
  const old = structuredClone(fixture);
  old.lessons[0].roomId = "missing";
  assert.throws(() => prepare(fixture, old));
});
