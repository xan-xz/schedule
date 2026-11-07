import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { setImmediate } from "node:timers/promises";
import {
  validateCompatibility,
  isRetirablePublicPrefix,
} from "../app/lib/compatibility-policy.mjs";

const manifest = JSON.parse(
  await readFile(new URL("../compatibility.json", import.meta.url), "utf8"),
);
const source = await readFile(
  new URL("../app/lib/compatibility.mjs", import.meta.url),
  "utf8",
);
const clone = () => structuredClone(manifest);

function localStore(rows = new Map()) {
  return {
    get length() {
      return rows.size;
    },
    key: (index) => [...rows.keys()][index],
    getItem: (key) => rows.get(key) ?? null,
    setItem: (key, value) => rows.set(key, value),
    removeItem: (key) => rows.delete(key),
    clear: () => {
      throw Error("A whole-store wipe is forbidden");
    },
  };
}

function client(
  config,
  { rows = new Map(), registrations = [], online = true } = {},
) {
  const replaced = [],
    retired = [];
  const query = new URLSearchParams({
    [manifest.retiredQueryParams[0]]: "owner",
    g: "g-main",
    subgroup: "А",
  });
  const context = {
    URL,
    validateCompatibility,
    AbortSignal,
    migrateRetiredPersonal: async () => ({ ok: true, migrated: false }),
    storage: {
      retirePrefixes: async (prefixes) => retired.push([...prefixes]),
    },
    localStorage: localStore(rows),
    location: { href: "https://example.test/schedule/?" + query + "#today" },
    history: { replaceState: (_state, _title, url) => replaced.push(url) },
    navigator: {
      serviceWorker: { getRegistrations: async () => registrations },
    },
    fetch: async () => {
      if (!online) throw Error("offline");
      return { ok: true, json: async () => config };
    },
  };
  const executable = source
    .replace(/^import[\s\S]*?from ["'][^"']+["'];\r?\n/gmu, "")
    .replaceAll(
      "import.meta.url",
      '"https://example.test/schedule/lib/compatibility.mjs"',
    )
    .replace(
      "export async function retireCompatibility",
      "async function retireCompatibility",
    );
  runInNewContext(
    executable + "\nglobalThis.run = retireCompatibility;",
    context,
  );
  return { run: context.run, rows, replaced, retired };
}

test("the actual transition manifest is valid and validation never rewrites it", () => {
  const before = clone();
  assert.equal(validateCompatibility(manifest), true);
  assert.deepEqual(manifest, before);
});

test("personal migration policy cannot target canonical data or mix unrelated contexts", () => {
  for (const migrations of [
    {},
    [null],
    [{ personalFrom: "personal:live:", statusesFrom: "statuses:live:" }],
    [{ personalFrom: "personal:old:", statusesFrom: "statuses:other:" }],
    [{ personalFrom: "personal:old:g:", statusesFrom: "statuses:old:" }],
  ]) {
    const config = clone();
    config.storage.personalMigrations = migrations;
    assert.equal(validateCompatibility(config), false);
  }
  for (const prefixes of ["invalid", [""], ["uf.tasks.live."], ["uf."]]) {
    const config = clone();
    config.storage.legacyCompletionPrefixes = prefixes;
    assert.equal(validateCompatibility(config), false);
  }
});

test("policy rejects malformed, root, traversal, external and reserved routes", () => {
  for (const path of [
    "",
    "./",
    "/",
    "/old/",
    "../other/",
    "https://other.test/",
    "//other.test/",
    "%2e%2e/",
    "admin/",
    "manage/",
    "lib/",
    "icons/",
    "backend/",
    "app/",
  ]) {
    const config = clone();
    config.legacyRoutes[0].path = path;
    assert.equal(validateCompatibility(config), false, path);
  }
  for (const target of [
    "/",
    "../",
    "https://other.test/",
    "//other.test/",
    "./manage/",
    "./admin/?role=owner",
  ]) {
    const config = clone();
    config.legacyRoutes[0].target = target;
    assert.equal(validateCompatibility(config), false, target);
  }
  const duplicate = clone();
  duplicate.legacyRoutes.push({ ...duplicate.legacyRoutes[0] });
  assert.equal(validateCompatibility(duplicate), false);
});

