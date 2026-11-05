import { cp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
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
}
await writeFile(resolve(target, ".nojekyll"), "");
const root = await readFile(resolve(target, "index.html"), "utf8");
if (channel === "beta" && root !== (await readFile("index.html", "utf8")))
  throw new Error("Beta build changed the legacy root.");
console.log(
  `Built ${channel} candidate in dist. Server handlers, SQL and development dependencies are excluded; only the pure shared model is public.`,
);
