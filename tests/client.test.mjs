import test from "node:test";
import assert from "node:assert/strict";
import {
  getSnapshot,
  saveSnapshot,
  publicState,
  snapshotKey,
  legacyTaskStatuses,
} from "../beta/lib/client.mjs";
import { get, clear } from "../beta/lib/storage.mjs";

const base = () => ({
  groups: [{ id: "g", subgroups: ["А", "Б"] }],
  lessons: [],
  teachers: [],
  subjects: [],
  rooms: [],
  exceptions: [],
  tasks: [
    { id: "a", groupId: "g", subgroup: "А" },
    { id: "b", groupId: "g", subgroup: "Б" },
    { id: "shared", groupId: "g", subgroup: "all" },
    { id: "other", groupId: "other", subgroup: "А" },
  ],
  announcements: [
    { id: "group", groupId: "g", teacherId: "t", roles: ["student"] },
    { id: "other", groupId: "other", roles: ["student"] },
    { id: "staff", groupId: "g", roles: ["admin"] },
    { id: "teacher", teacherId: "t", roles: ["student", "teacher"] },
    { id: "global", roles: ["student"] },
  ],
  accounts: [{ password_hash: "must-not-persist" }],
  attendance: [{ studentId: "private" }],
  requests: [{ reason: "private" }],
  history: [{ actor: "private" }],
});

test("public snapshots enforce group/subgroup scope and remove privileged collections at storage boundary", async () => {
  await clear();
  const settings = { groupId: "g", subgroup: "А" };
  await saveSnapshot(settings, {
    data: base(),
    revision: 2,
    updatedAt: "2026-11-06T00:00:00Z",
    source: "live",
    token: "must-not-persist",
    users: ["private"],
  });
  const raw = await get(snapshotKey(settings));
  assert.deepEqual(
    raw.data.tasks.map((item) => item.id),
    ["a", "shared"],
  );
  assert.deepEqual(
    raw.data.announcements.map((item) => item.id),
    ["group", "global"],
  );
  for (const key of ["attendance", "requests", "history"])
    assert.deepEqual(raw.data[key], []);
  assert.equal(raw.data.accounts, undefined);
  assert.equal(raw.token, undefined);
  assert.equal(raw.users, undefined);
  assert.equal(await getSnapshot({ groupId: "other", subgroup: "А" }), null);
});

test("all-subgroups compatibility merges A/B tasks without duplicate shared tasks", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    const subgroup = body.subgroup === "Б" ? "Б" : "А";
    const data = base();
    data.tasks = data.tasks.filter(
      (task) =>
        task.groupId === "g" && ["all", subgroup].includes(task.subgroup),
    );
    return {
      ok: true,
      json: async () => ({
        data,
        revision: 4,
        user: { role: "guest", subgroup },
      }),
    };
  };
  try {
    const state = await publicState("g", "all");
    assert.deepEqual(state.data.tasks.map((item) => item.id).sort(), [
      "a",
      "b",
      "shared",
    ]);
    assert.deepEqual(
      calls.map((call) => call.subgroup),
      ["all", "Б"],
    );
    assert.ok(calls.every((call) => call.action === "state" && !call.token));
    assert.equal(state.source, "live");
  } finally {
    globalThis.fetch = original;
  }
});

test("a failed subgroup request never persists a partial all-subgroup snapshot", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    return body.subgroup === "Б"
      ? { ok: false, status: 503 }
      : {
          ok: true,
          json: async () => ({
            data: base(),
            revision: 4,
            user: { subgroup: "А" },
          }),
        };
  };
  try {
    await assert.rejects(publicState("g", "all"), /state 503/);
  } finally {
    globalThis.fetch = original;
  }
});

function withLegacy(values, run) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const saved = new Map(
    Object.entries(values).map(([key, value]) => [
      key,
      typeof value === "string" ? value : JSON.stringify(value),
    ]),
  );
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key) => saved.get(key) ?? null },
  });
  try {
    run(saved);
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
  }
}

test("legacy completion IDs migrate into done statuses without mixing live and demo or deleting old lists", () => {
  withLegacy(
    {
      "uf.tasks.live.guest": ["live-id", "stable-uuid"],
      "uf.tasks.demo.demo-student-a": ["demo-a"],
      "uf.tasks.demo.demo-student-b": ["demo-b"],
    },
    (saved) => {
      const before = [...saved];
      assert.deepEqual(
        legacyTaskStatuses({ groupId: "g-main", subgroup: "А" }, "live"),
        { "live-id": "done", "stable-uuid": "done" },
      );
      assert.deepEqual(
        legacyTaskStatuses({ groupId: "g-main", subgroup: "А" }, "demo"),
        { "demo-a": "done" },
      );
      assert.deepEqual(
        legacyTaskStatuses({ groupId: "g-main", subgroup: "Б" }, "demo"),
        { "demo-b": "done" },
      );
      assert.deepEqual(
        legacyTaskStatuses({ groupId: "g-main", subgroup: "all" }, "demo"),
        { "demo-a": "done", "demo-b": "done" },
      );
      assert.deepEqual([...saved], before);
    },
  );
});

test("other demo groups use their actual generated account IDs and both-subgroup union deduplicates shared tasks", () => {
  withLegacy(
    {
      "uf.tasks.demo.demo-student-g-25-12-0": ["first", "common"],
      "uf.tasks.demo.demo-student-g-25-12-1": ["second", "common"],
      "uf.tasks.demo.demo-student-a": ["wrong-group"],
    },
    () => {
      assert.deepEqual(
        legacyTaskStatuses({ groupId: "g-25-12", subgroup: "А" }, "demo"),
        { first: "done", common: "done" },
      );
      assert.deepEqual(
        legacyTaskStatuses({ groupId: "g-25-12", subgroup: "all" }, "demo"),
        { first: "done", common: "done", second: "done" },
      );
      assert.deepEqual(
        legacyTaskStatuses({ groupId: "g-25-13", subgroup: "all" }, "demo"),
        {},
      );
    },
  );
});

test("corrupt legacy JSON and wrong value types are ignored without inventing completion records", () => {
  withLegacy(
    {
      "uf.tasks.live.guest": "{invalid json",
      "uf.tasks.demo.demo-student-a": [
        null,
        4,
        "",
        "valid",
        "valid",
        "__proto__",
      ],
      "uf.tasks.demo.demo-student-b": { id: "not-an-array" },
    },
    () => {
      assert.deepEqual(
        legacyTaskStatuses({ groupId: "g-main", subgroup: "А" }, "live"),
        {},
      );
      const statuses = legacyTaskStatuses(
        { groupId: "g-main", subgroup: "all" },
        "demo",
      );
      assert.equal(statuses.valid, "done");
      assert.equal(Object.hasOwn(statuses, "__proto__"), true);
      assert.equal(Object.getPrototypeOf(statuses), Object.prototype);
      assert.equal(Object.keys(statuses).length, 2);
      assert.deepEqual(
        legacyTaskStatuses({ groupId: "g-main", subgroup: "А" }, "unknown"),
        {},
      );
    },
  );
});
