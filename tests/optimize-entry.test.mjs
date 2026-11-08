import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { optimizeEntry } from "../scripts/optimize-entry.mjs";
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "uniflow-optimize-"));
  t.after(async () => {
    if (
      dirname(resolve(dir)) !== resolve(tmpdir()) ||
      !basename(dir).startsWith("uniflow-optimize-")
    )
      throw Error("Unsafe cleanup");
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(
    join(dir, "index.html"),
    `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src 'self'; style-src 'self';"><link rel="stylesheet" href="./styles.css"><link rel="modulepreload" href="./helper.mjs"><script type="module" src="./app.mjs"></script><main id="main"></main>`,
  );
  await writeFile(join(dir, "helper.mjs"), 'export const subject="Алгоритмы";');
  await writeFile(
    join(dir, "app.mjs"),
    'import {subject} from "./helper.mjs";document.getElementById("main").textContent=subject;',
  );
  await writeFile(
    join(dir, "styles.css"),
    "body { color: #252231; background: white; }",
  );
  return dir;
}
test("compiled entry keeps the bundle outside HTML, hashes inline CSS and retains strict CSP", async (t) => {
  const dir = await fixture(t);
  await optimizeEntry(dir);
  const html = await readFile(join(dir, "index.html"), "utf8"),
    js = await readFile(join(dir, "app.mjs"), "utf8"),
    css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const hash = (text) => createHash("sha256").update(text).digest("base64");
  const loader = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  assert.ok(html.includes(`script-src 'self' 'sha256-${hash(loader)}';`));
  assert.match(loader, /import\("\.\/app\.mjs"\)/);
  assert.ok(!html.includes(js));
  assert.ok(html.includes(`style-src 'self' 'sha256-${hash(css)}';`));
  assert.doesNotMatch(html, /unsafe-inline|modulepreload|href="\.\/styles/);
  assert.doesNotMatch(js, /from\s*["']\.\/helper/);
  assert.match(js, /Алгоритмы/);
  assert.equal(await readFile(join(dir, "app.mjs"), "utf8"), js);
  assert.equal(await readFile(join(dir, "styles.css"), "utf8"), css);
});
test("closing-tag text remains escaped inside trusted script and preserves its literal value", async (t) => {
  const dir = await fixture(t);
  await writeFile(
    join(dir, "app.mjs"),
    'window.payload="</script><script>bad()</script>";',
  );
  await optimizeEntry(dir);
  const js = await readFile(join(dir, "app.mjs"), "utf8");
  assert.doesNotMatch(js, /<\/script/i);
  const context = { window: {} };
  runInNewContext(js, context);
  assert.equal(context.window.payload, "</script><script>bad()</script>");
});
test("missing CSP is rejected, an already compiled/non-app fixture is left unchanged", async (t) => {
  const dir = await fixture(t),
    file = join(dir, "index.html");
  await writeFile(
    file,
    (await readFile(file, "utf8")).replace("script-src 'self';", ""),
  );
  await assert.rejects(optimizeEntry(dir), /strict CSP/);
  await writeFile(file, "<!doctype html><title>Fixture</title>");
  assert.equal(await optimizeEntry(dir), false);
  assert.equal(
    await readFile(file, "utf8"),
    "<!doctype html><title>Fixture</title>",
  );
});

test("prepaint appearance bootstrap is hashed and stays before the stylesheet and UI module", async (t) => {
  const dir = await fixture(t),
    file = join(dir, "index.html");
  await writeFile(
    file,
    (await readFile(file, "utf8")).replace(
      '<link rel="stylesheet"',
      '<script src="./appearance-init.js"></script><link rel="stylesheet"',
    ),
  );
  await writeFile(
    join(dir, "appearance-init.js"),
    'document.documentElement.dataset.palette="forest";',
  );
  await optimizeEntry(dir);
  const html = await readFile(file, "utf8"),
    early = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const hash = createHash("sha256").update(early).digest("base64");
  assert.ok(html.includes("'sha256-" + hash + "'"));
  assert.ok(html.indexOf("<script>") < html.indexOf("<style>"));
  assert.ok(html.indexOf("<script>") < html.indexOf('<script type="module"'));
  assert.doesNotMatch(html, /src="\.\/appearance-init|unsafe-inline/);
});
