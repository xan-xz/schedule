import { createRequire, syncBuiltinESMExports } from "node:module";
import { writeFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  writeFile,
  readFile,
  mkdir,
  rm,
  symlink,
  readdir,
} from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
  validateMetadata,
  safeTarEntries,
  extractProductionBase,
  verifyPublishedSource,
  selectLockedProductionRelease,
  verifyDownloadedRelease,
  verifyArchiveIdentity,
  validateArtifactRelease,
} from "../scripts/production-base.mjs";

const SOURCE = "a".repeat(40);
const BASELINE = "941852870a712807c020ec29752b19f1ce03aeee";
const artifactRelease = (sourceRef = SOURCE, change = {}) =>
  JSON.stringify({
    format: "uniflow-scope-v1",
    channel: "production",
    sourceRef,
    ...change,
  });
const metadata = (archive) => ({
  format: "uniflow-production-v1",
  sourceRef: SOURCE,
  archiveSha256: createHash("sha256").update(archive).digest("hex"),
});

test("automatic archive selection requires a published provider lock and a pinned source", () => {
  const locked = {
    draft: false,
    prerelease: false,
    immutable: true,
    tag_name: "uniflow-production-123",
    target_commitish: SOURCE,
    published_at: "2026-11-08T00:00:00Z",
  };
  const later = {
    ...locked,
    tag_name: "uniflow-production-124",
    published_at: "2026-11-08T01:00:00Z",
  };
  assert.equal(selectLockedProductionRelease([locked, later]), later);
  for (const change of [
    { immutable: false },
    { immutable: undefined },
    { draft: true },
    { prerelease: true },
    { target_commitish: "main" },
    { tag_name: "another-tag" },
    { published_at: "invalid" },
  ]) {
    const untrusted = { ...later, ...change };
    assert.equal(selectLockedProductionRelease([locked, untrusted]), locked);
    assert.throws(() => selectLockedProductionRelease([untrusted]));
  }
  assert.throws(() => selectLockedProductionRelease([]));
  assert.throws(() => selectLockedProductionRelease(null));
});

test("downloaded release requires both provider digests and the matching workflow, source and lock", () => {
  const archive = tar([
    { name: "index.html", content: "verified archive" },
    { name: "release.json", content: artifactRelease() },
  ]);
  const document = { ...metadata(archive), workflowRun: "123" };
  const bytes = Buffer.from(JSON.stringify(document));
  const remote = (manifestBytes = bytes) => ({
    draft: false,
    prerelease: false,
    immutable: true,
    tag_name: "uniflow-production-123",
    target_commitish: SOURCE,
    assets: [
      ["production-site.tar", archive],
      ["production.json", manifestBytes],
    ].map(([name, data]) => ({
      name,
      size: data.length,
      state: "uploaded",
      digest: "sha256:" + createHash("sha256").update(data).digest("hex"),
    })),
  });
  assert.deepEqual(verifyDownloadedRelease(remote(), archive, bytes), document);
  assert.throws(() =>
    verifyDownloadedRelease(remote(), Buffer.from("tampered"), bytes),
  );
  assert.throws(() =>
    verifyDownloadedRelease({ ...remote(), immutable: false }, archive, bytes),
  );
  assert.throws(() =>
    verifyDownloadedRelease({ ...remote(), draft: true }, archive, bytes),
  );
  assert.throws(() =>
    verifyDownloadedRelease(
      { ...remote(), draft: true, immutable: false },
      archive,
      bytes,
    ),
  );
  const otherRun = Buffer.from(
    JSON.stringify({ ...document, workflowRun: "124" }),
  );
  assert.throws(() =>
    verifyDownloadedRelease(remote(otherRun), archive, otherRun),
  );
  assert.throws(() =>
    verifyDownloadedRelease(
      { ...remote(), target_commitish: "b".repeat(40) },
      archive,
      bytes,
    ),
  );
  const wrongDigest = remote();
  wrongDigest.assets[1].digest = "sha256:" + "0".repeat(64);
  assert.throws(() => verifyDownloadedRelease(wrongDigest, archive, bytes));
});

function tar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content || "");
    const header = Buffer.alloc(512);
    const put = (text, start, length) =>
      header.write(String(text), start, length, "utf8");
    const octal = (value, width) =>
      value.toString(8).padStart(width - 1, "0") + "\0";
    put(entry.name, 0, 100);
    put(octal(0o755, 8), 100, 8);
    put(octal(0, 8), 108, 8);
    put(octal(0, 8), 116, 8);
    put(octal(content.length, 12), 124, 12);
    put(octal(0, 12), 136, 12);
    put("        ", 148, 8);
    put(entry.type || "0", 156, 1);
    put(entry.link || "", 157, 100);
    put("ustar\0", 257, 6);
    put("00", 263, 2);
    const sum = header.reduce((a, b) => a + b, 0);
    put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    blocks.push(
      header,
      content,
      Buffer.alloc((512 - (content.length % 512)) % 512),
    );
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
async function directory(t) {
  const path = await mkdtemp(resolve(process.cwd(), ".test-production-base-"));
  t.after(async () => {
    assert.ok(path.startsWith(process.cwd() + sep));
    await rm(path, { recursive: true, force: true });
  });
  return path;
}

