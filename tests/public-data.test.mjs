import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import {
  projectPublicData,
  projectPublicCatalogs,
} from "../backend/public-data.mjs";
import { projectInitialSnapshot } from "../app/lib/initial-snapshot.mjs";
import {
  publicState,
  getSnapshot,
  saveSnapshot,
  snapshotKey,
} from "../app/lib/client.mjs";
import * as storage from "../app/lib/storage.mjs";
import { inlineReleaseSnapshot } from "../scripts/inline-release-snapshot.mjs";
const released = JSON.parse(
  await readFile(new URL("../app/bootstrap.json", import.meta.url), "utf8"),
);
const privateMarker = "SYNTHETIC_OWNER_ONLY_CATALOG_SENTINEL";
delete globalThis.localStorage;
function fixture() {
  const data = structuredClone(released.data);
  for (const kind of ["groups", "subjects", "teachers", "rooms"])
    Object.assign(data[kind][0], {
      ownerOnly: privateMarker,
      futurePrivate: { contact: privateMarker },
    });
  Object.assign(data.groups[0], { deleted: false, archivedAt: null });
  Object.assign(data.subjects[0], { shortName: "Алг" });
  Object.assign(data.rooms[0], {
    note: privateMarker,
    building: "Корпус <A&B>",
    floor: "2",
  });
  data.ownerOnly = privateMarker;
  data.source = { note: privateMarker };
  data.sourceWarnings = [{ message: privateMarker }];
  data.sourceConflictPairs = [privateMarker];
  data.accounts = [{ private: privateMarker }];
  data.requests = [{ reason: privateMarker }];
  data.history = [{ summary: privateMarker }];
  data.attendance = [{ studentId: "guest", reason: privateMarker }];
  data.tasks = [
    {
      id: "public-task",
      groupId: data.groups[0].id,
      subgroup: "А",
      title: "Public task",
      due: "2026-11-09",
      dueTime: "10:05",
      private: privateMarker,
    },
  ];
  data.announcements = [
    {
      id: "public-message",
      title: "Public",
      body: "Group message",
      roles: ["student"],
      private: privateMarker,
    },
  ];
  return data;
}
const assertClosed = (data) => {
  assert.doesNotMatch(JSON.stringify(data), new RegExp(privateMarker));
  assert.equal(data.groups[0].deleted, false);
  assert.equal(data.groups[0].archivedAt, null);
  assert.equal(data.subjects[0].shortName, "Алг");
  assert.equal(data.rooms[0].building, "Корпус <A&B>");
  assert.equal(data.rooms[0].floor, "2");
  assert.equal(Object.hasOwn(data.rooms[0], "note"), false);
  for (const key of ["requests", "attendance", "history"])
    assert.deepEqual(data[key], []);
};

test("one closed public DTO strips unknown root/catalog metadata and owner-only notes without changing source records", () => {
  const input = fixture(),
    original = structuredClone(input);
  const result = projectPublicData(input);
  assertClosed(result);
  assert.deepEqual(input, original);
  assert.deepEqual(result.lessons, released.data.lessons);
  result.groups[0].subgroups.push("new");
  assert.deepEqual(input.groups[0].subgroups, original.groups[0].subgroups);
  assertClosed(projectInitialSnapshot({ ...released, data: input }).data);
});

test("catalog-only projection has no private-collection side effects and bounded new public labels", () => {
  const data = fixture(),
    original = structuredClone(data);
  const catalogs = projectPublicCatalogs(data);
  assert.deepEqual(Object.keys(catalogs), [
    "groups",
    "subjects",
    "teachers",
    "rooms",
  ]);
  assert.doesNotMatch(JSON.stringify(catalogs), new RegExp(privateMarker));
  assert.deepEqual(data, original);
  for (const [kind, key, value] of [
    ["rooms", "building", "x".repeat(121)],
    ["rooms", "floor", "x".repeat(41)],
    ["rooms", "floor", 2],
    ["subjects", "shortName", "x".repeat(61)],
  ]) {
    const invalid = fixture();
    invalid[kind][0][key] = value;
    assert.equal(
      Object.hasOwn(projectPublicCatalogs(invalid)[kind][0], key),
      false,
    );
  }
  const invalid = fixture();
  invalid.groups[0].deleted = "yes";
  assert.throws(() => projectPublicCatalogs(invalid), /Invalid public/);
});

