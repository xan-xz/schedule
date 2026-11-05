import { cp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const channel = args[args.indexOf("--channel") + 1] || "beta";
if (!["beta", "production"].includes(channel))
  throw new Error("Channel must be beta or production.");
if (channel === "production" && !args.includes("--data-decision-reviewed"))
  throw new Error(
    "Production requires --data-decision-reviewed after resolving the two data sources. See docs/MERGE_PLAN.md.",
  );
const target = resolve("dist");
if (target !== resolve(process.cwd(), "dist"))
  throw new Error("Unsafe output path");
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp("index.html", resolve(target, "index.html"));
await cp("beta", resolve(target, "beta"), { recursive: true });
await mkdir(resolve(target, "backend"), { recursive: true });
// This is the pure shared model, already imported by the browser. Never copy
// the API handlers, SQL, settings or any server environment into Pages.
await cp("backend/core.mjs", resolve(target, "backend/core.mjs"));
for (const entry of await readdir(".")) {
  if (/^(favicon\.|robots\.txt$|sitemap\.xml$)/.test(entry))
    await cp(entry, resolve(target, entry));
}
if (channel === "production") {
  for (const entry of await readdir("beta"))
    await cp(resolve("beta", entry), resolve(target, entry), {
      recursive: true,
    });
  const corePath = resolve(target, "core.mjs");
  const core = await readFile(corePath, "utf8");
  await writeFile(
    corePath,
    core.replaceAll("../backend/core.mjs", "./backend/core.mjs"),
  );
  const workerPath = resolve(target, "sw.js");
  const worker = await readFile(workerPath, "utf8");
  await writeFile(
    workerPath,
    worker.replaceAll("../backend/core.mjs", "./backend/core.mjs"),
  );
}
await writeFile(resolve(target, ".nojekyll"), "");
const root = await readFile(resolve(target, "index.html"), "utf8");
if (channel === "beta" && root !== (await readFile("index.html", "utf8")))
  throw new Error("Beta build changed the legacy root.");

// Installed clients cache the shell first. A change to any published asset must
// therefore change the worker bytes, even when sw.js itself was not edited.
async function publicFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory())
      files.push(
        ...(await publicFiles(resolve(directory, entry.name), name + "/")),
      );
    else if (
      entry.isFile() &&
      entry.name !== "sw.js" &&
      entry.name !== ".nojekyll"
    )
      files.push(name);
  }
  return files;
}
const digest = createHash("sha256");
for (const file of (await publicFiles(target)).sort()) {
  const content = await readFile(resolve(target, file));
  digest.update(file).update("\0").update(String(content.length)).update("\0");
  digest.update(content);
}
const workerVersion = "v3-" + digest.digest("hex").slice(0, 16);
for (const file of channel === "production"
  ? ["beta/sw.js", "sw.js"]
  : ["beta/sw.js"]) {
  const path = resolve(target, file);
  const worker = await readFile(path, "utf8");
  const declaration = /^const VERSION\s*=\s*['"][^'"\r\n]+['"];$/m;
  if (!declaration.test(worker))
    throw new Error(`Missing cache version declaration in ${file}.`);
  await writeFile(
    path,
    worker.replace(declaration, `const VERSION = '${workerVersion}';`),
  );
}
console.log(
  `Built ${channel} candidate in dist. Server handlers, SQL and development dependencies are excluded; only the pure shared model is public.`,
);
