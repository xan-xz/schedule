import test from "node:test";
import assert from "node:assert/strict";
import {
  createDraftJournal,
  draftChanges,
  recoverChanges,
} from "../app/manage/drafts.mjs";

const base = () => ({
  groups: [{ id: "g", name: "Group", subgroups: ["А"] }],
  subjects: [{ id: "s", name: "Subject" }],
  teachers: [],
  rooms: [{ id: "r", name: "204", capacity: 20 }],
  lessons: [
    {
      id: "l",
      groupId: "g",
      subjectId: "s",
      roomId: "r",
      subgroup: "А",
      day: 0,
      week: "all",
      start: "08:00",
      end: "08:50",
      source: { sheet: "Sheet", timeCell: "A1" },
    },
  ],
  exceptions: [],
  requests: [{ private: "retained only on server" }],
  attendance: [{ private: "retained only on server" }],
  history: [{ private: "retained only on server" }],
  siteSettings: { serverOnly: { private: "never stored" } },
});
const changed = () => {
  const d = base();
  d.lessons[0].roomId = "other";
  return d;
};
function fakeDatabase() {
  const rows = new Map();
  let tail = Promise.resolve(),
    denyWrites = false;
  const db = {
    createObjectStore() {},
    close() {},
    transaction(_name, mode) {
      let release,
        pending = 0,
        finished = false,
        workspace;
      const begin = tail;
      tail = new Promise((resolve) => {
        release = resolve;
      });
      const tx = {
        abort() {
          if (finished) return;
          finished = true;
          tx.onabort?.();
          release();
        },
      };
      function request(action) {
        const request = {};
        pending++;
        begin.then(() =>
          queueMicrotask(() => {
            if (finished) return;
            workspace ||= structuredClone(rows);
            if (mode === "readwrite" && denyWrites) {
              tx.abort();
              return;
            }
            try {
              request.result = action(workspace);
              request.onsuccess?.();
            } catch {
              tx.abort();
              return;
            }
            pending--;
            queueMicrotask(() => {
              if (!finished && pending === 0) {
                finished = true;
                if (mode === "readwrite") {
                  rows.clear();
                  for (const [key, value] of workspace) rows.set(key, value);
                }
                tx.oncomplete?.();
                release();
              }
            });
          }),
        );
        return request;
      }
      tx.objectStore = () => ({
        get: (key) => request((map) => structuredClone(map.get(key))),
        getAll: () => request((map) => structuredClone([...map.values()])),
        put: (value, key) =>
          request((map) => {
            map.set(key, structuredClone(value));
            return key;
          }),
        add: (value, key) =>
          request((map) => {
            if (map.has(key)) throw Error("duplicate key");
            map.set(key, structuredClone(value));
            return key;
          }),
      });
      return tx;
    },
  };
  return {
    rows,
    setDenied(value) {
      denyWrites = value;
    },
    indexedDB: {
      open() {
        const req = { result: db };
        queueMicrotask(() => req.onsuccess?.());
        return req;
      },
    },
  };
}
function journal() {
  const db = fakeDatabase();
  let serial = 0;
  return {
    db,
    store: createDraftJournal({
      indexedDB: db.indexedDB,
      now: () => 10,
      uuid: () => "fork-" + ++serial,
    }),
  };
}
const input = (id = "draft") => ({
  id,
  generation: 0,
  baseRevision: 7,
  changes: draftChanges(base(), changed()),
});

test("only authored domain fields enter deltas; API/private archives and unknown settings never do", () => {
  const before = base(),
    after = changed();
  after.requests.push({ token: "must not persist" });
  after.history = [];
  after.attendance = [];
  const changes = draftChanges(before, after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, "lessons");
  const serialized = JSON.stringify(changes);
  for (const field of [
    "private",
    "serverOnly",
    "attendance",
    "history",
    "token",
    "requests",
  ])
    assert.equal(serialized.includes(field), false, field);
  const candidate = recoverChanges(base(), changes).data;
  assert.deepEqual(candidate.requests, before.requests);
  assert.deepEqual(candidate.attendance, before.attendance);
  assert.deepEqual(candidate.history, before.history);
  assert.deepEqual(candidate.lessons[0].source, before.lessons[0].source);
});
test("recovery rebases changed fields and preserves unrelated fresh row fields", () => {
  const next = base();
  next.lessons[0].type = "Fresh server field";
  next.lessons[0].privateExtension = { keep: true };
  const recovered = recoverChanges(next, draftChanges(base(), changed()));
  assert.equal(recovered.conflicts.length, 0);
  assert.equal(recovered.data.lessons[0].roomId, "other");
  assert.equal(recovered.data.lessons[0].type, "Fresh server field");
  assert.deepEqual(recovered.data.lessons[0].privateExtension, { keep: true });
});

