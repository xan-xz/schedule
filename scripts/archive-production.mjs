import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const sourceRef =
  process.env.GITHUB_SHA ||
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!/^[a-f0-9]{40}$/.test(sourceRef))
  throw Error("Immutable production source is required");
const output = resolve(".release/upload");
await mkdir(output, { recursive: true });
const archive = resolve(output, "production-site.tar");
execFileSync("tar", ["-cf", archive, "-C", resolve("dist"), "."], {
  stdio: "pipe",
});
const metadata = {
  format: "uniflow-production-v1",
  sourceRef,
  archiveSha256: createHash("sha256")
    .update(await readFile(archive))
    .digest("hex"),
  workflowRun: process.env.GITHUB_RUN_ID || null,
};
await writeFile(
  resolve(output, "production.json"),
  JSON.stringify(metadata, null, 2) + "\n",
);
console.log(
  JSON.stringify({ archive, metadata: resolve(output, "production.json") }),
);
