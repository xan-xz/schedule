import test from "node:test";
import assert from "node:assert/strict";
import { isGroupActive } from "../backend/group-state.mjs";
import { renderInitialChoice } from "../scripts/inline-release-snapshot.mjs";

test("canonical restoration overrides legacy archive flags while deletion always wins", () => {
  for (const legacy of [
    { archived: true },
    { archived_at: "2026-11-01" },
    { status: "archived" },
  ]) {
    assert.equal(isGroupActive(legacy), false);
    const restored = { ...legacy, archivedAt: null };
    const before = structuredClone(restored);
    assert.equal(isGroupActive(restored), true);
    assert.deepEqual(restored, before);
    for (const deleted of [
      { deleted: true },
      { deletedAt: "2026-11-01" },
      { deleted_at: "2026-11-01" },
      { status: "deleted" },
    ])
      assert.equal(isGroupActive({ ...restored, ...deleted }), false);
  }
  assert.equal(isGroupActive({ archivedAt: "2026-11-08T00:00:00Z" }), false);
  assert.equal(isGroupActive({ archivedAt: "" }), false);
  assert.equal(isGroupActive({ archivedAt: undefined, archived: true }), false);
  assert.equal(isGroupActive(undefined), true);
});

test("released native chooser includes restored groups and never resurrects deleted groups", () => {
  const row = (id, metadata = {}) => ({
    id,
    name: id,
    subgroups: ["А", "Б"],
    ...metadata,
  });
  const html = renderInitialChoice({
    data: {
      groups: [
        row("active"),
        row("archived", { archivedAt: "2026-11-08" }),
        row("restored", { archived: true, archivedAt: null }),
        row("deleted", { deleted: true, archivedAt: null }),
      ],
    },
  });
  assert.match(html, /value="active"/);
  assert.match(html, /value="restored"/);
  assert.doesNotMatch(html, /value="(?:archived|deleted)"/);
});
