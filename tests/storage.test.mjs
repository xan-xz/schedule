import test from "node:test";
import assert from "node:assert/strict";
import { get, set, del, clear } from "../app/lib/storage.mjs";

test("storage remains usable when persistent browser APIs are absent", async () => {
  await clear();
  assert.equal(await get("missing", "fallback"), "fallback");
  await set("public-snapshot", { revision: 3, lessons: [{ id: "one" }] });
  assert.deepEqual(await get("public-snapshot"), {
    revision: 3,
    lessons: [{ id: "one" }],
  });
  await del("public-snapshot");
  assert.equal(await get("public-snapshot"), null);
});

test("fallback stores only own prefixed keys and clear preserves unrelated app data", async () => {
  const saved = new Map([["para.group", "Б"]]);
  globalThis.localStorage = {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: (key) => saved.delete(key),
    key: (index) => [...saved.keys()][index],
    get length() {
      return saved.size;
    },
  };
  assert.equal(await set("preferences", { subgroup: "А" }), true);
  assert.ok(saved.has("uf.public.v1.preferences"));
  assert.deepEqual(JSON.parse(saved.get("uf.public.v1.preferences")), {
    subgroup: "А",
  });
  assert.deepEqual(await get("preferences"), { subgroup: "А" });
  await clear();
  assert.equal(saved.get("para.group"), "Б");
  assert.equal(saved.size, 1);
  delete globalThis.localStorage;
});

test("quota errors fall back to memory and corrupt stored JSON does not crash", async () => {
  globalThis.localStorage = {
    getItem: () => "{bad json",
    setItem: () => {
      throw new Error("quota");
    },
    removeItem: () => {},
  };
  assert.equal(await set("tasks", ["personal"]), false);
  assert.deepEqual(await get("tasks"), ["personal"]);
  assert.equal((await get("corrupt", [])).length, 0);
  delete globalThis.localStorage;
  await clear();
});

function fakeIndexedDB(rows, { failWrites = false, hanging = false } = {}) {
  return {
    open() {
      const request = {};
      queueMicrotask(() => {
        request.result = {
          close() {},
          transaction(_store, mode) {
            const transaction = {
              abort() {
                transaction.onabort?.();
              },
            };
            transaction.objectStore = () => ({
              get(key) {
                return operation(() => rows.get(key));
              },
              put(value, key) {
                return operation(() => rows.set(key, value));
              },
              delete(key) {
                return operation(() => rows.delete(key));
              },
              clear() {
                return operation(() => rows.clear());
              },
            });
            function operation(action) {
              const result = {};
              if (!hanging)
                queueMicrotask(() => {
                  if (mode === "readwrite" && failWrites) {
                    transaction.onabort?.();
                    return;
                  }
                  result.result = action();
                  result.onsuccess?.();
                  transaction.oncomplete?.();
                });
              return result;
            }
            return transaction;
          },
        };
        request.onsuccess?.();
      });
      return request;
    },
  };
}

function fakeLocalStorage(saved = new Map()) {
  return {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: (key) => saved.delete(key),
  };
}

let moduleCase = 0;
async function freshStorage() {
  return import(`../app/lib/storage.mjs?storage-case=${++moduleCase}`);
}

test("a readable old IDB row cannot replace a newer fallback after quota failure or reload", async () => {
  const rows = new Map([["tasks", [{ id: "old" }]]]);
  globalThis.indexedDB = fakeIndexedDB(rows, { failWrites: true });
  globalThis.localStorage = fakeLocalStorage();
  try {
    const storage = await freshStorage();
    assert.deepEqual(await storage.get("tasks"), [{ id: "old" }]);
    assert.equal(
      await storage.set("tasks", [{ id: "old" }, { id: "new" }]),
      true,
    );
    assert.deepEqual(await storage.get("tasks"), [
      { id: "old" },
      { id: "new" },
    ]);
    assert.deepEqual(rows.get("tasks"), [{ id: "old" }]);
    const reloaded = await freshStorage();
    assert.deepEqual(await reloaded.get("tasks"), [
      { id: "old" },
      { id: "new" },
    ]);
  } finally {
    delete globalThis.indexedDB;
    delete globalThis.localStorage;
  }
});

test("memory-only updates survive a readable old IDB row when both writes are denied", async () => {
  globalThis.indexedDB = fakeIndexedDB(new Map([["tasks", ["old"]]]), {
    failWrites: true,
  });
  globalThis.localStorage = {
    getItem() {
      throw Error("denied");
    },
    setItem() {
      throw Error("denied");
    },
  };
  try {
    const storage = await freshStorage();
    assert.equal(await storage.set("tasks", ["new"]), false);
    assert.deepEqual(await storage.get("tasks"), ["new"]);
  } finally {
    delete globalThis.indexedDB;
    delete globalThis.localStorage;
  }
});

