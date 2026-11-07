import { spawnSync, execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateMetadata } from "./production-base.mjs";

export function parseGitHubLookup(result) {
  if (result.error || result.signal || typeof result.stdout !== "string")
    throw Error("GitHub release lookup failed before a valid HTTP response.");
  const raw = result.stdout.replace(/\r\n/g, "\n");
  const boundary = raw.indexOf("\n\n");
  const status = Number(/^HTTP\/[\d.]+ (\d{3})(?: |\n)/.exec(raw)?.[1]);
  if (boundary < 0 || ![200, 404].includes(status))
    throw Error(
      `GitHub release lookup returned an unexpected HTTP status: ${status || "unknown"}.`,
    );
  let body;
  try {
    body = JSON.parse(raw.slice(boundary + 2));
  } catch {
    throw Error("GitHub release lookup did not return valid JSON.");
  }
  if (status === 200 && result.status !== 0)
    throw Error(
      "GitHub release lookup command failed despite an HTTP 200 response.",
    );
  if (
    status === 404 &&
    (result.status !== 1 ||
      typeof body?.message !== "string" ||
      (body.status !== undefined && String(body.status) !== "404"))
  )
    throw Error(
      "GitHub release lookup returned a malformed HTTP 404 response.",
    );
  return { status, body };
}

export function classifyReleaseLookup({ status, body }, sourceRef) {
  if (!/^[a-f0-9]{40}$/.test(sourceRef || ""))
    throw Error("An immutable production source SHA is required.");
  if (status === 404) {
    if (
      typeof body?.message !== "string" ||
      (body.status !== undefined && String(body.status) !== "404")
    )
      throw Error(
        "GitHub release absence was not confirmed by a valid HTTP 404 response.",
      );
    return "create";
  }
  if (
    status !== 200 ||
    body?.target_commitish !== sourceRef ||
    !Array.isArray(body.assets)
  )
    throw Error(
      "Existing production release points to another source or is malformed.",
    );
  for (const name of ["production-site.tar", "production.json"])
    if (body.assets.filter((asset) => asset?.name === name).length !== 1)
      throw Error(
        "Existing production release is incomplete or has ambiguous assets; restore its exact missing assets before retrying.",
      );
  return "existing";
}

/** Never turn an API/network error into release creation. A retry is a no-op
 * only when the already-recorded source and both required assets are complete.
 */
export async function ensureProductionRelease({ lookup, create, sourceRef }) {
  const decision = classifyReleaseLookup(await lookup(), sourceRef);
  if (decision === "existing") return "existing";
  try {
    await create();
  } catch (error) {
    // A create request may have succeeded before its response was lost, or a
    // concurrent retry may have completed it. Re-read, never overwrite assets.
    const retry = classifyReleaseLookup(await lookup(), sourceRef);
    if (retry === "existing") return "existing";
    throw error;
  }
  return "created";
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const sourceRef = process.env.GITHUB_SHA;
  const run = process.env.GITHUB_RUN_ID;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(
      repository || "",
    ) ||
    !/^[a-f0-9]{40}$/.test(sourceRef || "") ||
    !/^\d+$/.test(run || "")
  )
    throw Error(
      "Recording requires a valid workflow repository, source SHA and run ID.",
    );
  const args = process.argv.slice(2);
  const directory = resolve(
    args.includes("--dir") ? args[args.indexOf("--dir") + 1] : "release-upload",
  );
  const archive = resolve(directory, "production-site.tar");
  const manifest = resolve(directory, "production.json");
  const metadata = JSON.parse(await readFile(manifest, "utf8"));
  validateMetadata(metadata, await readFile(archive));
  if (metadata.sourceRef !== sourceRef)
    throw Error("Verified artifact belongs to another production source.");
  const tag = `uniflow-production-${run}`;
  const endpoint = `repos/${repository}/releases/tags/${tag}`;
  const outcome = await ensureProductionRelease({
    sourceRef,
    lookup: async () =>
      parseGitHubLookup(
        spawnSync("gh", ["api", "--include", endpoint], {
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
        }),
      ),
    create: async () =>
      execFileSync(
        "gh",
        [
          "release",
          "create",
          tag,
          "--repo",
          repository,
          "--target",
          sourceRef,
          "--title",
          `Verified UniFlow production ${run}`,
          "--notes",
          "Verified immutable production Pages artifact for deployment and rollback.",
          archive,
          manifest,
        ],
        { stdio: "inherit" },
      ),
  });
  console.log(JSON.stringify({ tag, sourceRef, outcome }));
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
)
  await main();
