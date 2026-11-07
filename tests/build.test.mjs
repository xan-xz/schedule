import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
  cp,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const builder = fileURLToPath(new URL("../scripts/build.mjs", import.meta.url));
const source = "1".repeat(40);
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "uniflow-build-test-"));
  t.after(async () => {
    if (
      dirname(resolve(directory)) !== resolve(tmpdir()) ||
      !basename(directory).startsWith("uniflow-build-test-")
    )
      throw Error("Unsafe cleanup");
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(join(directory, "beta/lib"), { recursive: true });
  await mkdir(join(directory, "backend"));
  const data = {
    "index.html": "<!doctype html><title>Archived legacy root</title>",
    "beta/index.html": "<!doctype html><title>Unified student app</title>",
    "beta/app.mjs": "export const release=1;\n",
    "beta/styles.css": "body {color:#221933;}\n",
    "beta/lib/client.mjs": "export const localFirst=true;\n",
    "beta/core.mjs": "export * from '../backend/core.mjs';\n",
    "backend/core.mjs": "export const shared=1;\n",
    "backend/admin.mjs": "throw Error('Do not publish server');\n",
    "beta/sw.js":
      "const VERSION = 'v2';\nconst sharedModel = '../backend/core.mjs';\n",
  };
  for (const [path, text] of Object.entries(data))
    await writeFile(join(directory, path), text);
  return directory;
}
function run(directory, channel = "production", base) {
  const args = [builder, "--channel", channel, "--source-ref", source];
  if (channel === "production") args.push("--data-decision-reviewed");
  if (base) args.push("--production-base", base);
  return spawnSync(process.execPath, args, {
    cwd: directory,
    encoding: "utf8",
  });
}
function build(directory, channel = "production", base) {
  const result = run(directory, channel, base);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
const version = (text) =>
  text.match(/const VERSION = '(v4-[a-f0-9]{16})';/)?.[1];
async function pinnedBase(directory) {
  build(directory);
  const base = join(directory, "production-base");
  await cp(join(directory, "dist"), base, { recursive: true });
  await writeFile(
    join(base, ".uniflow-production-base.json"),
    JSON.stringify({ format: "uniflow-production-v1", sourceRef: source }),
  );
  return base;
}
async function snapshot(root, prefix = "") {
  const result = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (
      !prefix &&
      (entry.name === "beta" || entry.name === ".uniflow-production-base.json")
    )
      continue;
    if (entry.isDirectory())
      Object.assign(result, await snapshot(join(root, entry.name), name + "/"));
    else
      result[name] = (await readFile(join(root, entry.name))).toString(
        "base64",
      );
  }
  return result;
}
test("production builds deterministic independently scoped workers and local models", async (t) => {
  const dir = await fixture(t);
  build(dir);
  const first = await readFile(join(dir, "dist/sw.js"), "utf8");
  assert.ok(version(first));
  build(dir);
  assert.equal(await readFile(join(dir, "dist/sw.js"), "utf8"), first);
  assert.equal(
    await readFile(join(dir, "dist/index.html"), "utf8"),
    await readFile(join(dir, "dist/beta/index.html"), "utf8"),
  );
  assert.match(
    await readFile(join(dir, "dist/core.mjs"), "utf8"),
    /\.\/model\.mjs/,
  );
  assert.match(
    await readFile(join(dir, "dist/beta/core.mjs"), "utf8"),
    /\.\/model\.mjs/,
  );
  assert.equal(
    await readFile(join(dir, "dist/backend/core.mjs"), "utf8"),
    await readFile(join(dir, "backend/core.mjs"), "utf8"),
  );
  await assert.rejects(access(join(dir, "dist/backend/admin.mjs")));
  assert.notEqual(
    version(first),
    version(await readFile(join(dir, "dist/beta/sw.js"), "utf8")),
  );
});
test("next beta preserves every production byte, even when beta app and shared model change", async (t) => {
  const dir = await fixture(t),
    base = await pinnedBase(dir),
    before = await snapshot(base),
    oldBeta = version(await readFile(join(base, "beta/sw.js"), "utf8"));
  await writeFile(join(dir, "beta/app.mjs"), "export const release=2;\n");
  await writeFile(join(dir, "backend/core.mjs"), "export const shared=2;\n");
  build(dir, "beta", base);
  assert.deepEqual(await snapshot(join(dir, "dist")), before);
  assert.notEqual(
    version(await readFile(join(dir, "dist/beta/sw.js"), "utf8")),
    oldBeta,
  );
  assert.equal(
    await readFile(join(dir, "dist/beta/model.mjs"), "utf8"),
    "export const shared=2;\n",
  );
  assert.equal(
    await readFile(join(dir, "dist/backend/core.mjs"), "utf8"),
    "export const shared=1;\n",
  );
  assert.doesNotMatch(
    await readFile(join(dir, "dist/index.html"), "utf8"),
    /Archived legacy/,
  );
});
test("beta refuses a missing or unverified base before replacing an existing artifact", async (t) => {
  const dir = await fixture(t);
  build(dir);
  const before = await readFile(join(dir, "dist/index.html"), "utf8");
  assert.notEqual(run(dir, "beta").status, 0);
  assert.equal(await readFile(join(dir, "dist/index.html"), "utf8"), before);
  const invalid = join(dir, "invalid");
  await mkdir(invalid);
  assert.notEqual(run(dir, "beta", invalid).status, 0);
  assert.equal(await readFile(join(dir, "dist/index.html"), "utf8"), before);
});
test("asset bytes change worker hash while original source worker is unchanged", async (t) => {
  const dir = await fixture(t);
  build(dir);
  const first = version(await readFile(join(dir, "dist/sw.js"), "utf8"));
  await writeFile(join(dir, "beta/styles.css"), "body {color:#7957d5;}\n");
  build(dir);
  assert.notEqual(
    version(await readFile(join(dir, "dist/sw.js"), "utf8")),
    first,
  );
  assert.match(
    await readFile(join(dir, "beta/sw.js"), "utf8"),
    /VERSION = 'v2'/,
  );
});
