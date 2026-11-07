import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { checkRetirement } from "../scripts/check-retirement.mjs";

async function fixture(t, files, exceptions = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uniflow-retirement-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return {
    root,
    sourcePaths: Object.keys(files),
    manifest: { retirementGuard: { exceptions } },
  };
}
const allow = (file, ...literals) => ({
  path: file,
  literals,
  reason: "Explicit compatibility or negative-test line",
});

test("guard accepts a clean canonical source", async (t) => {
  const context = await fixture(t, { "app/index.html": "<h1>UniFlow</h1>" });
  assert.equal((await checkRetirement(context)).ok, true);
});

test("guard rejects removed terms regardless of case or alphabet", async (t) => {
  const terms = ["beta", "BETA", "Demo", "dEmO", "Бета", "ДЕМО"];
  const context = await fixture(t, { "app/index.html": terms.join("\n") });
  const result = await checkRetirement(context);
  assert.equal(result.ok, false);
  assert.equal(result.findings.length, terms.length);
});

test("an exact path and full line are required for an exception", async (t) => {
  const line = 'location.replace("/schedule/"); // /beta/ retired';
  const context = await fixture(
    t,
    { "compat/retired.js": line, "app/app.mjs": line },
    [allow("compat/retired.js", line)],
  );
  const result = await checkRetirement(context);
  assert.deepEqual(result.findings, [
    { path: "app/app.mjs", line: 1, code: "FORBIDDEN_LITERAL" },
  ]);
});

test("changing an approved line never authorizes a new term", async (t) => {
  const line = 'const route = "/beta/";';
  const context = await fixture(
    t,
    { "compat/retired.js": line + ' const mode = "demo";' },
    [allow("compat/retired.js", line)],
  );
  assert.deepEqual(
    (await checkRetirement(context)).findings.map((finding) => finding.code),
    ["FORBIDDEN_LITERAL", "STALE_EXCEPTION"],
  );
});

test("a forbidden filename requires its own explicit compatibility path", async (t) => {
  const context = await fixture(t, { "app/demo.mjs": "export {};" });
  assert.equal(
    (await checkRetirement(context)).findings[0].code,
    "FORBIDDEN_PATH",
  );
});

test("path-only compatibility does not exempt its content", async (t) => {
  const file = "dist/beta/index.html";
  const context = await fixture(t, { [file]: "<p>Moved</p>" }, [allow(file)]);
  assert.equal((await checkRetirement(context)).ok, true);
  await fs.writeFile(path.join(context.root, file), "<p>demo</p>");
  assert.deepEqual((await checkRetirement(context)).findings, [
    { path: file, line: 1, code: "FORBIDDEN_LITERAL" },
  ]);
});

test("only named historical documents are exempt", async (t) => {
  const context = await fixture(t, {
    "docs/REMOVAL_INVENTORY.md": "beta demo Бета Демо",
    "CHANGELOG.md": "beta retired",
    "docs/README.md": "beta",
  });
  assert.deepEqual((await checkRetirement(context)).findings, [
    { path: "docs/README.md", line: 1, code: "FORBIDDEN_LITERAL" },
  ]);
});

test("guard rejects broad, duplicate or stale exceptions", async (t) => {
  const context = await fixture(t, { "compat/retired.js": "export {};" });
  for (const entry of [
    allow("app/*", "beta"),
    allow("../outside", "beta"),
    allow("compat/retired.js", "export {};"),
    allow("compat/retired.js", " beta "),
  ]) {
    await assert.rejects(
      checkRetirement({
        ...context,
        manifest: { retirementGuard: { exceptions: [entry] } },
      }),
      /Invalid or duplicate/u,
    );
  }
  await assert.rejects(
    checkRetirement({
      ...context,
      manifest: {
        retirementGuard: {
          exceptions: [
            allow("compat/retired.js", "beta"),
            allow("compat/retired.js", "beta"),
          ],
        },
      },
    }),
    /Invalid or duplicate/u,
  );
  context.manifest.retirementGuard.exceptions.push(
    allow("compat/retired.js", "beta"),
  );
  assert.equal(
    (await checkRetirement(context)).findings[0].code,
    "STALE_EXCEPTION",
  );
});

test("compiled artifact is scanned even when source list omits ignored output", async (t) => {
  const context = await fixture(t, {
    "app/app.mjs": "export {};",
    "dist/index.html": "<p>DEMO</p>",
    "node_modules/fixture/index.js": "beta",
  });
  const result = await checkRetirement(context);
  assert.equal(result.artifact, true);
  assert.deepEqual(result.findings, [
    { path: "dist/index.html", line: 1, code: "FORBIDDEN_LITERAL" },
  ]);
});

test("source exceptions do not exempt artifact files", async (t) => {
  const line = 'const retired = "/beta/";';
  const context = await fixture(
    t,
    { "compat/retired.js": line, "dist/retired.js": line },
    [allow("compat/retired.js", line)],
  );
  assert.equal(
    (await checkRetirement(context)).findings[0].path,
    "dist/retired.js",
  );
  context.manifest.retirementGuard.exceptions.push(
    allow("dist/retired.js", line),
  );
  assert.equal((await checkRetirement(context)).ok, true);
});

test("release invocation requires a built artifact", async (t) => {
  const context = await fixture(t, { "app/app.mjs": "export {};" });
  assert.equal(
    (await checkRetirement({ ...context, requireDist: true })).findings[0].code,
    "MISSING_ARTIFACT",
  );
});

test("default inventory includes tracked and untracked source and skips removed files", async (t) => {
  const context = await fixture(t, { "tracked.txt": "clean" });
  execFileSync("git", ["init", "--quiet"], { cwd: context.root });
  execFileSync("git", ["add", "tracked.txt"], { cwd: context.root });
  await fs.unlink(path.join(context.root, "tracked.txt"));
  await fs.writeFile(path.join(context.root, "untracked.txt"), "demo");
  delete context.sourcePaths;
  assert.deepEqual((await checkRetirement(context)).findings, [
    { path: "untracked.txt", line: 1, code: "FORBIDDEN_LITERAL" },
  ]);
});

test("binary assets are skipped and undecodable text fails closed", async (t) => {
  const context = await fixture(t, {
    "icon.png": Buffer.from([0, 255, 128, 1]),
    "invalid.txt": Buffer.from([255, 254, 128]),
  });
  assert.deepEqual((await checkRetirement(context)).findings, [
    { path: "invalid.txt", line: 0, code: "UNSCANNED_ENCODING" },
  ]);
});

test("a NUL byte cannot disguise source as a binary asset", async (t) => {
  const context = await fixture(t, {
    "app/app.mjs": Buffer.from([0, 65, 66]),
  });
  assert.deepEqual((await checkRetirement(context)).findings, [
    { path: "app/app.mjs", line: 0, code: "UNSCANNED_ENCODING" },
  ]);
});