test("production metadata requires immutable source and exact SHA-256 archive digest", () => {
  const bytes = Buffer.from("release");
  const value = metadata(bytes);
  assert.equal(validateMetadata(value, bytes), value);
  assert.throws(
    () => validateMetadata(value, Buffer.from("tamper")),
    /checksum/,
  );
  for (const sourceRef of [
    "main",
    "a".repeat(39),
    "A".repeat(40),
    "../main",
    null,
  ])
    assert.throws(() => validateMetadata({ ...value, sourceRef }, bytes));
  assert.throws(() => validateMetadata({ ...value, format: "other" }, bytes));
  assert.throws(() =>
    validateMetadata({ ...value, archiveSha256: "f".repeat(63) }, bytes),
  );
});

test("archive entry policy rejects traversal, Windows aliases, hidden configuration and dependencies", () => {
  assert.deepEqual(safeTarEntries("./\n./index.html\n./lib/time.mjs\n"), [
    "./",
    "./index.html",
    "./lib/time.mjs",
  ]);
  for (const name of [
    "../escape",
    "lib/../../escape",
    "C:/outside",
    "/outside",
    "lib\\time.mjs",
    ".git/config",
    "nested/.GIT/config",
    ".env",
    ".env.local",
    "nested/.Env.local",
    "node_modules/pkg",
    "nested/NODE_MODULES/pkg",
    ".git./config",
    "file:stream",
    "name ",
    "nul\0byte",
  ]) {
    assert.throws(
      () => safeTarEntries(`index.html\n${name}\n`),
      /Unsafe/,
      name,
    );
  }
  assert.throws(() => safeTarEntries(""), /Empty/);
  assert.throws(() => safeTarEntries("lib/time.mjs\n"), /root document/);
});

test("published source check fails closed on stale/deleted releases and unexpected responses", () => {
  const value = metadata(Buffer.from("release"));
  assert.equal(
    verifyPublishedSource(value, 200, {
      format: "uniflow-scope-v1",
      channel: "production",
      sourceRef: SOURCE,
    }),
    true,
  );
  for (const body of [
    {
      format: "uniflow-scope-v1",
      channel: "production",
      sourceRef: "b".repeat(40),
    },
    { format: "uniflow-scope-v1", channel: "staging", sourceRef: SOURCE },
    { format: "other", channel: "production", sourceRef: SOURCE },
    null,
  ])
    assert.throws(
      () => verifyPublishedSource(value, 200, body),
      /does not match/,
    );
  for (const status of [404, 403, 500, 0])
    assert.throws(() => verifyPublishedSource(value, status, null));
  assert.equal(
    verifyPublishedSource({ ...value, sourceRef: BASELINE }, 404, null),
    true,
  );
  assert.throws(() =>
    verifyPublishedSource({ ...value, sourceRef: BASELINE }, 500, null),
  );
  assert.throws(
    () => verifyPublishedSource({ sourceRef: BASELINE }, 404, null),
    /Invalid/,
  );
});

test("valid production archive replaces only its checked workspace child and writes trust marker", async (t) => {
  const path = await directory(t),
    target = resolve(path, "base"),
    archivePath = resolve(path, "site.tar");
  const bytes = tar([
    { name: "index.html", content: "current production" },
    { name: "release.json", content: artifactRelease() },
    { name: "lib/", type: "5" },
    { name: "lib/app.mjs", content: "export const version=1" },
  ]);
  await writeFile(archivePath, bytes);
  await mkdir(target);
  await writeFile(resolve(target, "old.txt"), "old");
  await writeFile(resolve(path, "sibling.txt"), "keep");
  const value = metadata(bytes);
  await extractProductionBase(archivePath, value, target);
  assert.equal(
    await readFile(resolve(target, "index.html"), "utf8"),
    "current production",
  );
  assert.equal(
    await readFile(resolve(target, "lib/app.mjs"), "utf8"),
    "export const version=1",
  );
  assert.equal(await readFile(resolve(path, "sibling.txt"), "utf8"), "keep");
  assert.deepEqual(
    JSON.parse(
      await readFile(resolve(target, ".uniflow-production-base.json"), "utf8"),
    ),
    value,
  );
  assert.equal((await readdir(target)).includes("old.txt"), false);
  await assert.rejects(
    extractProductionBase(archivePath, value, process.cwd()),
    /inside this workspace/,
  );
  await assert.rejects(
    extractProductionBase(
      archivePath,
      value,
      resolve(process.cwd(), "../outside"),
    ),
    /inside this workspace/,
  );
});

test("tar symlinks and hardlinks are rejected before an existing target is removed", async (t) => {
  const path = await directory(t),
    target = resolve(path, "base");
  await mkdir(target);
  await writeFile(resolve(target, "sentinel"), "keep");
  for (const type of ["2", "1"]) {
    const bytes = tar([
      { name: "index.html", content: "root" },
      { name: "linked", type, link: "../../outside" },
    ]);
    const archivePath = resolve(path, `link-${type}.tar`);
    await writeFile(archivePath, bytes);
    await assert.rejects(
      extractProductionBase(archivePath, metadata(bytes), target),
      /links\/special files/,
    );
    assert.equal(await readFile(resolve(target, "sentinel"), "utf8"), "keep");
  }
});