test("only exact declared single-segment worker scopes may be retired", () => {
  for (const scope of [
    "",
    "./",
    "../neighbor/",
    "admin/",
    "unlisted/",
    "https://other.test/schedule/",
  ]) {
    const config = clone();
    config.cacheScopes = [scope];
    assert.equal(validateCompatibility(config), false, scope);
  }
  const nested = clone();
  nested.legacyRoutes[1].worker = true;
  nested.cacheScopes.push(nested.legacyRoutes[1].path);
  assert.equal(validateCompatibility(nested), false);
  const workerTarget = clone();
  workerTarget.legacyRoutes[0].target = "./admin/";
  assert.equal(validateCompatibility(workerTarget), false);
});

test("real URL parameters and user storage namespaces cannot be retired", () => {
  for (const key of ["g", "G", "group", "subgroup", "date"]) {
    const config = clone();
    config.retiredQueryParams = [key];
    assert.equal(validateCompatibility(config), false, key);
  }
  const protectedKeys = [
    "",
    "uf.",
    "uf.student.",
    "uf.student.choice.v1",
    "uf.settings.v1",
    "uf.group",
    "uf.subgroup",
    "uf.dark",
    "para.group",
    "uf.tasks.live.guest",
    "uf.schedule.templates.v1.live",
    "uf.public.v1.snapshot:g-main",
    "neighbor.tasks",
  ];
  for (const key of protectedKeys)
    for (const field of ["localPrefixes", "localExact"]) {
      const config = clone();
      config.storage[field] = [key];
      assert.equal(validateCompatibility(config), false, key);
    }
});

test("public retirement rejects broad, narrower live, snapshot and metadata prefixes", () => {
  for (const prefix of [
    "",
    "personal:",
    "personal:live:",
    "personal:live:g-main:",
    "statuses:live:g-main:",
    "snapshot:",
    "student-choice:live:v1",
    "student-settings:live:v1",
    "__uf_meta_v1:",
    "__uf_meta_v1:personal:live:",
    "other:context:",
    null,
  ])
    assert.equal(isRetirablePublicPrefix(prefix), false, String(prefix));
  for (const prefix of manifest.storage.publicPrefixes)
    assert.equal(isRetirablePublicPrefix(prefix), true);
});

test("malformed policies are rejected instead of partially applying side effects", async () => {
  const invalid = [null, {}, { ...clone(), format: "unexpected" }];
  for (const field of ["localPrefixes", "localExact", "publicPrefixes"]) {
    const config = clone();
    config.storage[field] = [""];
    invalid.push(config);
  }
  const badScopes = clone();
  badScopes.cacheScopes = ["../neighbor/"];
  invalid.push(badScopes);
  for (const config of invalid) {
    const rows = new Map([
      ["uf.student.choice.v1", "saved"],
      ["neighbor", "saved"],
    ]);
    const before = [...rows];
    const page = client(config, { rows });
    await page.run();
    assert.deepEqual([...rows], before);
    assert.deepEqual(page.retired, []);
    assert.deepEqual(page.replaced, []);
  }
});

test("client cleanup touches only listed contexts and updates only the declared registration", async () => {
  const config = clone(),
    deletedKey = config.storage.localPrefixes[0] + "settings",
    kept = new Map([
      ["uf.student.choice.v1", "new choice"],
      ["uf.student.settings.v1", "new preferences"],
      ["uf.settings.v1", "legacy preferences"],
      ["uf.tasks.live.guest", "legacy tasks"],
      ["uf.schedule.templates.v1.live", "working templates"],
      ["para.group", "old choice"],
      ["neighbor.tasks", "other application"],
    ]),
    rows = new Map([...kept, [deletedKey, "retired only"]]),
    updates = [],
    messages = [];
  const root = "https://example.test/schedule/";
  const registrations = [config.cacheScopes[0], "./", "../neighbor/"].map(
    (scope) => ({
      scope: new URL(scope, root).href,
      update: async () => updates.push(scope),
      active: {
        postMessage: (message) => messages.push(message.type),
        addEventListener: () => {},
      },
    }),
  );
  const page = client(config, { rows, registrations });
  await page.run();
  await setImmediate();
  assert.deepEqual([...rows], [...kept]);
  assert.deepEqual(page.retired, [config.storage.publicPrefixes]);
  assert.deepEqual(updates, [config.cacheScopes[0]]);
  assert.deepEqual(messages, ["RETIRE_CHECK"]);
  const target = new URL(page.replaced[0], root);
  assert.equal(target.searchParams.has(config.retiredQueryParams[0]), false);
  assert.equal(target.searchParams.get("g"), "g-main");
  assert.equal(target.searchParams.get("subgroup"), "А");
  assert.equal(target.hash, "#today");
});

