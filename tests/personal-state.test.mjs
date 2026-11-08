import test from "node:test";
import assert from "node:assert/strict";
import { createPersonalLoader } from "../app/lib/client.mjs";

function gate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const scope = {
  tasksKey: "personal:live:g:А",
  statusesKey: "statuses:live:g:А",
  legacy: () => ({}),
};

test("a missing initial read cannot overwrite progress migrated before atomic initialization", async () => {
  const read = gate(),
    write = gate();
  let statuses = null;
  const store = {
    get: async (key) => (key === scope.tasksKey ? [{ id: "human" }] : null),
    update: async (_key, transform) => {
      read.release();
      await write.promise;
      statuses = transform(statuses);
      return { persisted: true, value: statuses };
    },
  };
  const pending = createPersonalLoader(store)(scope);
  await read.promise;
  statuses = { human: "done" };
  write.release();
  const result = await pending;
  assert.deepEqual(statuses, { human: "done" });
  assert.deepEqual(result.statuses, { human: "done" });
});

test("an older delayed read cannot replace the newer same-scope view", async () => {
  const paused = gate();
  let reads = 0;
  const store = {
    get: async (key) => {
      if (key === scope.tasksKey) {
        const call = ++reads;
        if (call === 1) {
          await paused.promise;
          return [{ id: "old" }];
        }
        return [{ id: "new" }];
      }
      return { human: "done" };
    },
    update: () => {
      throw Error("Existing progress must not be initialized");
    },
  };
  const load = createPersonalLoader(store),
    older = load(scope),
    newer = await load(scope);
  paused.release();
  assert.deepEqual(newer.tasks, [{ id: "new" }]);
  assert.equal(await older, null);
});

test("a newer request also invalidates an older initialization already in flight", async () => {
  const reached = gate(),
    release = gate();
  let first = true;
  const store = {
    get: async (key) =>
      key === scope.tasksKey ? [] : first ? null : { human: "progress" },
    update: async () => {
      reached.release();
      await release.promise;
      return { persisted: true, value: { human: "done" } };
    },
  };
  const load = createPersonalLoader(store),
    older = load(scope);
  await reached.promise;
  first = false;
  const current = await load(scope);
  release.release();
  assert.deepEqual(current.statuses, { human: "progress" });
  assert.equal(await older, null);
});

test("a changed group/subgroup scope suppresses stale initialization and UI data", async () => {
  const release = gate();
  let current = true,
    writes = 0;
  const store = {
    get: async (key) => {
      await release.promise;
      return key === scope.tasksKey ? [{ id: "old-group" }] : null;
    },
    update: () => {
      writes++;
      throw Error("An expired scope must not write");
    },
  };
  const pending = createPersonalLoader(store)({
    ...scope,
    isCurrent: () => current,
  });
  current = false;
  release.release();
  assert.equal(await pending, null);
  assert.equal(writes, 0);
});

test("legacy input is captured once and an existing canonical map wins without initialization", async () => {
  let legacy = { legacy: "done" },
    reads = 0,
    writes = 0;
  const store = {
    get: async (key) => (key === scope.tasksKey ? [] : { canonical: "new" }),
    update: () => {
      writes++;
    },
  };
  const pending = createPersonalLoader(store)({
    ...scope,
    legacy: () => {
      reads++;
      return legacy;
    },
  });
  legacy = { different: "done" };
  assert.deepEqual((await pending).statuses, { canonical: "new" });
  assert.equal(reads, 1);
  assert.equal(writes, 0);
});
