import { spawnSync, execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateMetadata } from "./production-base.mjs";
import {
  parseGitHubLookup,
  releaseAssets,
  ensureLockedRelease,
} from "./locked-release.mjs";

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
  if (args.length && (args.length !== 2 || args[0] !== "--dir" || !args[1]))
    throw Error("Only --dir <verified-artifact-directory> is accepted.");
  const directory = resolve(args[1] || "release-upload");
  const archive = resolve(directory, "production-site.tar");
  const manifest = resolve(directory, "production.json");
  const archiveBytes = await readFile(archive);
  const manifestBytes = await readFile(manifest);
  const metadata = JSON.parse(manifestBytes.toString("utf8"));
  validateMetadata(metadata, archiveBytes);
  if (metadata.sourceRef !== sourceRef || String(metadata.workflowRun) !== run)
    throw Error(
      "Verified artifact belongs to another production source or workflow run.",
    );
  const tag = "uniflow-production-" + run;
  const endpoint = "repos/" + repository + "/releases/tags/" + tag;
  const files = { "production-site.tar": archive, "production.json": manifest };
  const outcome = await ensureLockedRelease({
    sourceRef,
    tag,
    assets: releaseAssets(archiveBytes, manifestBytes),
    lookup: async () =>
      parseGitHubLookup(
        spawnSync(
          "gh",
          [
            "api",
            "--include",
            endpoint,
            "-H",
            "Accept: application/vnd.github+json",
            "-H",
            "X-GitHub-Api-Version: 2026-03-10",
          ],
          { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
        ),
      ),
    createDraft: async () =>
      execFileSync(
        "gh",
        [
          "release",
          "create",
          tag,
          "--draft",
          "--repo",
          repository,
          "--target",
          sourceRef,
          "--title",
          "Verified UniFlow production " + run,
          "--notes",
          "Verified production artifact. Source and artifact digests are checked by the publishing workflow.",
        ],
        { stdio: "inherit" },
      ),
    upload: async (name) =>
      execFileSync(
        "gh",
        ["release", "upload", tag, files[name], "--repo", repository],
        { stdio: "inherit" },
      ),
    publish: async () =>
      execFileSync(
        "gh",
        ["release", "edit", tag, "--draft=false", "--repo", repository],
        { stdio: "inherit" },
      ),
  });
  console.log(JSON.stringify({ tag, sourceRef, immutable: true, outcome }));
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
)
  await main();
