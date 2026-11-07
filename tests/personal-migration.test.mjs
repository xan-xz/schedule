import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { migrateRetiredPersonal } from "../app/lib/personal-migration.mjs";
const config = JSON.parse(
  await readFile(new URL("../compatibility.json", import.meta.url), "utf8"),
).storage;
const migration = config.personalMigrations[0],
  scope = "g-main:А";
const oldPersonal = migration.personalFrom + scope,
  oldStatuses = migration.statusesFrom + scope;
const realPersonal = "personal:live:" + scope,
  realStatuses = "statuses:live:" + scope,
  history = "personal-history:live:" + scope;
const task = (id, title = id) => ({
  id,
  title,
  groupId: "g-main",
  due: "2026-11-08",
});
function fixture(
  entries,
  { durable = true, readback = true, onUpdate = () => {} } = {},
) {
  const rows = new Map(entries),
    local = new Map();
  const store = {
    keys: async () => [...rows.keys()],
    get: async (key, fallback = null) =>
      structuredClone(rows.has(key) ? rows.get(key) : fallback),
    deleteIfUnchanged: async (entries) => {
      if (
        !entries.every(
          ([key, value]) =>
            JSON.stringify(rows.get(key) ?? null) === JSON.stringify(value),
        )
      )
        return false;
      for (const [key] of entries) rows.delete(key);
      return true;
    },
    update: async (key, transform, fallback) => {
      onUpdate(key, rows);
      const value = transform(
        structuredClone(rows.has(key) ? rows.get(key) : fallback),
      );
      if (durable) rows.set(key, structuredClone(value));
      return { persisted: durable, value };
    },
    persisted: async (key, value) =>
      readback && JSON.stringify(rows.get(key)) === JSON.stringify(value),
  };
  const browserStorage = {
    get length() {
      return local.size;
    },
    key: (index) => [...local.keys()][index],
    getItem: (key) => local.get(key) ?? null,
    removeItem: (key) => local.delete(key),
  };
  return { rows, local, store, browserStorage };
}
test("human personal records migrate with statuses, canonical values win and unmatched progress remains only in recovery history", async () => {
  const f = fixture([
    [oldPersonal, [task("from-old")]],
    [
      oldStatuses,
      {
        "from-old": "progress",
        "live-only": "done",
        "unmatched-global": "done",
      },
    ],
    [realPersonal, [task("live-only")]],
    [realStatuses, { "live-only": "new" }],
  ]);
  assert.deepEqual(
    await migrateRetiredPersonal(config, f.store, f.browserStorage),
    { ok: true, migrated: true },
  );
  assert.deepEqual(f.rows.get(realPersonal), [
    task("live-only"),
    task("from-old"),
  ]);
  assert.deepEqual(f.rows.get(realStatuses), {
    "from-old": "progress",
    "live-only": "new",
  });
  assert.equal(f.rows.has(oldPersonal), false);
  assert.equal(f.rows.has(oldStatuses), false);
  assert.equal(
    f.rows.get(history).copies[0].statuses["unmatched-global"],
    "done",
  );
});
test("a colliding personal ID retains the canonical task and archives the other human record without applying its progress", async () => {
  const f = fixture([
    [oldPersonal, [task("same", "older context text")]],
    [oldStatuses, { same: "done" }],
    [realPersonal, [task("same", "canonical text")]],
    [realStatuses, {}],
  ]);
  assert.equal(
    (await migrateRetiredPersonal(config, f.store, f.browserStorage)).ok,
    true,
  );
  assert.equal(f.rows.get(realPersonal)[0].title, "canonical text");
  assert.deepEqual(f.rows.get(realStatuses), {});
  assert.equal(
    f.rows.get(history).copies[0].personal[0].title,
    "older context text",
  );
});
test("quota or unverified readback leaves every old source intact", async () => {
  for (const options of [{ durable: false }, { readback: false }]) {
    const f = fixture(
      [
        [oldPersonal, [task("keep")]],
        [oldStatuses, { keep: "done" }],
      ],
      options,
    );
    assert.equal(
      (await migrateRetiredPersonal(config, f.store, f.browserStorage)).ok,
      false,
    );
    assert.deepEqual(f.rows.get(oldPersonal), [task("keep")]);
    assert.deepEqual(f.rows.get(oldStatuses), { keep: "done" });
  }
});
test("a canonical edit arriving before transactional merge is preserved and a changed old source is retried", async () => {
  let changed = false;
  const f = fixture([[oldPersonal, [task("first")]]], {
    onUpdate: (key, rows) => {
      if (key === realPersonal && !changed) {
        rows.set(realPersonal, [task("fresh-canonical")]);
        rows.set(oldPersonal, [task("first"), task("second")]);
        changed = true;
      }
    },
  });
  assert.equal(
    (await migrateRetiredPersonal(config, f.store, f.browserStorage)).ok,
    true,
  );
  assert.deepEqual(
    f.rows.get(realPersonal).map((task) => task.id),
    ["fresh-canonical", "first"],
  );
  assert.equal(f.rows.has(oldPersonal), true);
  assert.equal(
    (await migrateRetiredPersonal(config, f.store, f.browserStorage)).ok,
    true,
  );
  assert.deepEqual(
    f.rows.get(realPersonal).map((task) => task.id),
    ["fresh-canonical", "first", "second"],
  );
  assert.equal(f.rows.has(oldPersonal), false);
});
test("older completion lists affect only proven human IDs and retain an original plus a durable recovery copy", async () => {
  const f = fixture([[oldPersonal, [task("human")]]]);
  const key = config.legacyCompletionPrefixes[0] + "legacy-profile";
  f.local.set(key, JSON.stringify(["human", "unmatched-global"]));
  assert.equal(
    (await migrateRetiredPersonal(config, f.store, f.browserStorage)).ok,
    true,
  );
  assert.deepEqual(f.rows.get(realStatuses), { human: "done" });
  assert.equal(f.local.has(key), true);
  assert.equal(
    f.rows.get("personal-history:live:completion-lists").copies[0][0].value,
    JSON.stringify(["human", "unmatched-global"]),
  );
});
test("malformed personal collections are retained instead of being silently discarded", async () => {
  const f = fixture([
    [oldPersonal, { unexpected: "retain" }],
    [oldStatuses, { unknown: "done" }],
  ]);
  assert.equal(
    (await migrateRetiredPersonal(config, f.store, f.browserStorage)).ok,
    false,
  );
  assert.deepEqual(f.rows.get(oldPersonal), { unexpected: "retain" });
  assert.equal(f.rows.has(oldStatuses), true);
});

test("an older completion list can recover progress for an already canonical human entry without importing unrelated IDs", async () => {
  const f = fixture([[realPersonal, [task("already-human")]]]);
  const key = config.legacyCompletionPrefixes[0] + "legacy-profile";
  f.local.set(key, JSON.stringify(["already-human", "shared-record"]));
  assert.equal(
    (await migrateRetiredPersonal(config, f.store, f.browserStorage)).ok,
    true,
  );
  assert.deepEqual(f.rows.get(realStatuses), { "already-human": "done" });
  assert.deepEqual(f.rows.get(realPersonal), [task("already-human")]);
  assert.equal(f.local.has(key), true);
});
test("completed migration is idempotent and creates no duplicate personal entries or recovery copies", async () => {
  const f = fixture([[oldPersonal, [task("once")]]]);
  await migrateRetiredPersonal(config, f.store, f.browserStorage);
  const before = JSON.stringify([...f.rows]);
  assert.deepEqual(
    await migrateRetiredPersonal(config, f.store, f.browserStorage),
    { ok: true, migrated: false },
  );
  assert.equal(JSON.stringify([...f.rows]), before);
});
