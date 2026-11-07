import {
  cp,
  mkdir,
  readdir,
  readFile,
  writeFile,
  rm,
  lstat,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, relative, sep, posix } from "node:path";
import { spawnSync } from "node:child_process";
import { optimizeEntry } from "./optimize-entry.mjs";
import { validateCompatibility } from "../app/lib/compatibility-policy.mjs";

const args = process.argv.slice(2);
const value = (flag, fallback) =>
  args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
for (let index = 0; index < args.length; index += 2)
  if (!["--source-ref", "--base-path"].includes(args[index]))
    throw Error("Unknown build option");
const workspace = resolve(process.cwd()),
  target = resolve("dist");
if (!target.startsWith(workspace + sep) || target === workspace)
  throw Error("Unsafe build target");
const git = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
const sourceRef = value(
  "--source-ref",
  process.env.GITHUB_SHA ||
    (git.status === 0 && git.stdout.trim()) ||
    "0".repeat(40),
);
if (!/^[a-f0-9]{40}$/.test(sourceRef)) throw Error("Invalid source revision");
const basePath = value("--base-path", "/schedule/");
if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(basePath))
  throw Error("Invalid public base path");
const compatibility = JSON.parse(await readFile("compatibility.json", "utf8"));
if (!validateCompatibility(compatibility))
  throw Error("Invalid compatibility manifest");
if (
  await lstat(target).then(
    (info) => info.isSymbolicLink(),
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  )
)
  throw Error("Build output must not be a symbolic link");
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp("app", target, {
  recursive: true,
  filter: async (path) => {
    if ((await lstat(path)).isSymbolicLink())
      throw Error("Public source contains a symlink");
    if (
      /(^|[\\/])(?:\.git|\.env(?:\.[^\\/]*)?|node_modules)(?:[\\/]|$)/.test(
        path,
      )
    )
      throw Error("Non-public source file");
    return true;
  },
});
await cp("backend/core.mjs", resolve(target, "model.mjs"));
await writeFile(resolve(target, "core.mjs"), 'export * from "./model.mjs";\n');
// Preserve the former pure-model address for installed clients until they reload.
await mkdir(resolve(target, "backend"), { recursive: true });
await cp("backend/core.mjs", resolve(target, "backend/core.mjs"));
const publicCompatibility = Object.fromEntries(
  Object.entries(compatibility).filter(([key]) => key !== "retirementGuard"),
);
await writeFile(
  resolve(target, "compatibility.json"),
  JSON.stringify(publicCompatibility, null, 2) + "\n",
);
const redirectHtml = (script) =>
  `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'"><title>UniFlow</title><p>Открываем UniFlow…</p><script type="module" src="${script}"></script></html>\n`;
for (const route of compatibility.legacyRoutes) {
  if (!/^(?:[A-Za-z0-9_-]+\/)+$/.test(route.path))
    throw Error("Unsafe compatibility route");
  const directory = resolve(target, route.path);
  if (!directory.startsWith(target + sep))
    throw Error("Unsafe compatibility destination");
  await mkdir(directory, { recursive: true });
  const script = posix.relative(route.path, "redirect.mjs");
  await writeFile(resolve(directory, "index.html"), redirectHtml(script));
  if (route.worker)
    await writeFile(
      resolve(directory, "sw.js"),
      `importScripts(${JSON.stringify(posix.relative(route.path, "retirement-worker.js"))});\n`,
    );
}
await writeFile(
  resolve(target, "404.html"),
  redirectHtml(basePath + "redirect.mjs"),
);
await optimizeEntry(target);
await writeFile(
  resolve(target, "release.json"),
  JSON.stringify(
    { format: "uniflow-scope-v1", channel: "production", sourceRef },
    null,
    2,
  ) + "\n",
);
await writeFile(resolve(target, ".nojekyll"), "");
async function files(directory) {
  const list = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) list.push(...(await files(path)));
    else if (
      entry.isFile() &&
      entry.name !== "sw.js" &&
      entry.name !== ".nojekyll"
    )
      list.push(path);
  }
  return list.sort();
}
const hash = createHash("sha256");
for (const file of await files(target)) {
  const bytes = await readFile(file);
  hash
    .update(relative(target, file).split(sep).join("/"))
    .update("\0")
    .update(String(bytes.length))
    .update("\0")
    .update(bytes);
}
const workerPath = resolve(target, "sw.js"),
  worker = await readFile(workerPath, "utf8");
const declaration = /^const VERSION\s*=\s*["'][^"'\r\n]+["'];$/m;
if (!declaration.test(worker))
  throw Error("Worker version declaration is missing");
await writeFile(
  workerPath,
  worker.replace(
    declaration,
    `const VERSION = 'v5-${hash.digest("hex").slice(0, 16)}';`,
  ),
);
console.log(
  `Built one production candidate from ${sourceRef}. No hosted data changed.`,
);