test("unchanged unknown source metadata is neither copied nor allowed to block ordinary authored deltas", () => {
  const before = base();
  before.source = {
    file: "Schedule.xlsx",
    futurePrivateSibling: { keep: "server only" },
  };
  const after = structuredClone(before);
  after.lessons[0].roomId = "other";
  const changes = draftChanges(before, after);
  assert.equal(changes.length, 1);
  assert.equal(JSON.stringify(changes).includes("futurePrivateSibling"), false);
  assert.deepEqual(recoverChanges(before, changes).data.source, before.source);
});
test("touched conflicts remain unchanged until explicit force, including removal or colliding new IDs", () => {
  const fresh = base();
  fresh.lessons[0].roomId = "latest";
  const changes = draftChanges(base(), changed());
  assert.equal(recoverChanges(fresh, changes).conflicts.length, 1);
  assert.equal(recoverChanges(fresh, changes).data.lessons[0].roomId, "latest");
  assert.equal(
    recoverChanges(fresh, changes, { force: true }).data.lessons[0].roomId,
    "other",
  );
  const removed = base();
  removed.lessons = [];
  assert.equal(
    recoverChanges(fresh, draftChanges(base(), removed)).conflicts.length,
    1,
  );
});
test("term bounds and appearance policy preserve unrelated settings and explicit field removal", () => {
  const before = base(),
    after = base();
  before.validUntil = "2026-12-01";
  after.siteSettings.appearance = {
    version: 1,
    defaultPalette: "violet",
    allowedLayouts: ["focus"],
  };
  const changes = draftChanges(before, after),
    fresh = structuredClone(before);
  fresh.siteSettings.newServerSibling = { keep: true };
  const candidate = recoverChanges(fresh, changes).data;
  assert.equal(Object.hasOwn(candidate, "validUntil"), false);
  assert.deepEqual(candidate.siteSettings.newServerSibling, { keep: true });
  assert.deepEqual(
    candidate.siteSettings.appearance,
    after.siteSettings.appearance,
  );
});
test("unknown changed fields and nested credentials cannot be silently persisted", async () => {
  const after = changed();
  after.lessons[0].unknownEditable = "new";
  assert.throws(() => draftChanges(base(), after), /дополнительные поля/);
  const f = journal();
  await assert.rejects(() =>
    f.store.save("owner", {
      ...input(),
      changes: [{ kind: "history", id: "x", before: null, after: { id: "x" } }],
    }),
  );
  await assert.rejects(() =>
    f.store.save("owner", {
      ...input(),
      changes: [
        {
          kind: "lessons",
          id: "l",
          before: null,
          after: { id: "l", token: "forbidden" },
        },
      ],
    }),
  );
  const token = "ow1a." + "a".repeat(64),
    data = changed();
  data.groups[0].name = token;
  assert.throws(() => draftChanges(base(), data));
  assert.equal(f.db.rows.size, 0);
});
test("a completed transaction survives a new journal instance without requiring a token", async () => {
  const f = journal(),
    saved = await f.store.save("owner", input());
  assert.equal(saved.record.generation, 1);
  const fresh = createDraftJournal({ indexedDB: f.db.indexedDB });
  assert.deepEqual(await fresh.list("owner"), [saved.record]);
  assert.deepEqual(await fresh.list("different-owner"), []);
});
test("stale concurrent saves fork instead of overwriting a newer tab's draft", async () => {
  const f = journal(),
    first = (await f.store.save("owner", input())).record;
  const newer = { ...first, changes: [] };
  const [a, b] = await Promise.all([
    f.store.save("owner", newer),
    f.store.save("owner", first),
  ]);
  assert.equal(a.forked, false);
  assert.equal(b.forked, true);
  assert.notEqual(a.record.id, b.record.id);
  assert.equal((await f.store.list("owner")).length, 2);
  assert.deepEqual(f.db.rows.get(first.id).changes, []);
});
test("publish/discard archives require the same generation and never erase newer edits", async () => {
  const f = journal(),
    first = (await f.store.save("owner", input())).record;
  const newer = (await f.store.save("owner", first)).record;
  await assert.rejects(
    () => f.store.archive("owner", first, "published"),
    /другой вкладке/,
  );
  assert.equal(f.db.rows.get(first.id).status, "active");
  assert.equal(
    (await f.store.archive("owner", newer, "discarded")).status,
    "archived",
  );
  const fork = await f.store.save("owner", newer);
  assert.equal(fork.forked, true);
  assert.equal(f.db.rows.get(first.id).status, "archived");
});
test("quota failures retain the prior durable generation and can safely retry", async () => {
  const f = journal(),
    first = (await f.store.save("owner", input())).record;
  f.db.setDenied(true);
  await assert.rejects(
    () => f.store.save("owner", { ...first, changes: [] }),
    /сохранение недоступно/,
  );
  assert.deepEqual(f.db.rows.get(first.id), first);
  f.db.setDenied(false);
  const retry = await f.store.save("owner", { ...first, changes: [] });
  assert.equal(retry.record.generation, 2);
  assert.equal(retry.forked, false);
});
test("another owner cannot mutate or archive a discovered record ID", async () => {
  const f = journal(),
    first = (await f.store.save("owner", input())).record;
  await assert.rejects(
    () => f.store.save("different-owner", first),
    /другому владельцу/,
  );
  await assert.rejects(
    () => f.store.archive("different-owner", first, "discarded"),
    /другому владельцу/,
  );
  assert.deepEqual(f.db.rows.get(first.id), first);
});

test("even a generated fork-ID collision cannot overwrite an existing local copy", async () => {
  const f = journal();
  const first = (await f.store.save("owner", input())).record;
  await f.store.save("owner", input("fork-1"));
  await f.store.save("owner", first);
  const before = structuredClone(f.db.rows);
  await assert.rejects(() => f.store.save("owner", first));
  assert.deepEqual(f.db.rows, before);
});
