import test from "node:test";
import assert from "node:assert/strict";
import { mutate } from "../backend/core.mjs";
import { fixture } from "./e2e/fixtures.mjs";
import {
  draftChanges,
  recoverChanges,
  catalogReplacementIntents,
} from "../app/manage/drafts.mjs";

const base = () => ({
  groups: [
    {
      id: "old",
      name: "Original",
      subgroups: ["А"],
      provenance: { private: "server metadata" },
    },
  ],
  subjects: [],
  teachers: [],
  rooms: [],
  lessons: [],
  exceptions: [],
  tasks: [
    { id: "private-task", groupId: "old", description: "private content" },
  ],
  requests: [{ private: "not a local draft" }],
  attendance: [],
  siteSettings: { unknown: { private: "server only" } },
});
test("catalog removal journals only authored fields and primitive replacement intent; fresh private data stays on server basis", () => {
  const before = base(),
    after = structuredClone(before);
  after.groups = [{ id: "new", name: "Replacement", subgroups: ["А"] }];
  after.tasks[0].groupId = "new";
  const changes = draftChanges(before, after, [
    { entity: "groups", id: "old", replacementId: "new" },
  ]);
  const serialized = JSON.stringify(changes);
  for (const forbidden of [
    "private-task",
    "private content",
    "provenance",
    "server metadata",
    "requests",
    "attendance",
    "siteSettings",
  ])
    assert.equal(serialized.includes(forbidden), false, forbidden);
  const fresh = base();
  fresh.tasks.push({ id: "new-private", groupId: "old" });
  const recovered = recoverChanges(fresh, changes);
  assert.deepEqual(recovered.catalogReplacements, [
    { entity: "groups", id: "old", replacementId: "new" },
  ]);
  assert.deepEqual(recovered.data.tasks, fresh.tasks);
  assert.deepEqual(recovered.data.siteSettings, fresh.siteSettings);
  assert.deepEqual(recovered.data.groups, after.groups);
});
test("replacement intent rejects private fields, chains, cycles, duplicate sources and token-shaped identifiers", () => {
  const intent = { entity: "rooms", id: "a", replacementId: "b" };
  for (const input of [
    [{ ...intent, requests: [] }],
    [intent, { entity: "rooms", id: "b", replacementId: "c" }],
    [intent, { entity: "rooms", id: "b", replacementId: "a" }],
    [intent, intent],
    [{ ...intent, entity: "tasks" }],
    [{ ...intent, id: "ow1a." + "a".repeat(64) }],
  ])
    assert.throws(() => catalogReplacementIntents(input));
  assert.throws(() =>
    recoverChanges(base(), [
      { kind: "catalogReplacement", ...intent, password: "never" },
    ]),
  );
});
test("archive and room estimate changes survive recovery while unknown live metadata remains intact", () => {
  const before = base();
  before.rooms = [
    {
      id: "r",
      name: "204",
      capacity: 30,
      capacityEstimated: true,
      unknown: { keep: true },
    },
  ];
  const after = structuredClone(before);
  after.groups[0].archivedAt = "2026-11-08T00:00:00.000Z";
  Object.assign(after.rooms[0], {
    note: "Owner note",
    building: "A",
    floor: "цоколь",
  });
  const fresh = structuredClone(before);
  fresh.rooms[0].unknown = { keep: "fresh" };
  const recovered = recoverChanges(fresh, draftChanges(before, after));
  assert.equal(recovered.data.rooms[0].capacityEstimated, true);
  assert.deepEqual(recovered.data.rooms[0].unknown, { keep: "fresh" });
  assert.equal(recovered.data.rooms[0].note, "Owner note");
  assert.equal(recovered.data.groups[0].archivedAt, after.groups[0].archivedAt);
});

test("restoring a replacement through the actual import model repoints newly arrived private rows without journaling them", () => {
  const owner = { id: "owner", role: "admin", name: "Owner" },
    before = structuredClone(fixture);
  const added = mutate(before, owner, "catalog.save", {
    entity: "groups",
    item: { id: "replacement", name: "New group", subgroups: ["А", "Б"] },
  }).data;
  const intent = {
    entity: "groups",
    id: "g-main",
    replacementId: "replacement",
  };
  const after = mutate(added, owner, "catalog.replace", intent).data;
  const changes = draftChanges(before, after, [intent]);
  const fresh = structuredClone(before);
  fresh.tasks.push({
    ...fresh.tasks[0],
    id: "fresh-private-row",
    description: "Only on fresh server",
  });
  const restored = recoverChanges(fresh, changes);
  const result = mutate(fresh, owner, "import", {
    data: restored.data,
    catalogReplacements: restored.catalogReplacements,
  }).data;
  assert.equal(result.tasks.length, 2);
  assert.equal(
    result.tasks.every((row) => row.groupId === "replacement"),
    true,
  );
  assert.equal(result.tasks[1].description, "Only on fresh server");
  assert.equal(JSON.stringify(changes).includes("fresh-private-row"), false);
  assert.equal(JSON.stringify(changes).includes("shared-task"), false);
});
