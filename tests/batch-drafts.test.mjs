import test from "node:test";
import assert from "node:assert/strict";
import { selectedLessonFingerprint } from "../app/manage/lesson-batch-editor.mjs";
import { draftChanges, recoverChanges } from "../app/manage/drafts.mjs";
import { fixture } from "./e2e/fixtures.mjs";
import { mutate } from "../backend/core.mjs";

test("selected-row guard is canonical but detects deleted, retimed and provenance-changed source records", () => {
  const data = structuredClone(fixture),
    ids = ["now-a", "next"];
  data.lessons[0].source = { sheet: "Source", row: 7 };
  const before = selectedLessonFingerprint(data, ids),
    reordered = structuredClone(data);
  reordered.lessons[0] = Object.fromEntries(
    Object.entries(reordered.lessons[0]).reverse(),
  );
  assert.equal(
    selectedLessonFingerprint(reordered, [...ids].reverse()),
    before,
  );
  reordered.lessons[2].type = "Unrelated change";
  assert.equal(selectedLessonFingerprint(reordered, ids), before);
  reordered.lessons[0].source.row = 8;
  assert.notEqual(selectedLessonFingerprint(reordered, ids), before);
  const deleted = structuredClone(data);
  deleted.lessons = deleted.lessons.filter((row) => row.id !== "next");
  assert.notEqual(selectedLessonFingerprint(deleted, ids), before);
});
test("batch uses ordinary authored lesson deltas; private collections and unknown metadata never enter its durable copy", () => {
  const before = structuredClone(fixture);
  before.lessons[0].source = { sheet: "Source", row: 7, timeCell: "B7" };
  before.lessons[0].futureMetadata = { marker: "PRESERVE_SERVER_ONLY" };
  before.requests = [
    {
      id: "private-request",
      lessonId: "now-a",
      teacherId: "teacher",
      date: "2026-11-06",
      start: "10:00",
      end: "10:50",
      roomId: "204",
      reason: "NEVER_JOURNAL_PRIVATE",
      status: "pending",
      createdAt: "2026-11-05T04:00:00Z",
    },
  ];
  const owner = { id: "owner", name: "Owner", role: "admin" };
  const after = mutate(before, owner, "lesson.batch", {
    ids: ["now-a", "next"],
    change: { kind: "type", value: "Авторская правка" },
  }).data;
  assert.deepEqual(after.lessons[0].source, before.lessons[0].source);
  assert.deepEqual(
    after.lessons[0].futureMetadata,
    before.lessons[0].futureMetadata,
  );
  const changes = draftChanges(before, after);
  assert.deepEqual(
    changes.map((row) => row.id),
    ["now-a", "next"],
  );
  assert.equal(
    changes.every((row) => row.kind === "lessons"),
    true,
  );
  const json = JSON.stringify(changes);
  for (const privateValue of [
    "PRESERVE_SERVER_ONLY",
    "NEVER_JOURNAL_PRIVATE",
    "requests",
    "attendance",
    "history",
  ])
    assert.equal(json.includes(privateValue), false, privateValue);
  const fresh = structuredClone(before);
  fresh.lessons[0].futureMetadata = { marker: "FRESH_SERVER_ONLY" };
  const restored = recoverChanges(fresh, changes);
  assert.deepEqual(restored.data.lessons[0].futureMetadata, {
    marker: "FRESH_SERVER_ONLY",
  });
  assert.deepEqual(restored.data.requests, fresh.requests);
});