test("public HTTP client, saved snapshots and pre-existing raw cache rows all reapply the same field boundary", async (t) => {
  const settings = { groupId: released.data.groups[0].id, subgroup: "А" };
  await storage.clear();
  t.after(() => storage.clear());
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => ({
      data: fixture(),
      revision: released.revision,
      user: { role: "guest", subgroup: "А" },
      capabilities: { allSubgroupTasks: true },
    }),
  }));
  const fetched = await publicState(settings.groupId, settings.subgroup);
  assertClosed(fetched.data);
  assert.equal(fetched.data.tasks[0].dueTime, "10:05");
  await saveSnapshot(settings, {
    ...released,
    data: fixture(),
    token: privateMarker,
  });
  const raw = await storage.get(snapshotKey(settings));
  assertClosed(raw.data);
  assert.doesNotMatch(JSON.stringify(raw), new RegExp(privateMarker));
  // A record written by an older release is projected again when it is read.
  await storage.set(snapshotKey(settings), { ...released, data: fixture() });
  assertClosed((await getSnapshot(settings)).data);
  assertClosed((await storage.get(snapshotKey(settings))).data);
  assert.equal(
    (await storage.get(snapshotKey(settings))).updatedAt,
    released.updatedAt,
  );
  const corrupt = fixture();
  corrupt.rooms[0].name = { private: privateMarker };
  await storage.set(snapshotKey(settings), { ...released, data: corrupt });
  assert.equal(await getSnapshot(settings), null);
  assert.equal(await storage.get(snapshotKey(settings)), null);
  await saveSnapshot(settings, {
    data: fixture(),
    source: { private: privateMarker },
    revision: { private: privateMarker },
    updatedAt: { private: privateMarker },
  });
  const metadata = await storage.get(snapshotKey(settings));
  assert.doesNotMatch(JSON.stringify(metadata), new RegExp(privateMarker));
  for (const key of ["source", "revision", "updatedAt"])
    assert.equal(metadata[key], undefined);
});

test("inert HTML and rewritten external bootstrap exclude catalog notes, including complete fallback artifacts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uniflow-public-data-test-"));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("uniflow-public-data-test-"));
    await rm(directory, { recursive: true, force: true });
  });
  for (const count of [released.data.lessons.length, 8000]) {
    const target = join(directory, String(count));
    await mkdir(target);
    const input = { ...released, data: fixture() };
    if (count === 8000)
      input.data.lessons = Array.from({ length: count }, (_, index) => ({
        ...input.data.lessons[index % input.data.lessons.length],
        id: "large-" + index,
      }));
    await writeFile(
      join(target, "index.html"),
      '<!doctype html><head><meta http-equiv="Content-Security-Policy" content="script-src \'self\'; style-src \'self\';"><link rel="preload" href="./bootstrap.json" as="fetch"><script type="module">void 0;</script></head><main id="main"></main>',
    );
    await writeFile(join(target, "bootstrap.json"), JSON.stringify(input));
    assert.equal(
      (await inlineReleaseSnapshot(target)).embedded,
      count !== 8000,
    );
    for (const file of ["index.html", "bootstrap.json"])
      assert.doesNotMatch(
        await readFile(join(target, file), "utf8"),
        new RegExp(privateMarker),
      );
    assertClosed(
      JSON.parse(await readFile(join(target, "bootstrap.json"), "utf8")).data,
    );
    assert.equal(
      JSON.parse(await readFile(join(target, "bootstrap.json"), "utf8")).data
        .lessons.length,
      count,
    );
  }
});
