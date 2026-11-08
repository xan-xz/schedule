import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
  symlink,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const builder = fileURLToPath(new URL("../scripts/build.mjs", import.meta.url));
const manifest = JSON.parse(
  await readFile(new URL("../compatibility.json", import.meta.url), "utf8"),
);
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
  await mkdir(join(directory, "app/lib"), { recursive: true });
  await mkdir(join(directory, "backend"));
  for (const [path, text] of Object.entries({
    "app/index.html": "<!doctype html><title>UniFlow</title>",
    "app/app.mjs": "export const release=1;\n",
    "app/styles.css": "body{color:#221933;}\n",
    "app/lib/client.mjs": "export const publicOnly=true;\n",
    "app/core.mjs": "export * from '../backend/core.mjs';\n",
    "app/redirect.mjs": "export const redirectOnly=true;\n",
    "app/retirement-worker.js": "self.addEventListener('fetch',()=>{});\n",
    "backend/core.mjs": "export const shared=1;\n",
    "backend/appearance-policy.mjs": "export const policyVersion=1;\n",
    "backend/public-data.mjs": "export const projectPublicData=value=>value;\n",
    "backend/group-state.mjs": "export const isGroupActive=()=>true;\n",
    "app/appearance-policy.mjs":
      "export * from '../backend/appearance-policy.mjs';\n",
    "backend/admin.mjs": "throw Error('Do not publish server');\n",
    "app/sw.js": "const VERSION = 'v2';\n",
  }))
    await writeFile(join(directory, path), text);
  await writeFile(
    join(directory, "compatibility.json"),
    JSON.stringify(manifest),
  );
  return directory;
}
function run(directory, ...extra) {
  return spawnSync(
    process.execPath,
    [builder, "--source-ref", source, ...extra],
    { cwd: directory, encoding: "utf8" },
  );
}
function build(directory) {
  const result = run(directory);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
const version = (text) =>
  text.match(/const VERSION = '(v5-[a-f0-9]{16})';/)?.[1];
async function snapshot(root, prefix = "") {
  const result = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory())
      Object.assign(result, await snapshot(join(root, entry.name), name + "/"));
    else
      result[name] = (await readFile(join(root, entry.name))).toString(
        "base64",
      );
  }
  return result;
}
test("release seed strips private metadata without rewriting its source file", async (t) => {
  const dir = await fixture(t);
  const seed = {
    groups: [
      {
        id: "g",
        name: "Группа",
        subgroups: ["А"],
        privateNote: "PRIVATE_SENTINEL",
      },
    ],
    rooms: [{ id: "r", name: "204", capacity: 30, note: "PRIVATE_SENTINEL" }],
    lessons: [],
    accounts: [{ password_hash: "PRIVATE_SENTINEL" }],
    history: [{ actor: "PRIVATE_SENTINEL" }],
    source: { file: "PRIVATE_SENTINEL" },
    siteSettings: { privateKey: "PRIVATE_SENTINEL" },
  };
  const original = JSON.stringify(seed);
  await writeFile(join(dir, "app/seed.json"), original);
  build(dir);
  const published = await readFile(join(dir, "dist/seed.json"), "utf8");
  assert.doesNotMatch(
    published,
    /PRIVATE_SENTINEL|password_hash|privateNote|privateKey/,
  );
  assert.equal(JSON.parse(published).groups[0].name, "Группа");
  assert.equal(await readFile(join(dir, "app/seed.json"), "utf8"), original);
});

test("one deterministic production artifact preserves local models and excludes private server code", async (t) => {
  const dir = await fixture(t);
  build(dir);
  const first = await snapshot(join(dir, "dist"));
  assert.ok(version(await readFile(join(dir, "dist/sw.js"), "utf8")));
  build(dir);
  assert.deepEqual(await snapshot(join(dir, "dist")), first);
  assert.match(
    await readFile(join(dir, "dist/core.mjs"), "utf8"),
    /\.\/model\.mjs/,
  );
  assert.equal(
    await readFile(join(dir, "dist/model.mjs"), "utf8"),
    await readFile(join(dir, "backend/core.mjs"), "utf8"),
  );
  await assert.rejects(access(join(dir, "dist/backend/admin.mjs")));
  for (const file of ["appearance-policy.mjs", "backend/appearance-policy.mjs"])
    assert.equal(
      await readFile(join(dir, "dist", file), "utf8"),
      await readFile(join(dir, "backend/appearance-policy.mjs"), "utf8"),
    );
  assert.equal(
    JSON.parse(await readFile(join(dir, "dist/release.json"), "utf8"))
      .sourceRef,
    source,
  );
});
test("retired addresses contain redirect documents and a retirement worker, never another application", async (t) => {
  const dir = await fixture(t);
  build(dir);
  for (const route of manifest.legacyRoutes) {
    assert.match(
      await readFile(join(dir, "dist", route.path, "index.html"), "utf8"),
      /redirect\.mjs/,
    );
    await assert.rejects(access(join(dir, "dist", route.path, "app.mjs")));
    if (route.worker)
      assert.match(
        await readFile(join(dir, "dist", route.path, "sw.js"), "utf8"),
        /retirement-worker\.js/,
      );
  }
  assert.equal(
    JSON.parse(await readFile(join(dir, "dist/compatibility.json"), "utf8"))
      .retirementGuard,
    undefined,
  );
  assert.match(
    await readFile(join(dir, "dist/404.html"), "utf8"),
    /\/schedule\/redirect\.mjs/,
  );
});
test("unknown options and invalid public paths fail before replacing a reviewed artifact", async (t) => {
  const dir = await fixture(t);
  build(dir);
  const before = await snapshot(join(dir, "dist"));
  assert.notEqual(run(dir, "--channel", "alternate").status, 0);
  assert.notEqual(run(dir, "--base-path", "/../../").status, 0);
  assert.deepEqual(await snapshot(join(dir, "dist")), before);
});
test("asset changes change the release worker digest without modifying source", async (t) => {
  const dir = await fixture(t);
  build(dir);
  const first = version(await readFile(join(dir, "dist/sw.js"), "utf8"));
  await writeFile(join(dir, "app/styles.css"), "body{color:#7957d5;}\n");
  build(dir);
  assert.notEqual(
    version(await readFile(join(dir, "dist/sw.js"), "utf8")),
    first,
  );
  assert.match(
    await readFile(join(dir, "app/sw.js"), "utf8"),
    /VERSION = 'v2'/,
  );
});

test("a symbolic output cannot redirect recursive build cleanup into another directory", async (t) => {
  const dir = await fixture(t),
    external = join(dir, "keep-outside-output");
  await mkdir(external);
  await writeFile(join(external, "proof.txt"), "keep");
  await symlink(
    external,
    join(dir, "dist"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.notEqual(run(dir).status, 0);
  assert.equal(await readFile(join(external, "proof.txt"), "utf8"), "keep");
});
