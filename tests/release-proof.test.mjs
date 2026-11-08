import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyArchiveIdentity } from "../scripts/production-base.mjs";
const source = "a".repeat(40),
  other = "b".repeat(40);
const script = (name) =>
  fileURLToPath(new URL("../scripts/" + name + ".mjs", import.meta.url));
const identity = (ref = source, change = {}) => ({
  format: "uniflow-scope-v1",
  channel: "production",
  sourceRef: ref,
  ...change,
});
async function fixture(t) {
  const path = await mkdtemp(resolve(process.cwd(), ".test-release-proof-"));
  t.after(async () => {
    assert.ok(path.startsWith(process.cwd() + sep));
    await rm(path, { recursive: true, force: true });
  });
  const marker = resolve(path, "github-invoked"),
    guard = resolve(path, "deny-github.mjs");
  // A regression may attempt a CLI lookup, but can never reach a real gh process.
  await writeFile(
    guard,
    `import {createRequire,syncBuiltinESMExports} from "node:module";import{writeFileSync}from"node:fs";const cp=createRequire(import.meta.url)("node:child_process");for(const method of ["spawnSync","execFileSync"]){const native=cp[method];cp[method]=function(command,...args){if(command==="gh"){writeFileSync(${JSON.stringify(marker)},"attempted");throw Error("NETWORK_DISABLED_FIXTURE");}return native(command,...args);};}syncBuiltinESMExports();`,
  );
  const run = (name, args = []) =>
    spawnSync(
      process.execPath,
      ["--import", pathToFileURL(guard).href, script(name), ...args],
      {
        cwd: path,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_SHA: source,
          GITHUB_RUN_ID: "123",
          GITHUB_REPOSITORY: "fixture/repository",
          GH_TOKEN: "",
          GITHUB_TOKEN: "",
        },
      },
    );
  return { path, marker, run };
}
async function archive(path, document) {
  const contents = resolve(path, "contents");
  await mkdir(contents, { recursive: true });
  await writeFile(resolve(contents, "index.html"), "public shell");
  if (document !== null)
    await writeFile(
      resolve(contents, "release.json"),
      JSON.stringify(document),
    );
  const archivePath = resolve(path, "production-site.tar");
  execFileSync("tar", ["-cf", archivePath, "-C", contents, "."]);
  const bytes = await readFile(archivePath),
    metadata = {
      format: "uniflow-production-v1",
      sourceRef: source,
      workflowRun: "123",
      archiveSha256: createHash("sha256").update(bytes).digest("hex"),
    };
  await writeFile(resolve(path, "production.json"), JSON.stringify(metadata));
  return { bytes, metadata };
}
test("recording rejects stale or malformed inner identity before any GitHub read or write", async (t) => {
  for (const document of [
    identity(other),
    identity(source, { channel: "staging" }),
    identity(source, { format: "other" }),
    null,
  ]) {
    const f = await fixture(t);
    await archive(f.path, document);
    const result = f.run("record-production", ["--dir", f.path]);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Artifact release.json|canonical root release.json/,
    );
    await assert.rejects(readFile(f.marker));
  }
});
test("archiving a stale dist refuses before overwriting an earlier reviewed upload", async (t) => {
  const f = await fixture(t);
  await mkdir(resolve(f.path, "dist"));
  await writeFile(
    resolve(f.path, "dist/release.json"),
    JSON.stringify(identity(other)),
  );
  const output = resolve(f.path, ".release/upload");
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, "production-site.tar"), "reviewed archive");
  await writeFile(resolve(output, "production.json"), "reviewed metadata");
  const result = f.run("archive-production");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Artifact release.json/);
  assert.equal(
    await readFile(resolve(output, "production-site.tar"), "utf8"),
    "reviewed archive",
  );
  assert.equal(
    await readFile(resolve(output, "production.json"), "utf8"),
    "reviewed metadata",
  );
  await assert.rejects(readFile(f.marker));
});
test("a matching built source produces an archive with the same inner and outer identity", async (t) => {
  const f = await fixture(t);
  await mkdir(resolve(f.path, "dist"));
  await writeFile(resolve(f.path, "dist/index.html"), "checked shell");
  await writeFile(
    resolve(f.path, "dist/release.json"),
    JSON.stringify(identity()),
  );
  const result = f.run("archive-production");
  assert.equal(result.status, 0, result.stderr);
  const output = resolve(f.path, ".release/upload"),
    bytes = await readFile(resolve(output, "production-site.tar")),
    metadata = JSON.parse(
      await readFile(resolve(output, "production.json"), "utf8"),
    );
  assert.equal(verifyArchiveIdentity(bytes, metadata).sourceRef, source);
  assert.equal(metadata.workflowRun, "123");
  await assert.rejects(readFile(f.marker));
});
