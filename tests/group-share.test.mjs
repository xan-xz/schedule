import test from "node:test";
import assert from "node:assert/strict";
import { groupShareUrl } from "../app/manage/group-share.mjs";

const base =
  "https://xan-xz.github.io/schedule/?demo=admin#access_token=secret";
const group = { id: "g-main", name: "Группа", subgroups: ["А", "Б"] };

test("group invitation uses stable identity and no owner role, credential, date or inherited query", () => {
  const url = new URL(groupShareUrl(group, "Б", base));
  assert.equal(url.origin + url.pathname, "https://xan-xz.github.io/schedule/");
  assert.deepEqual(
    [...url.searchParams],
    [
      ["g", "g-main"],
      ["subgroup", "Б"],
    ],
  );
  assert.equal(url.hash, "");
  assert.equal(
    new URL(groupShareUrl(group, "all", base)).searchParams.get("subgroup"),
    "all",
  );
});

test("literal identity text is encoded as one query value, never markup or a second parameter", () => {
  const id = "группа&role=admin#</script>";
  const url = new URL(groupShareUrl({ ...group, id }, "А", base));
  assert.equal(url.searchParams.get("g"), id);
  assert.equal(url.searchParams.get("role"), null);
  assert.equal(url.hash, "");
});

test("archived/deleted groups, foreign subgroup and unsafe origins cannot create misleading invitations", () => {
  assert.throws(() =>
    groupShareUrl({ ...group, archivedAt: "2026-11-08" }, "all", base),
  );
  assert.throws(() =>
    groupShareUrl({ ...group, deleted: true, archivedAt: null }, "all", base),
  );
  assert.throws(() => groupShareUrl(group, "not-a-subgroup", base));
  for (const unsafe of [
    "javascript:alert(1)",
    "file:///C:/secret",
    "https://user:password@example.com/",
    "http://example.com/",
  ])
    assert.throws(() => groupShareUrl(group, "all", unsafe));
  assert.ok(groupShareUrl(group, "all", "http://127.0.0.1:4221/schedule/"));
});
