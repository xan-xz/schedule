import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mutate, previewLessonBatch, validate } from "../backend/core.mjs";
import { projectPublicData } from "../backend/public-data.mjs";
import {
  decomposePlatform,
  recomposePlatform,
  platformChecksum,
} from "../backend/normalized.mjs";
import { projectInitialSnapshot } from "../app/lib/initial-snapshot.mjs";
import { serializeInertSnapshot } from "../scripts/inline-release-snapshot.mjs";
import { draftChanges, recoverChanges } from "../app/manage/drafts.mjs";
import { syntheticFixture } from "../scripts/normalized-dry-run.mjs";

const seed = JSON.parse(
  await readFile(new URL("../app/seed.json", import.meta.url), "utf8"),
);
const owner = { id: "fixture-owner", role: "admin", name: "Fixture owner" };
const privateMarker = "BULK_PRIVATE_METADATA_83C";
const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const duration = (row) =>
  minutes(row.end) + (row.endDayOffset || 0) * 1440 - minutes(row.start);
function sourceFixture() {
  const data = structuredClone(seed);
  data.futureOwnerMetadata = { exact: [null, false, { text: privateMarker }] };
  data.lessons[0].ownerOnlyMetadata = { text: privateMarker };
  data.rooms[0].note = privateMarker;
  data.history.unshift({
    id: "bulk-private-history",
    at: "2026-11-08T00:00:00Z",
    actor: "Fixture owner",
    action: "fixture",
    summary: privateMarker,
  });
  return data;
}
function allTypes(data) {
  return {
    ids: data.lessons.map((row) => row.id),
    change: { kind: "type", value: "Лекция" },
  };
}
function checkSource(data, original) {
  assert.equal(data.lessons.length, 524);
  assert.equal(data.sourceWarnings.length, 54);
  assert.equal(data.sourceConflictPairs.length, 133);
  for (const key of ["source", "sourceWarnings", "sourceConflictPairs"])
    assert.deepEqual(data[key], original[key], key);
  assert.deepEqual(
    data.lessons.map((row) => row.id),
    original.lessons.map((row) => row.id),
  );
  for (let index = 0; index < data.lessons.length; index++)
    assert.deepEqual(
      data.lessons[index].source,
      original.lessons[index].source,
    );
  const longRows = original.lessons.filter((row) => duration(row) === 480);
  assert.equal(longRows.length, 9);
  for (const before of longRows) {
    const after = data.lessons.find((row) => row.id === before.id);
    assert.equal(duration(after), 480);
    for (const key of ["day", "start", "end", "endDayOffset", "week"])
      assert.equal(after[key], before[key], key);
    assert.equal(
      Object.hasOwn(after, "endDayOffset"),
      Object.hasOwn(before, "endDayOffset"),
    );
  }
}
function assertClosedPreview(preview) {
  assert.equal(JSON.stringify(preview).includes(privateMarker), false);
  for (const change of preview.changes)
    for (const row of [change.before, change.after])
      for (const key of ["source", "ownerOnlyMetadata", "history"])
        assert.equal(Object.hasOwn(row, key), false, key);
}

test("a real 524-lesson mixed batch changes only selected type fields and preserves the exact long/source records", () => {
  const data = sourceFixture(),
    original = structuredClone(data),
    payload = allTypes(data);
  const preview = previewLessonBatch(data, payload);
  const changed = data.lessons.filter((row) => row.type !== "Лекция").length;
  assert.equal(preview.valid, true);
  assert.equal(preview.selectedCount, 524);
  assert.equal(preview.changedCount, changed);
  assert.equal(preview.unchangedCount, 524 - changed);
  assertClosedPreview(preview);
  const result = mutate(data, owner, "lesson.batch", payload).data;
  assert.equal(validate(result), true);
  for (let index = 0; index < original.lessons.length; index++)
    assert.deepEqual(result.lessons[index], {
      ...original.lessons[index],
      type: "Лекция",
    });
  for (const key of Object.keys(original).filter(
    (key) => !["lessons", "history", "announcements"].includes(key),
  ))
    assert.deepEqual(result[key], original[key], key);
  assert.deepEqual(result.history.slice(1), original.history);
  checkSource(result, original);
  assert.deepEqual(data, original);
});

test("source no-ops reject without adding offset fields, history, notices or metadata changes", async () => {
  const data = sourceFixture(),
    original = structuredClone(data),
    checksum = await platformChecksum(data);
  const first = data.lessons[0];
  assert.equal(Object.hasOwn(first, "endDayOffset"), false);
  const payloads = [
    {
      ids: data.lessons
        .filter((row) => row.type === "Лекция")
        .map((row) => row.id),
      change: { kind: "type", value: "Лекция" },
    },
    {
      ids: [first.id],
      change: {
        kind: "setTime",
        start: first.start,
        end: first.end,
        endDayOffset: 0,
      },
    },
  ];
  for (const payload of payloads) {
    const preview = previewLessonBatch(data, payload);
    assert.equal(preview.valid, false);
    assert.equal(preview.changedCount, 0);
    assert.equal(preview.unchangedCount, payload.ids.length);
    assert.deepEqual(preview.changes, []);
    assertClosedPreview(preview);
    assert.throws(
      () => mutate(data, owner, "lesson.batch", payload),
      (error) => error.status === 400,
    );
    assert.deepEqual(data, original);
    assert.equal(await platformChecksum(data), checksum);
  }
});

