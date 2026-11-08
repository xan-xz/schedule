import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { defaultTeachingSettings } from "../backend/teaching-settings.mjs";
import { mutate } from "../backend/core.mjs";
import { draftChanges, recoverChanges } from "../app/manage/drafts.mjs";
import { fixture } from "./e2e/fixtures.mjs";

const owner = { id: "owner", role: "admin", name: "Owner" };
test("teaching journal is a closed authored subtree, retaining fresh unknown siblings and every one of 524 source lessons", async () => {
  const before = JSON.parse(
    await readFile(new URL("../app/seed.json", import.meta.url), "utf8"),
  );
  before.siteSettings = { privateSibling: { marker: "NEVER_JOURNAL_PRIVATE" } };
  const settings = defaultTeachingSettings();
  settings.lessonTypes[0].name = "Семинар";
  const after = mutate(before, owner, "teaching.save", { settings }).data;
  assert.equal(before.lessons.length, 524);
  assert.deepEqual(after.lessons, before.lessons);
  assert.deepEqual(after.exceptions, before.exceptions);
  const changes = draftChanges(before, after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, "siteSettings.teaching");
  assert.equal(
    JSON.stringify(changes).includes("NEVER_JOURNAL_PRIVATE"),
    false,
  );
  assert.equal(JSON.stringify(changes).includes("source-"), false);
  const fresh = structuredClone(before);
  fresh.siteSettings.privateSibling.marker = "FRESH_PRIVATE";
  const restored = recoverChanges(fresh, changes);
  assert.deepEqual(restored.data.lessons, before.lessons);
  assert.equal(
    restored.data.siteSettings.privateSibling.marker,
    "FRESH_PRIVATE",
  );
  assert.deepEqual(restored.data.siteSettings.teaching, settings);
});
test("unknown nested objects and credential-shaped names cannot enter teaching draft records", () => {
  const before = structuredClone(fixture);
  for (const settings of [
    Object.assign(defaultTeachingSettings(), {
      privateAccount: { token: "no" },
    }),
    defaultTeachingSettings(),
  ]) {
    if (!Object.hasOwn(settings, "privateAccount"))
      settings.bellSchedules[0].name = "sb_secret_TestFixture123";
    const after = structuredClone(before);
    after.siteSettings = { teaching: settings };
    assert.throws(() => draftChanges(before, after));
  }
});
test("changed server teaching settings require explicit recovery while unrelated settings remain fresh", () => {
  const before = structuredClone(fixture);
  before.siteSettings = { teaching: defaultTeachingSettings() };
  const after = structuredClone(before);
  after.siteSettings.teaching.lessonTypes[0].name = "Локальный тип";
  const fresh = structuredClone(before);
  fresh.siteSettings.teaching.lessonTypes[0].name = "Серверный тип";
  fresh.siteSettings.ownerOnly = { keep: true };
  const changes = draftChanges(before, after),
    preview = recoverChanges(fresh, changes);
  assert.equal(preview.conflicts.length, 1);
  assert.equal(
    preview.data.siteSettings.teaching.lessonTypes[0].name,
    "Серверный тип",
  );
  const accepted = recoverChanges(fresh, changes, { force: true });
  assert.equal(
    accepted.data.siteSettings.teaching.lessonTypes[0].name,
    "Локальный тип",
  );
  assert.deepEqual(accepted.data.siteSettings.ownerOnly, { keep: true });
});
