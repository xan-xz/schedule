import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateMetadata, verifyArchiveIdentity } from "./production-base.mjs";
import {
  lookupReleaseIncludingDrafts,
  releaseAssets,
  ensureLockedRelease,
  parseGitHubLookup,
  parseGitHubCreatedDraft,
  verifyProductionTag,
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
  verifyArchiveIdentity(archiveBytes, metadata);
  const tag = "uniflow-production-" + run;
  const endpoint = "repos/" + repository + "/releases/tags/" + tag;
  const request = (path, options = []) =>
    spawnSync(
      "gh",
      [
        "api",
        ...options,
        path,
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        "X-GitHub-Api-Version: 2026-03-10",
      ],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
  const files = { "production-site.tar": archive, "production.json": manifest };
  const expected = {
    sourceRef,
    tag,
    assets: releaseAssets(archiveBytes, manifestBytes),
  };
  let releaseId = null;
  const outcome = await ensureLockedRelease({
    ...expected,
    lookup: async () => {
      const release = await lookupReleaseIncludingDrafts({
          tag,
          releaseId,
          lookupPublished: async () => request(endpoint, ["--include"]),
          listPages: async () =>
            request("repos/" + repository + "/releases?per_page=100", [
              "--paginate",
              "--slurp",
            ]),
          lookupById: async (id) =>
            request("repos/" + repository + "/releases/" + id, ["--include"]),
        }),
        tagState = parseGitHubLookup(
          request("repos/" + repository + "/git/ref/tags/" + tag, [
            "--include",
          ]),
        );
      if (release.status === 200) {
        if (!Number.isSafeInteger(release.body?.id) || release.body.id <= 0)
          throw Error("Production release ID is invalid.");
        releaseId = release.body.id;
      }
      verifyProductionTag(
        tagState,
        sourceRef,
        release.status === 200 && release.body.draft === false,
      );
      return release;
    },
    createDraft: async () => {
      const created = request("repos/" + repository + "/releases", [
        "--method",
        "POST",
        "--include",
        "-f",
        "tag_name=" + tag,
        "-f",
        "target_commitish=" + sourceRef,
        "-F",
        "draft=true",
        "-F",
        "prerelease=false",
        "-f",
        "name=Verified UniFlow production " + run,
        "-f",
        "body=Verified production artifact. Source and artifact digests are checked by the publishing workflow.",
      ]);
      releaseId = parseGitHubCreatedDraft(created, expected);
    },
    upload: async (name) => {
      const asset = expected.assets.find((item) => item.name === name);
      if (!Number.isSafeInteger(releaseId) || releaseId <= 0 || !files[name])
        throw Error("Verified draft ID and asset are required before upload.");
      const result = request(
        "https://uploads.github.com/repos/" +
          repository +
          "/releases/" +
          releaseId +
          "/assets?name=" +
          encodeURIComponent(name),
        [
          "--method",
          "POST",
          "--input",
          files[name],
          "-H",
          "Content-Type: application/octet-stream",
          "-H",
          "Content-Length: " + asset.size,
        ],
      );
      if (result.error || result.signal || result.status !== 0)
        throw Error("Release asset upload was not acknowledged.");
    },
    publish: async () => {
      if (!Number.isSafeInteger(releaseId) || releaseId <= 0)
        throw Error("Verified draft ID is required before publication.");
      const result = request("repos/" + repository + "/releases/" + releaseId, [
        "--method",
        "PATCH",
        "-F",
        "draft=false",
      ]);
      if (result.error || result.signal || result.status !== 0)
        throw Error("Release publication was not acknowledged.");
    },
  });
  console.log(JSON.stringify({ tag, sourceRef, immutable: true, outcome }));
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
)
  await main();