test("existing 133 source exemptions cannot authorize a new conflicting bulk time rewrite or a partially stale selection", async () => {
  const data = sourceFixture(),
    original = structuredClone(data),
    checksum = await platformChecksum(data);
  const payloads = [
    {
      ids: data.lessons.map((row) => row.id),
      change: {
        kind: "setTime",
        start: "08:00",
        end: "08:50",
        endDayOffset: 0,
      },
    },
    {
      ids: [data.lessons[0].id, data.lessons[1].id, "not-a-source-lesson"],
      change: { kind: "type", value: "Проверка атомарности" },
    },
  ];
  for (const [index, payload] of payloads.entries()) {
    const preview = previewLessonBatch(data, payload);
    assert.equal(preview.valid, false);
    if (index === 0) {
      assert.ok(preview.changedCount > 0);
      assert.equal(preview.changes.length, preview.changedCount);
    } else assert.deepEqual(preview.changes, []);
    assertClosedPreview(preview);
    assert.throws(
      () => mutate(data, owner, "lesson.batch", payload),
      (error) => error.status === 400,
    );
    assert.deepEqual(data, original);
    assert.equal(await platformChecksum(data), checksum);
    checkSource(data, original);
  }
});

test("bulk output remains lossless through normalized metadata and closed public/inert DTOs", async () => {
  const original = sourceFixture();
  const result = mutate(
    original,
    owner,
    "lesson.batch",
    allTypes(original),
  ).data;
  const normalized = decomposePlatform(result, { sourceRevision: 13 });
  const restored = recomposePlatform(normalized);
  assert.deepEqual(restored, result);
  assert.equal(
    await platformChecksum(restored),
    await platformChecksum(result),
  );
  assert.deepEqual(
    normalized.derived.timeSlots,
    decomposePlatform(original, { sourceRevision: 13 }).derived.timeSlots,
  );
  checkSource(restored, original);
  const envelope = {
    revision: 13,
    updatedAt: "2026-11-08T00:00:00Z",
    data: result,
  };
  for (const data of [
    projectPublicData(result),
    projectInitialSnapshot(envelope).data,
  ]) {
    assert.equal(data.lessons.length, 524);
    assert.equal(
      data.lessons.every((row) => row.type === "Лекция"),
      true,
    );
    assert.equal(JSON.stringify(data).includes(privateMarker), false);
    assert.deepEqual(data.history, []);
    assert.equal(Object.hasOwn(data, "sourceConflictPairs"), false);
    assert.equal(Object.hasOwn(data, "sourceWarnings"), false);
  }
  assert.equal(serializeInertSnapshot(envelope).includes(privateMarker), false);
});

test("bulk draft journals contain authored lesson deltas and preserve fresh private metadata when recovered", () => {
  const original = sourceFixture();
  const result = mutate(
    original,
    owner,
    "lesson.batch",
    allTypes(original),
  ).data;
  const changes = draftChanges(original, result);
  assert.equal(
    changes.length,
    original.lessons.filter((row) => row.type !== "Лекция").length,
  );
  assert.equal(
    changes.every((change) => change.kind === "lessons"),
    true,
  );
  assert.equal(JSON.stringify(changes).includes(privateMarker), false);
  const fresh = structuredClone(original);
  fresh.lessons[0].newPrivateMetadata = { text: privateMarker + "_fresh" };
  fresh.futureOwnerMetadata.latest = "preserve";
  const recovered = recoverChanges(fresh, changes);
  assert.deepEqual(recovered.conflicts, []);
  assert.equal(
    recovered.data.lessons.every((row) => row.type === "Лекция"),
    true,
  );
  assert.deepEqual(recovered.data.history, fresh.history);
  assert.deepEqual(
    recovered.data.futureOwnerMetadata,
    fresh.futureOwnerMetadata,
  );
  assert.deepEqual(
    recovered.data.lessons[0].newPrivateMetadata,
    fresh.lessons[0].newPrivateMetadata,
  );
  checkSource(recovered.data, original);
});

test("the existing 100-by-40 fixture supports a read-only preview of 1000 explicit selected lessons", () => {
  const data = syntheticFixture(),
    original = structuredClone(data),
    ids = data.lessons.slice(0, 1000).map((row) => row.id);
  const preview = previewLessonBatch(data, {
    ids,
    change: { kind: "type", value: "Масштабный тип" },
  });
  assert.equal(data.groups.length, 100);
  assert.equal(data.lessons.length, 4000);
  assert.equal(preview.valid, true);
  assert.equal(preview.selectedCount, 1000);
  assert.equal(preview.changedCount, 1000);
  assert.equal(preview.unchangedCount, 0);
  assert.equal(preview.changes.length, 1000);
  assert.deepEqual(
    new Set(preview.changes.map((change) => change.id)),
    new Set(ids),
  );
  assert.equal(preview.groups.length, 25);
  assert.equal(
    preview.groups.reduce((count, group) => count + group.count, 0),
    1000,
  );
  assertClosedPreview(preview);
  assert.deepEqual(data, original);
});