test("new IDB data wins over an older fallback even if removing that fallback is denied", async () => {
  const saved = new Map([
    [
      "uf.public.v1.tasks",
      JSON.stringify({
        format: "uniflow-public-record-v1",
        writtenAt: 1,
        value: ["old"],
      }),
    ],
  ]);
  globalThis.indexedDB = fakeIndexedDB(new Map());
  globalThis.localStorage = {
    ...fakeLocalStorage(saved),
    removeItem() {
      throw Error("denied");
    },
  };
  try {
    const storage = await freshStorage();
    assert.equal(await storage.set("tasks", ["new"]), true);
    const reloaded = await freshStorage();
    assert.deepEqual(await reloaded.get("tasks"), ["new"]);
  } finally {
    delete globalThis.indexedDB;
    delete globalThis.localStorage;
  }
});

test("new writes keep raw row shapes readable by an already installed older client", async () => {
  const rows = new Map();
  globalThis.indexedDB = fakeIndexedDB(rows);
  try {
    const storage = await freshStorage();
    const tasks = [{ id: "personal", title: "Keep the original array" }];
    const snapshot = {
      revision: 5,
      data: { groups: [{ id: "g-main" }], lessons: [] },
    };
    assert.equal(await storage.set("tasks", tasks), true);
    assert.equal(await storage.set("snapshot:g-main:А", snapshot), true);
    assert.deepEqual(rows.get("tasks"), tasks);
    assert.deepEqual(rows.get("snapshot:g-main:А"), snapshot);
    assert.equal(typeof rows.get("__uf_meta_v1:tasks").writtenAt, "number");
    assert.deepEqual(await storage.get("tasks"), tasks);
    rows.set("tasks", [...tasks, { id: "written-by-older-tab" }]);
    assert.equal(
      (await storage.get("tasks")).at(-1).id,
      "written-by-older-tab",
    );
    rows.set("tasks", [...tasks, { id: "written-again-by-older-tab" }]);
    assert.equal(
      (await storage.get("tasks")).at(-1).id,
      "written-again-by-older-tab",
    );
  } finally {
    delete globalThis.indexedDB;
  }
});

test("a quota-blocked compatibility key does not destroy its new backup or a later old-tab write", async () => {
  const rawKey = "uf.public.v1.tasks",
    metaKey = "uf.public.v1.__uf_meta_v1:tasks";
  const saved = new Map([[rawKey, JSON.stringify(["original"])]]);
  globalThis.indexedDB = fakeIndexedDB(new Map([["tasks", ["original"]]]), {
    failWrites: true,
  });
  globalThis.localStorage = {
    ...fakeLocalStorage(saved),
    setItem(key, value) {
      if (key === rawKey) throw Error("raw key quota");
      saved.set(key, value);
    },
  };
  try {
    const storage = await freshStorage();
    assert.equal(await storage.set("tasks", ["new-backup"]), true);
    assert.deepEqual(await storage.get("tasks"), ["new-backup"]);
    saved.set(rawKey, JSON.stringify(["older-tab-new-write"]));
    assert.deepEqual(await storage.get("tasks"), ["older-tab-new-write"]);
    assert.deepEqual(JSON.parse(saved.get(metaKey)).value, ["new-backup"]);
    const reloaded = await freshStorage();
    assert.deepEqual(await reloaded.get("tasks"), ["older-tab-new-write"]);
    assert.equal(await reloaded.set("tasks", ["another-new-write"]), true);
    assert.deepEqual(await reloaded.get("tasks"), ["another-new-write"]);
    assert.deepEqual(JSON.parse(saved.get(metaKey)).alternatives[0].value, [
      "new-backup",
    ]);
  } finally {
    delete globalThis.indexedDB;
    delete globalThis.localStorage;
  }
});

test("a later legacy local-only fallback is observed without letting an old leftover override a new IDB write", async () => {
  const rawKey = "uf.public.v1.tasks";
  const saved = new Map([[rawKey, JSON.stringify(["old-leftover"])]]);
  const rows = new Map();
  globalThis.indexedDB = fakeIndexedDB(rows);
  globalThis.localStorage = {
    ...fakeLocalStorage(saved),
    removeItem() {
      throw Error("remove denied");
    },
  };
  try {
    const storage = await freshStorage();
    assert.equal(await storage.set("tasks", ["new-IDB-write"]), true);
    assert.deepEqual(await storage.get("tasks"), ["new-IDB-write"]);
    saved.set(rawKey, JSON.stringify(["later-legacy-local-write"]));
    assert.deepEqual(await storage.get("tasks"), ["later-legacy-local-write"]);
  } finally {
    delete globalThis.indexedDB;
    delete globalThis.localStorage;
  }
});

test("stalled IDB transactions stop waiting and preserve a usable in-memory update", async () => {
  globalThis.indexedDB = fakeIndexedDB(new Map(), { hanging: true });
  try {
    const storage = await freshStorage();
    assert.equal(await storage.set("tasks", ["new"]), false);
    assert.deepEqual(await storage.get("tasks"), ["new"]);
  } finally {
    delete globalThis.indexedDB;
  }
});