test("offline cleanup leaves URL, local records and registrations unchanged", async () => {
  const rows = new Map([
    [manifest.storage.localPrefixes[0] + "settings", "saved"],
  ]);
  const before = [...rows],
    page = client(clone(), { rows, online: false });
  await page.run();
  assert.deepEqual([...rows], before);
  assert.deepEqual(page.retired, []);
  assert.deepEqual(page.replaced, []);
});

function indexedStore(rows) {
  return {
    open() {
      const request = {};
      queueMicrotask(() => {
        request.result = {
          close() {},
          transaction() {
            const transaction = {};
            let pending = 0,
              completed = false;
            const finish = () => {
              if (!pending && !completed) {
                completed = true;
                transaction.oncomplete?.();
              }
            };
            const operation = (action) => {
              const result = {};
              pending++;
              queueMicrotask(() => {
                result.result = action();
                result.onsuccess?.();
                pending--;
                finish();
              });
              return result;
            };
            transaction.objectStore = () => ({
              get: (key) => operation(() => rows.get(key)),
              getAllKeys: () => operation(() => [...rows.keys()]),
              put: (value, key) => operation(() => rows.set(key, value)),
              delete: (key) => operation(() => rows.delete(key)),
            });
            queueMicrotask(finish);
            return transaction;
          },
        };
        request.onsuccess?.();
      });
      return request;
    },
  };
}

let caseId = 0;
async function storageFixture(t) {
  const descriptors = new Map(
    ["indexedDB", "localStorage"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const rows = new Map(),
    fallback = new Map();
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: indexedStore(rows),
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: localStore(fallback),
  });
  t.after(() => {
    for (const [key, descriptor] of descriptors)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
  });
  const storage = await import(
    `../app/lib/storage.mjs?retirement-case=${++caseId}`
  );
  return { rows, fallback, storage };
}

test("public cleanup removes retired payloads and sidecars from IDB/fallback/memory while preserving all working records", async (t) => {
  const { storage, rows, fallback } = await storageFixture(t);
  const retiredKeys = manifest.storage.publicPrefixes.map(
    (prefix) => prefix + "g-main:all",
  );
  const realKeys = [
    "personal:live:g-main:all",
    "statuses:live:g-main:all",
    "student-choice:live:v1",
    "student-settings:live:v1",
    "snapshot:g-main:all",
    "unrelated:record",
  ];
  for (const key of [...retiredKeys, ...realKeys])
    await storage.set(key, [{ key }]);
  fallback.set("neighbor.tasks", "untouched");
  const realRows = new Map(
    [...rows].filter(
      ([key]) =>
        !retiredKeys.some(
          (item) => key === item || key === "__uf_meta_v1:" + item,
        ),
    ),
  );
  assert.equal(
    await storage.retirePrefixes(manifest.storage.publicPrefixes),
    true,
  );
  assert.deepEqual(rows, realRows);
  for (const key of retiredKeys) {
    assert.equal(fallback.has("uf.public.v1." + key), false);
    assert.equal(fallback.has("uf.public.v1.__uf_meta_v1:" + key), false);
    assert.equal(await storage.get(key), null);
  }
  for (const key of realKeys)
    assert.deepEqual(await storage.get(key), [{ key }]);
  assert.equal(fallback.get("neighbor.tasks"), "untouched");
});

test("unsafe or partly unsafe public prefix requests have no partial deletion", async (t) => {
  const { storage, rows, fallback } = await storageFixture(t);
  await storage.set("personal:live:g-main:all", [{ title: "real" }]);
  await storage.set(manifest.storage.publicPrefixes[0] + "g-main:all", [
    { title: "retired" },
  ]);
  const beforeRows = structuredClone(rows),
    beforeFallback = structuredClone(fallback);
  for (const prefix of [
    "",
    "personal:",
    "personal:live:g-main:",
    "statuses:live:g-main:",
    "student-choice:live:v1",
    "snapshot:",
    "__uf_meta_v1:",
  ]) {
    assert.equal(
      await storage.retirePrefixes([
        manifest.storage.publicPrefixes[0],
        prefix,
      ]),
      false,
    );
    assert.deepEqual(rows, beforeRows);
    assert.deepEqual(fallback, beforeFallback);
  }
});
