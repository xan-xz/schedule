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
import { resolve, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { optimizeEntry } from "./optimize-entry.mjs";

const args = process.argv.slice(2);
const value = (name, fallback) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const channel = value("--channel", "production");
if (!["beta", "production"].includes(channel))
  throw Error("Channel must be beta or production");
if (channel === "production" && !args.includes("--data-decision-reviewed"))
  throw Error(
    "Production requires --data-decision-reviewed; the owner selected beta/XLSX. See docs/MERGE_PLAN.md.",
  );
const workspace = resolve(process.cwd()),
  target = resolve("dist");
if (!target.startsWith(workspace + sep) || target === workspace)
  throw Error("Unsafe build target");
let productionBase = null,
  baseMetadata = null;
if (channel === "beta") {
  if (!value("--production-base"))
    throw Error(
      "Beta requires --production-base from the last verified production release. Refusing to restore the archived root.",
    );
  productionBase = resolve(value("--production-base"));
  if (productionBase === target || productionBase.startsWith(target + sep))
    throw Error("Production base cannot be inside dist");
  baseMetadata = JSON.parse(
    await readFile(
      resolve(productionBase, ".uniflow-production-base.json"),
      "utf8",
    ),
  );
  if (
    baseMetadata.format !== "uniflow-production-v1" ||
    !/^[a-f0-9]{40}$/.test(baseMetadata.sourceRef || "")
  )
    throw Error("Unverified production base");
}
const git = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
const sourceRef = value(
  "--source-ref",
  process.env.GITHUB_SHA ||
    (git.status === 0 && git.stdout.trim()) ||
    "0".repeat(40),
);
if (!/^[a-f0-9]{40}$/.test(sourceRef)) throw Error("Invalid source revision");

// Only task-owned dist is removed; no source, source-data or hosted state changes.
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
async function copyPublicBase(base) {
  await cp(base, target, {
    recursive: true,
    filter: async (path) => {
      const name = relative(base, path).split(sep).join("/");
      if (!name) return true;
      if (
        name === "beta" ||
        name.startsWith("beta/") ||
        name === ".uniflow-production-base.json"
      )
        return false;
      if ((await lstat(path)).isSymbolicLink())
        throw Error("Public release cannot contain symlinks");
      if (
        /(^|\/)(?:\.git|\.env(?:\.[^/]*)?|node_modules)(?:\/|$)/.test(name) ||
        (name.startsWith("backend/") && name !== "backend/core.mjs")
      )
        throw Error("Non-public file in production base");
      return true;
    },
  });
}
if (productionBase) await copyPublicBase(productionBase);
await cp("beta", resolve(target, "beta"), { recursive: true });
// Per-channel model avoids a beta release changing production's lazy shared code.
await cp("backend/core.mjs", resolve(target, "beta/model.mjs"));
await writeFile(
  resolve(target, "beta/core.mjs"),
  'export * from "./model.mjs";\n',
);
await optimizeEntry(resolve(target, "beta"));
await writeFile(
  resolve(target, "beta/release.json"),
  JSON.stringify(
    {
      format: "uniflow-scope-v1",
      channel: "beta",
      sourceRef,
      productionBase: baseMetadata?.sourceRef || sourceRef,
    },
    null,
    2,
  ) + "\n",
);
if (channel === "production") {
  for (const entry of await readdir(resolve(target, "beta")))
    await cp(resolve(target, "beta", entry), resolve(target, entry), {
      recursive: true,
    });
  // Preserve the old public pure-model URL for already-installed clients.
  await mkdir(resolve(target, "backend"), { recursive: true });
  await cp("backend/core.mjs", resolve(target, "backend/core.mjs"));
  const worker = await readFile(resolve(target, "sw.js"), "utf8");
  await writeFile(
    resolve(target, "sw.js"),
    worker.replaceAll("../backend/core.mjs", "./backend/core.mjs"),
  );
  await writeFile(
    resolve(target, "release.json"),
    JSON.stringify(
      { format: "uniflow-scope-v1", channel: "production", sourceRef },
      null,
      2,
    ) + "\n",
  );
}
await writeFile(resolve(target, ".nojekyll"), "");

async function files(directory, { skipBeta = false } = {}, prefix = "") {
  const list = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (skipBeta && !prefix && entry.name === "beta") continue;
    const name = prefix + entry.name;
    if (entry.isDirectory())
      list.push(
        ...(await files(resolve(directory, entry.name), {}, name + "/")),
      );
    else if (
      entry.isFile() &&
      entry.name !== "sw.js" &&
      entry.name !== ".nojekyll" &&
      entry.name !== ".uniflow-production-base.json"
    )
      list.push(name);
  }
  return list.sort();
}
async function digest(directory, options) {
  const hash = createHash("sha256");
  for (const file of await files(directory, options)) {
    const bytes = await readFile(resolve(directory, file));
    hash
      .update(file)
      .update("\0")
      .update(String(bytes.length))
      .update("\0")
      .update(bytes);
  }
  return hash.digest("hex");
}
async function stamp(directory, options) {
  const path = resolve(directory, "sw.js"),
    worker = await readFile(path, "utf8");
  const version = "v4-" + (await digest(directory, options)).slice(0, 16);
  const declaration = /^const VERSION\s*=\s*["'][^"'\r\n]+["'];$/m;
  if (!declaration.test(worker))
    throw Error("Worker cache declaration is missing");
  await writeFile(
    path,
    worker.replace(declaration, `const VERSION = '${version}';`),
  );
}
await stamp(resolve(target, "beta"));
if (channel === "production") await stamp(target, { skipBeta: true });
if (productionBase) {
  const before = await digest(productionBase, { skipBeta: true }),
    after = await digest(target, { skipBeta: true });
  // Include the root worker separately: it must remain byte-identical too.
  if (
    before !== after ||
    !(await readFile(resolve(productionBase, "sw.js"))).equals(
      await readFile(resolve(target, "sw.js")),
    )
  )
    throw Error("Beta build changed production assets");
}
console.log(
  `Built ${channel}; source ${sourceRef}; production ${baseMetadata?.sourceRef || sourceRef}. No hosted data changed.`,
);
