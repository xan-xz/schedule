import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { migrateRetiredPersonal as migrate } from "../app/lib/personal-migration.mjs";
import { createPersonalLoader } from "../app/lib/client.mjs";
function lockQueue() {
  let tail = Promise.resolve();
  return {
    request(_name, _options, action) {
      const result = tail.then(action);
      tail = result.catch(() => {});
      return result;
    },
  };
}
const locks = lockQueue();
const migrateRetiredPersonal = (...args) => migrate(...args, locks);
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
  {
    durable = true,
    readback = true,
    onUpdate = () => {},
    retainSources = false,
  } = {},
) {
  const rows = new Map(entries),
    local = new Map();
  const store = {
    keys: async () => [...rows.keys()],
    get: async (key, fallback = null) =>
      structuredClone(rows.has(key) ? rows.get(key) : fallback),
    deleteIfUnchanged: async (entries) => {
      if (retainSources) return false;
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
      await onUpdate(key, rows);
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

test("retained source checkpoints preserve canonical deletion and edits even when an older tab later adds another human entry", async () => {
  const f = fixture(
    [
      [oldPersonal, [task("deleted"), task("edited")]],
      [oldStatuses, { deleted: "done", edited: "progress" }],
      [realPersonal, [task("canonical-only")]],
    ],
    { retainSources: true },
  );
  await migrateRetiredPersonal(config, f.store, f.browserStorage);
  f.rows.set(realPersonal, [task("edited", "Canonical edited title")]);
  f.rows.set(realStatuses, {});
  assert.deepEqual(
    await migrateRetiredPersonal(config, f.store, f.browserStorage),
    { ok: true, migrated: false },
  );
  assert.deepEqual(f.rows.get(realPersonal), [
    task("edited", "Canonical edited title"),
  ]);
  assert.deepEqual(f.rows.get(realStatuses), {});
  f.rows.set(oldPersonal, [
    task("deleted", "Late old text"),
    task("edited", "Late conflicting edit"),
    task("canonical-only", "Late source colliding with deleted canonical ID"),
    task("added-later"),
  ]);
  f.rows.set(oldStatuses, {
    deleted: "done",
    edited: "done",
    "added-later": "progress",
    unmatched: "done",
  });
  assert.equal(
    (await migrateRetiredPersonal(config, f.store, f.browserStorage)).ok,
    true,
  );
  assert.deepEqual(f.rows.get(realPersonal), [
    task("edited", "Canonical edited title"),
    task("added-later"),
  ]);
  assert.deepEqual(f.rows.get(realStatuses), { "added-later": "progress" });
  assert.equal(
    f.rows.get(history).copies.at(-1).personal[0].title,
    "Late old text",
  );
});

test("completion-only checkpoints do not restore reset progress when the retained list is unchanged or later grows", async () => {
  const f = fixture([[realPersonal, [task("human")]]], { retainSources: true });
  const key = config.legacyCompletionPrefixes[0] + "profile";
  f.local.set(key, JSON.stringify(["human"]));
  await migrateRetiredPersonal(config, f.store, f.browserStorage);
  assert.deepEqual(f.rows.get(realStatuses), { human: "done" });
  f.rows.set(realStatuses, {});
  assert.deepEqual(
    await migrateRetiredPersonal(config, f.store, f.browserStorage),
    { ok: true, migrated: false },
  );
  assert.deepEqual(f.rows.get(realStatuses), {});
  f.local.set(key, JSON.stringify(["human", "unmatched"]));
  await migrateRetiredPersonal(config, f.store, f.browserStorage);
  assert.deepEqual(f.rows.get(realStatuses), {});
});

test("failed or incomplete checkpoints never suppress a retry of an unfinished migration", async () => {
  const f = fixture([[oldPersonal, [task("retry")]]], { retainSources: true });
  const original = f.store.persisted;
  f.store.persisted = async (key, value) =>
    key === history && value.processedSources ? false : original(key, value);
  assert.equal(
    (await migrateRetiredPersonal(config, f.store, f.browserStorage)).ok,
    false,
  );
  assert.deepEqual(f.rows.get(oldPersonal), [task("retry")]);
  f.store.persisted = original;
  f.rows.get(history).processedSources[migration.personalFrom].complete = false;
  assert.deepEqual(
    await migrateRetiredPersonal(config, f.store, f.browserStorage),
    { ok: true, migrated: true },
  );
  assert.deepEqual(f.rows.get(realPersonal), [task("retry")]);
  assert.equal(
    f.rows.get(history).processedSources[migration.personalFrom].complete,
    true,
  );
});

test("a queued migration cannot snapshot stale history while another migration still holds the origin lock", async () => {
  let release, paused;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const reached = new Promise((resolve) => {
    paused = resolve;
  });
  let historyWrites = 0;
  const f = fixture([[oldPersonal, [task("deleted")]]], {
    retainSources: true,
    onUpdate: async (key) => {
      if (key === history && ++historyWrites === 2) {
        paused();
        await gate;
      }
    },
  });
  const queue = lockQueue();
  const first = migrate(config, f.store, f.browserStorage, queue);
  await reached;
  let readHistory = false;
  const secondStore = {
    ...f.store,
    get: async (key, ...rest) => {
      if (key === history) readHistory = true;
      return f.store.get(key, ...rest);
    },
  };
  const second = migrate(config, secondStore, f.browserStorage, queue);
  await Promise.resolve();
  assert.equal(readHistory, false);
  f.rows.set(realPersonal, []);
  release();
  assert.equal((await first).ok, true);
  assert.deepEqual(await second, { ok: true, migrated: false });
  assert.deepEqual(f.rows.get(realPersonal), []);
});

test("missing or rejected origin locks retain old sources without partial migration", async () => {
  for (const manager of [
    null,
    {
      request: async () => {
        throw Error("lock denied");
      },
    },
  ]) {
    const f = fixture([[oldPersonal, [task("keep")]]], { retainSources: true });
    f.local.set(
      config.legacyCompletionPrefixes[0] + "profile",
      JSON.stringify(["keep"]),
    );
    const before = JSON.stringify([...f.rows]);
    assert.deepEqual(
      await migrate(config, f.store, f.browserStorage, manager),
      { ok: false, migrated: false },
    );
    assert.equal(JSON.stringify([...f.rows]), before);
    assert.equal(f.local.size, 1);
  }
  const empty = fixture([]);
  assert.deepEqual(
    await migrate(config, empty.store, empty.browserStorage, null),
    { ok: true, migrated: false },
  );
});

test("an empty startup map and a completion list arriving during migration do not checkpoint unobserved progress", async () => {
  const f = fixture(
    [
      [realPersonal, [task("canonical-human")]],
      [oldPersonal, [task("old-human")]],
      [oldStatuses, { "old-human": "progress" }],
    ],
    { retainSources: true },
  );
  await createPersonalLoader(f.store)({
    tasksKey: realPersonal,
    statusesKey: realStatuses,
    legacy: () => ({}),
  });
  assert.deepEqual(f.rows.get(realStatuses), {});
  let reached, release;
  const atKeys = new Promise((resolve) => {
    reached = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const keys = f.store.keys;
  f.store.keys = async () => {
    reached();
    await gate;
    return keys();
  };
  const first = migrateRetiredPersonal(config, f.store, f.browserStorage);
  await atKeys;
  f.local.set(
    config.legacyCompletionPrefixes[0] + "profile",
    JSON.stringify(["canonical-human", "unmatched"]),
  );
  release();
  assert.equal((await first).ok, true);
  f.store.keys = keys;
  assert.deepEqual(f.rows.get(realStatuses), { "old-human": "progress" });
  assert.equal(
    (await migrateRetiredPersonal(config, f.store, f.browserStorage)).ok,
    true,
  );
  assert.deepEqual(f.rows.get(realStatuses), {
    "old-human": "progress",
    "canonical-human": "done",
  });
  f.rows.set(realStatuses, {});
  await migrateRetiredPersonal(config, f.store, f.browserStorage);
  assert.deepEqual(f.rows.get(realStatuses), {});
});

test("explicit canonical new values and blocked ID collisions remain protected against later completion proof", async () => {
  const explicit = fixture(
    [
      [realPersonal, [task("human")]],
      [realStatuses, { human: "new" }],
      [oldPersonal, [task("other")]],
    ],
    { retainSources: true },
  );
  await migrateRetiredPersonal(config, explicit.store, explicit.browserStorage);
  explicit.rows.set(realStatuses, {});
  explicit.local.set(
    config.legacyCompletionPrefixes[0] + "profile",
    JSON.stringify(["human"]),
  );
  await migrateRetiredPersonal(config, explicit.store, explicit.browserStorage);
  assert.deepEqual(explicit.rows.get(realStatuses), {});
  const collision = fixture(
    [
      [realPersonal, [task("same", "Canonical")]],
      [oldPersonal, [task("same", "Different old text")]],
    ],
    { retainSources: true },
  );
  await migrateRetiredPersonal(
    config,
    collision.store,
    collision.browserStorage,
  );
  collision.rows.set(oldPersonal, [task("same", "Canonical")]);
  collision.rows.set(oldStatuses, { same: "done" });
  await migrateRetiredPersonal(
    config,
    collision.store,
    collision.browserStorage,
  );
  assert.deepEqual(collision.rows.get(realStatuses), {});
});
