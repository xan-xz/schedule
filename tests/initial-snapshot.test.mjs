import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  projectInitialSnapshot,
  readInitialSnapshot,
  INITIAL_SNAPSHOT_FORMAT,
  MAX_INITIAL_SNAPSHOT_BYTES,
} from "../app/lib/initial-snapshot.mjs";
import {
  inlineReleaseSnapshot,
  serializeInertSnapshot,
  MAX_INITIAL_DOCUMENT_GZIP,
} from "../scripts/inline-release-snapshot.mjs";
import { releaseSnapshot } from "../app/lib/client.mjs";
import { lessonsForDate } from "../app/lib/time.mjs";
import { visible } from "../backend/core.mjs";
const source = JSON.parse(
  await readFile(new URL("../app/bootstrap.json", import.meta.url), "utf8"),
);
const documentFor = (text, type = "application/json") => ({
  getElementById: () => ({ type, textContent: text }),
});
const dataBlock = (html) =>
  html.match(
    /<script type="application\/json" id="uniflow-public-snapshot">([\s\S]*?)<\/script>/,
  )?.[1];
async function fixture(t, snapshot = source) {
  const dir = await mkdtemp(join(tmpdir(), "uniflow-initial-snapshot-"));
  t.after(async () => {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith("uniflow-initial-snapshot-"));
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(
    join(dir, "index.html"),
    '<!doctype html><head><meta http-equiv="Content-Security-Policy" content="script-src \'self\'; style-src \'self\';"><script src="./owner-route.js"></script><link rel="preload" href="./bootstrap.json" as="fetch"><script type="module">console.log("trusted");</script></head><main id="main"></main>',
  );
  await writeFile(join(dir, "bootstrap.json"), JSON.stringify(snapshot));
  return dir;
}
test("public inline projection preserves all released groups, lessons and timetable meaning without privileged fields", () => {
  const candidate = structuredClone(source);
  candidate.token = "private-top-level";
  candidate.users = [{ email: "private-user" }];
  candidate.versions = [{ data: "private-history" }];
  candidate.data.accounts = [{ password_hash: "private-hash" }];
  candidate.data.attendance = [{ studentId: "private-student" }];
  candidate.data.requests = [{ reason: "private-request" }];
  candidate.data.history = [{ actor: "private-actor" }];
  candidate.data.groups[0].token = "private-group-token";
  candidate.data.teachers[0].password = "private-teacher-password";
  const projected = projectInitialSnapshot(candidate);
  assert.equal(projected.data.groups.length, 19);
  assert.equal(projected.data.lessons.length, 524);
  assert.deepEqual(projected.data.groups, source.data.groups);
  assert.deepEqual(projected.data.lessons, source.data.lessons);
  for (const date of ["2026-11-06", "2026-11-07", "2026-11-09"])
    assert.deepEqual(
      lessonsForDate(projected.data, date, {
        groupId: "g-main",
        subgroup: "А",
      }),
      lessonsForDate(source.data, date, { groupId: "g-main", subgroup: "А" }),
    );
  assert.doesNotMatch(
    JSON.stringify(projected),
    /private-|"accounts"|"users"|"versions"|"attendance"|"requests"|"history"|"token"|"password"/,
  );
});

function audienceFixture() {
  const input = structuredClone(source),
    group = input.data.groups[0].id,
    teacher = input.data.teachers[0]?.id || "teacher";
  const row = (id, roles, extra = {}) => ({
    id,
    title: id,
    body: id + "_BODY",
    roles,
    createdAt: input.updatedAt,
    ...extra,
  });
  input.data.announcements = [
    row("PUBLIC_GLOBAL", ["student"]),
    row("PUBLIC_GROUP", ["student", "admin"], { groupId: group }),
    row("PUBLIC_GROUP_AND_TEACHER", ["student"], {
      groupId: group,
      teacherId: teacher,
    }),
    row("PRIVATE_ADMIN", ["admin"], { groupId: group }),
    row("PRIVATE_TEACHER", ["teacher"]),
    row("PRIVATE_TEACHER_ONLY", ["student"], { teacherId: teacher }),
    row("PRIVATE_UNKNOWN_GROUP", ["student"], { groupId: "missing-group" }),
    row("PRIVATE_EMPTY_AUDIENCE", []),
  ];
  return input;
}

test("public audience projection exactly matches the union of actual guest visibility across valid groups", () => {
  const input = audienceFixture();
  const expected = new Set(
    input.data.groups.flatMap((group) =>
      visible(input.data, {
        id: "guest",
        role: "guest",
        groupId: group.id,
        subgroup: "all",
      }).announcements.map((item) => item.id),
    ),
  );
  const result = projectInitialSnapshot(input);
  assert.deepEqual(
    new Set(result.data.announcements.map((item) => item.id)),
    expected,
  );
  assert.deepEqual(
    result.data.announcements.map((item) => item.id),
    ["PUBLIC_GLOBAL", "PUBLIC_GROUP", "PUBLIC_GROUP_AND_TEACHER"],
  );
  assert.doesNotMatch(serializeInertSnapshot(input), /PRIVATE_/);
  input.data.announcements.push({
    id: "PRIVATE_MISSING_AUDIENCE",
    title: "Missing",
    body: "PRIVATE_MISSING_BODY",
  });
  assert.doesNotMatch(serializeInertSnapshot(input), /PRIVATE_/);
  const defensive = readInitialSnapshot(
    documentFor(
      JSON.stringify({ format: INITIAL_SNAPSHOT_FORMAT, snapshot: input }),
    ),
  );
  assert.deepEqual(
    defensive.data.announcements.map((item) => item.id),
    result.data.announcements.map((item) => item.id),
  );
});

test("private announcement bodies never enter either embedded HTML or the rewritten external public snapshot", async (t) => {
  const input = audienceFixture(),
    dir = await fixture(t, input);
  const result = await inlineReleaseSnapshot(dir);
  assert.equal(result.embedded, true);
  const html = await readFile(join(dir, "index.html"), "utf8"),
    external = await readFile(join(dir, "bootstrap.json"), "utf8");
  assert.doesNotMatch(html, /PRIVATE_/);
  assert.doesNotMatch(external, /PRIVATE_/);
  for (const value of [html, external])
    assert.match(value, /PUBLIC_GROUP_AND_TEACHER_BODY/);
  assert.equal(
    JSON.parse(external).data.groups.length,
    input.data.groups.length,
  );
  assert.equal(
    JSON.parse(external).data.lessons.length,
    input.data.lessons.length,
  );
});
test("HTML closing tags, entity-looking text and Unicode separators round-trip as inert exact text", async (t) => {
  const candidate = structuredClone(source);
  const text =
    '</script><img src=x onerror="globalThis.injected=1">&lt;&#x3c;\u2028\u2029';
  candidate.data.groups[0].name = text;
  const dir = await fixture(t, candidate);
  const result = await inlineReleaseSnapshot(dir);
  const html = await readFile(join(dir, "index.html"), "utf8");
  assert.equal(result.embedded, true);
  assert.equal((html.match(/<script\b/g) || []).length, 3);
  assert.doesNotMatch(dataBlock(html), /[<>&\u2028\u2029]/);
  assert.equal(
    readInitialSnapshot(documentFor(dataBlock(html))).data.groups[0].name,
    text,
  );
  assert.doesNotMatch(html, /rel="preload"/);
  assert.equal(result.initialChoiceRendered, true);
  assert.match(html, /data-initial-choice/);
  assert.doesNotMatch(html, /<img/);
  const routeCode = html.match(
    /<script data-owner-route>([\s\S]*?)<\/script>/,
  )[1];
  const routeHash = createHash("sha256").update(routeCode).digest("base64");
  assert.ok(html.includes("'sha256-" + routeHash + "'"));
  assert.ok(html.indexOf("data-owner-route") < html.indexOf('type="module"'));
  assert.doesNotMatch(html, /src="\.\/owner-route\.js"/);
  assert.equal(
    JSON.parse(await readFile(join(dir, "bootstrap.json"), "utf8")).data
      .groups[0].name,
    text,
  );
});
test("initial read is defensive and a valid inline snapshot bypasses only the redundant release fetch", async () => {
  for (const value of [
    "{bad",
    "{}",
    JSON.stringify({
      format: INITIAL_SNAPSHOT_FORMAT,
      snapshot: { ...source, revision: 0 },
    }),
    "x".repeat(MAX_INITIAL_SNAPSHOT_BYTES + 1),
  ])
    assert.equal(readInitialSnapshot(documentFor(value)), null);
  assert.equal(
    readInitialSnapshot(
      documentFor(serializeInertSnapshot(source), "text/javascript"),
    ),
    null,
  );
  const oldDocument = globalThis.document,
    oldFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.document = documentFor(serializeInertSnapshot(source));
    globalThis.fetch = async () => {
      calls++;
      throw Error("Must not fetch the embedded release");
    };
    const result = await releaseSnapshot({ groupId: "g-main", subgroup: "А" });
    assert.equal(calls, 0);
    assert.equal(result.data.lessons.length, 524);
    assert.equal(result.source, "release-snapshot");
    assert.deepEqual(result.data.history, []);
  } finally {
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
    globalThis.fetch = oldFetch;
  }
});
test("100 groups and 4000 lessons are never truncated; large data uses a complete external fallback within document budget", async (t) => {
  const candidate = structuredClone(source);
  candidate.data.groups = Array.from({ length: 100 }, (_, index) => ({
    ...source.data.groups[index % source.data.groups.length],
    id: "scale-group-" + index,
    name: "Scale group " + index,
  }));
  candidate.data.lessons = Array.from({ length: 4000 }, (_, index) => ({
    ...candidate.data.lessons[index % 524],
    id: "scale-" + index,
    groupId: "scale-group-" + Math.floor(index / 40),
  }));
  const dir = await fixture(t, candidate);
  const result = await inlineReleaseSnapshot(dir);
  const html = await readFile(join(dir, "index.html"), "utf8");
  const fallback = JSON.parse(
    await readFile(join(dir, "bootstrap.json"), "utf8"),
  );
  assert.equal(fallback.data.groups.length, 100);
  assert.equal(fallback.data.lessons.length, 4000);
  assert.equal((html.match(/data-subgroups=/g) || []).length, 100);
  assert.ok(gzipSync(html).length <= MAX_INITIAL_DOCUMENT_GZIP);
  if (result.embedded)
    assert.equal(
      readInitialSnapshot(documentFor(dataBlock(html))).data.lessons.length,
      4000,
    );
  else {
    assert.equal(result.externalSnapshotComplete, true);
    assert.equal(dataBlock(html), undefined);
  }
  // Deliberately incompressible public copy forces the bounded fallback path.
  candidate.data.announcements = [
    ...audienceFixture().data.announcements.filter((item) =>
      item.id.startsWith("PRIVATE_"),
    ),
    {
      id: "large",
      title: "Public",
      body: Array.from({ length: 1000 }, (_, i) => String(i * 48271)).join(""),
      roles: ["student"],
      createdAt: source.updatedAt,
    },
  ];
  candidate.data.lessons = Array.from({ length: 8000 }, (_, index) => ({
    ...candidate.data.lessons[index % 4000],
    id: "wide-" + index,
  }));
  const large = await fixture(t, candidate);
  const fallbackResult = await inlineReleaseSnapshot(large);
  assert.equal(fallbackResult.embedded, false);
  assert.equal(fallbackResult.initialChoiceRendered, true);
  const fallbackHtml = await readFile(join(large, "index.html"), "utf8");
  assert.equal(dataBlock(fallbackHtml), undefined);
  assert.doesNotMatch(fallbackHtml, /PRIVATE_/);
  assert.doesNotMatch(
    await readFile(join(large, "bootstrap.json"), "utf8"),
    /PRIVATE_/,
  );
  assert.match(fallbackHtml, /data-initial-choice/);
  assert.match(fallbackHtml, /data-owner-route/);
  assert.match(fallbackHtml, /rel="preload"/);
  assert.equal(
    fallbackResult.initialDocumentGzip,
    gzipSync(fallbackHtml).length,
  );
  assert.equal(
    JSON.parse(await readFile(join(large, "bootstrap.json"), "utf8")).data
      .lessons.length,
    8000,
  );
});

test("malformed inert data uses the original project-scoped external fallback and scope filtering", async () => {
  const previous = {
    document: globalThis.document,
    location: globalThis.location,
    fetch: globalThis.fetch,
  };
  const calls = [];
  try {
    globalThis.document = documentFor("{bad");
    globalThis.location = { href: "https://example.test/schedule/?g=g-main" };
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return {
        ok: true,
        json: async () => ({
          ...source,
          token: "private-fallback",
          data: {
            ...source.data,
            accounts: [{ password: "private-fallback" }],
          },
        }),
      };
    };
    const snapshot = await releaseSnapshot({
      groupId: "g-main",
      subgroup: "Б",
    });
    assert.deepEqual(calls, ["https://example.test/schedule/bootstrap.json"]);
    assert.equal(snapshot.data.lessons.length, 524);
    assert.doesNotMatch(
      JSON.stringify(snapshot),
      /private-fallback|"accounts"|"token"/,
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});