test("a junction/symlink in the destination path cannot redirect extraction or deletion", async (t) => {
  const path = await directory(t),
    actual = resolve(path, "actual"),
    link = resolve(path, "link");
  await mkdir(actual);
  await writeFile(resolve(actual, "sentinel"), "keep");
  await symlink(
    actual,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
  const bytes = tar([
      { name: "index.html", content: "new" },
      { name: "release.json", content: artifactRelease() },
    ]),
    archivePath = resolve(path, "site.tar");
  await writeFile(archivePath, bytes);
  await assert.rejects(
    extractProductionBase(
      archivePath,
      metadata(bytes),
      resolve(link, "nested"),
    ),
    /symbolic links/,
  );
  await assert.rejects(
    extractProductionBase(archivePath, metadata(bytes), link),
    /symbolic links/,
  );
  assert.equal(await readFile(resolve(actual, "sentinel"), "utf8"), "keep");
  assert.equal((await readdir(actual)).includes("nested"), false);
});

test("artifact identity requires exact format, production channel and pinned source", () => {
  assert.deepEqual(
    validateArtifactRelease(JSON.parse(artifactRelease()), SOURCE),
    JSON.parse(artifactRelease()),
  );
  for (const value of [
    null,
    {},
    JSON.parse(artifactRelease("b".repeat(40))),
    JSON.parse(artifactRelease(SOURCE, { format: "another" })),
    JSON.parse(artifactRelease(SOURCE, { channel: "staging" })),
  ])
    assert.throws(
      () => validateArtifactRelease(value, SOURCE),
      /Artifact release.json/,
    );
});
test("a valid outer hash cannot launder missing, corrupt or mismatched inner identity or replace the target", async (t) => {
  const path = await directory(t),
    target = resolve(path, "base");
  await mkdir(target);
  await writeFile(resolve(target, "sentinel"), "keep");
  const documents = [
    null,
    "broken-json",
    artifactRelease("b".repeat(40)),
    artifactRelease(SOURCE, { format: "other" }),
    artifactRelease(SOURCE, { channel: "staging" }),
    JSON.stringify({
      ...JSON.parse(artifactRelease()),
      padding: "x".repeat(8192),
    }),
  ];
  for (let i = 0; i < documents.length; i++) {
    const entries = [{ name: "index.html", content: "old code" }];
    if (documents[i] !== null)
      entries.push({ name: "release.json", content: documents[i] });
    const bytes = tar(entries),
      manifest = metadata(bytes),
      archivePath = resolve(path, "bad-" + i + ".tar");
    await writeFile(archivePath, bytes);
    assert.throws(() => verifyArchiveIdentity(bytes, manifest));
    await assert.rejects(extractProductionBase(archivePath, manifest, target));
    assert.equal(await readFile(resolve(target, "sentinel"), "utf8"), "keep");
    assert.deepEqual(await readdir(target), ["sentinel"]);
  }
});
test("duplicate or case-aliased root release identities are rejected", () => {
  for (const alias of ["release.json", "././release.json", "RELEASE.JSON"]) {
    const bytes = tar([
      { name: "index.html", content: "root" },
      { name: "release.json", content: artifactRelease() },
      { name: alias, content: artifactRelease("b".repeat(40)) },
    ]);
    assert.throws(
      () => verifyArchiveIdentity(bytes, metadata(bytes)),
      /one canonical root/,
    );
  }
  const bytes = tar([
    { name: "index.html", content: "root" },
    { name: "./release.json", content: artifactRelease() },
  ]);
  assert.equal(verifyArchiveIdentity(bytes, metadata(bytes)).sourceRef, SOURCE);
});

test("extraction readback refuses a changed inner identity before replacing the old target", async (t) => {
  const path = await directory(t),
    target = resolve(path, "base"),
    archivePath = resolve(path, "site.tar");
  await mkdir(target);
  await writeFile(resolve(target, "sentinel"), "keep");
  const bytes = tar([
    { name: "index.html", content: "matching archive" },
    { name: "release.json", content: artifactRelease() },
  ]);
  await writeFile(archivePath, bytes);
  const childProcess = createRequire(import.meta.url)("node:child_process"),
    native = childProcess.execFileSync;
  let corruptions = 0;
  t.mock.method(childProcess, "execFileSync", (command, args, options) => {
    const result = native(command, args, options);
    if (command === "tar" && args.includes("-xf")) {
      corruptions++;
      const staging = args[args.indexOf("-C") + 1];
      writeFileSync(
        resolve(staging, "release.json"),
        artifactRelease("b".repeat(40)),
      );
    }
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(
    extractProductionBase(archivePath, metadata(bytes), target),
    /Artifact release.json/,
  );
  assert.equal(corruptions, 1);
  assert.equal(await readFile(resolve(target, "sentinel"), "utf8"), "keep");
  assert.deepEqual(await readdir(target), ["sentinel"]);
});
