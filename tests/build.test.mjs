import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const builder = fileURLToPath(new URL("../scripts/build.mjs", import.meta.url));
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "uniflow-build-test-"));
  t.after(async () => {
    // Remove only the verified, task-created temporary fixture.
    if (
      dirname(resolve(directory)) !== resolve(tmpdir()) ||
      !basename(directory).startsWith("uniflow-build-test-")
    )
      throw new Error("Unsafe test cleanup path");
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(join(directory, "beta/lib"), { recursive: true });
  await mkdir(join(directory, "backend"));
  const files = {
    "index.html": "<!doctype html><title>Legacy root remains intact</title>",
    "beta/index.html": "<!doctype html><title>Unified student app</title>",
    "beta/app.mjs": "export const release = 1;\n",
    "beta/styles.css": "body { color: #221933; }\n",
    "beta/lib/client.mjs": "export const localFirst = true;\n",
    "beta/core.mjs": "export * from '../backend/core.mjs';\n",
    "backend/core.mjs": "export const shared = true;\n",
    "backend/admin.mjs": "throw new Error('server source must not ship');\n",
    "beta/sw.js":
      "const VERSION = 'v2';\nconst sharedModel = '../backend/core.mjs';\n",
  };
  for (const [path, contents] of Object.entries(files))
    await writeFile(join(directory, path), contents);
  return directory;
}
function build(directory, channel = "beta") {
  const args = [builder, "--channel", channel];
  if (channel === "production") args.push("--data-decision-reviewed");
  const result = spawnSync(process.execPath, args, {
    cwd: directory,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
const version = (worker) =>
  worker.match(/const VERSION = '(v3-[a-f0-9]{16})';/)?.[1];

test("beta builds produce deterministic worker versions and preserve the legacy root", async (t) => {
  const directory = await fixture(t);
  build(directory);
  const firstWorker = await readFile(
    join(directory, "dist/beta/sw.js"),
    "utf8",
  );
  const firstVersion = version(firstWorker);
  assert.ok(firstVersion);
  build(directory);
  assert.equal(
    await readFile(join(directory, "dist/beta/sw.js"), "utf8"),
    firstWorker,
  );
  assert.equal(
    await readFile(join(directory, "dist/index.html"), "utf8"),
    await readFile(join(directory, "index.html"), "utf8"),
  );
  assert.equal(
    await readFile(join(directory, "dist/backend/core.mjs"), "utf8"),
    await readFile(join(directory, "backend/core.mjs"), "utf8"),
  );
  await assert.rejects(access(join(directory, "dist/backend/admin.mjs")));
  assert.match(
    await readFile(join(directory, "beta/sw.js"), "utf8"),
    /VERSION = 'v2'/,
  );
});

test("editing app or CSS bytes changes worker version without editing source worker", async (t) => {
  const directory = await fixture(t);
  build(directory);
  const first = version(
    await readFile(join(directory, "dist/beta/sw.js"), "utf8"),
  );
  await writeFile(
    join(directory, "beta/app.mjs"),
    "export const release = 2;\n",
  );
  build(directory);
  const second = version(
    await readFile(join(directory, "dist/beta/sw.js"), "utf8"),
  );
  assert.notEqual(first, second);
  await writeFile(
    join(directory, "beta/styles.css"),
    "body { color: #7957d5; }\n",
  );
  build(directory);
  assert.notEqual(
    version(await readFile(join(directory, "dist/beta/sw.js"), "utf8")),
    second,
  );
});

test("worker source is excluded from asset hash while its own changed bytes remain published", async (t) => {
  const directory = await fixture(t);
  build(directory);
  const first = version(
    await readFile(join(directory, "dist/beta/sw.js"), "utf8"),
  );
  await writeFile(
    join(directory, "beta/sw.js"),
    "// new worker behavior\nconst VERSION = 'v2';\nconst sharedModel = '../backend/core.mjs';\n",
  );
  build(directory);
  const worker = await readFile(join(directory, "dist/beta/sw.js"), "utf8");
  assert.equal(version(worker), first);
  assert.match(worker, /new worker behavior/);
});

test("production versions both workers and retains independent beta/core paths", async (t) => {
  const directory = await fixture(t);
  build(directory, "production");
  const rootWorker = await readFile(join(directory, "dist/sw.js"), "utf8");
  const betaWorker = await readFile(join(directory, "dist/beta/sw.js"), "utf8");
  assert.ok(version(rootWorker));
  assert.equal(version(rootWorker), version(betaWorker));
  assert.match(rootWorker, /sharedModel = '\.\/backend\/core.mjs'/);
  assert.match(betaWorker, /sharedModel = '\.\.\/backend\/core.mjs'/);
  assert.equal(
    await readFile(join(directory, "dist/index.html"), "utf8"),
    await readFile(join(directory, "beta/index.html"), "utf8"),
  );
  assert.match(
    await readFile(join(directory, "dist/core.mjs"), "utf8"),
    /from '\.\/backend\/core.mjs'/,
  );
  assert.match(
    await readFile(join(directory, "dist/beta/core.mjs"), "utf8"),
    /from '\.\.\/backend\/core.mjs'/,
  );
});
