import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  lstat,
  realpath,
  rename,
} from "node:fs/promises";
import { resolve, dirname, sep, isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectRelease,
  releaseAssets,
  parseGitHubLookup,
  verifyProductionTag,
} from "./locked-release.mjs";

export function selectLockedProductionRelease(releases) {
  if (!Array.isArray(releases)) throw Error("Invalid production release list");
  const selected = releases
    .filter(
      (item) =>
        item?.draft === false &&
        item.prerelease === false &&
        item.immutable === true &&
        /^uniflow-production-\d+$/.test(item.tag_name || "") &&
        /^[a-f0-9]{40}$/.test(item.target_commitish || "") &&
        Number.isFinite(Date.parse(item.published_at)),
    )
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
  if (!selected) throw Error("No provider-locked production archive exists.");
  return selected;
}

export function validateMetadata(metadata, archive) {
  if (
    metadata?.format !== "uniflow-production-v1" ||
    !/^[a-f0-9]{40}$/.test(metadata.sourceRef || "") ||
    !/^[a-f0-9]{64}$/.test(metadata.archiveSha256 || "") ||
    createHash("sha256").update(archive).digest("hex") !==
      metadata.archiveSha256
  )
    throw new Error("Production archive metadata or checksum is invalid.");
  return metadata;
}

/** Match the actual public artifact identity, not only its outer checksum envelope. */
export function validateArtifactRelease(document, sourceRef) {
  if (
    !/^[a-f0-9]{40}$/.test(sourceRef || "") ||
    document?.format !== "uniflow-scope-v1" ||
    document.channel !== "production" ||
    document.sourceRef !== sourceRef
  )
    throw Error(
      "Artifact release.json does not match the pinned production source.",
    );
  return document;
}
function parseArtifactRelease(bytes) {
  if (!bytes.length || bytes.length > 8192)
    throw Error("Artifact release.json is missing or too large.");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw Error("Artifact release.json is not valid UTF-8 JSON.");
  }
}
function tarOutput(archive, args, maxBuffer = 4 * 1024 * 1024) {
  try {
    return execFileSync("tar", [...args, "-f", "-"], {
      input: archive,
      maxBuffer,
    });
  } catch {
    throw Error("Production archive cannot be inspected safely.");
  }
}
/** All tar reads use the exact checksum-verified bytes. Path replacement cannot
 * swap the inspected artifact; duplicate/case-aliased root identities fail closed. */
export function verifyArchiveIdentity(archive, metadata) {
  if (!Buffer.isBuffer(archive) || archive.length > 64 * 1024 * 1024)
    throw Error("Production archive is too large or invalid.");
  validateMetadata(metadata, archive);
  const entries = safeTarEntries(tarOutput(archive, ["-t"]).toString("utf8"));
  const details = tarOutput(archive, ["-tv"]).toString("utf8");
  if (details.split(/\r?\n/).some((line) => line && !/^[d-]/.test(line)))
    throw Error("Production archive links/special files are forbidden");
  const canonical = (entry) =>
    entry
      .split("/")
      .filter((part) => part && part !== ".")
      .join("/");
  const roots = entries.filter(
    (entry) => canonical(entry).toLowerCase() === "release.json",
  );
  if (
    roots.length !== 1 ||
    canonical(roots[0]) !== "release.json" ||
    roots[0].endsWith("/")
  )
    throw Error("Production archive requires one canonical root release.json.");
  // Put options before the member and terminate option parsing for portability.
  let bytes;
  try {
    bytes = execFileSync("tar", ["-xO", "-f", "-", "--", roots[0]], {
      input: archive,
      maxBuffer: 8192,
    });
  } catch {
    throw Error("Artifact release.json cannot be read safely.");
  }
  return validateArtifactRelease(
    parseArtifactRelease(bytes),
    metadata.sourceRef,
  );
}

export function verifyDownloadedRelease(release, archiveBytes, manifestBytes) {
  const metadata = JSON.parse(manifestBytes.toString("utf8"));
  validateMetadata(metadata, archiveBytes);
  if (
    metadata.sourceRef !== release.target_commitish ||
    "uniflow-production-" + metadata.workflowRun !== release.tag_name
  )
    throw Error("Release source or workflow run does not match its metadata");
  const state = inspectRelease(
    { status: 200, body: release },
    {
      sourceRef: metadata.sourceRef,
      tag: release.tag_name,
      assets: releaseAssets(archiveBytes, manifestBytes),
    },
  );
  if (state.kind !== "published")
    throw Error("Downloaded production release is not published and locked");
  verifyArchiveIdentity(archiveBytes, metadata);
  return metadata;
}
export function safeTarEntries(listing) {
  const entries = listing.split(/\r?\n/).filter(Boolean);
  if (!entries.length) throw new Error("Empty production archive");
  for (const entry of entries) {
    const name = entry.replace(/^\.\//, "");
    if (entry === "." || entry === "./") continue;
    if (
      isAbsolute(name) ||
      /^[A-Za-z]:/.test(name) ||
      /[\\:]/.test(name) ||
      [...name].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      name.split("/").some((part) => part === "..") ||
      name.split("/").some((part) => /[. ]$/.test(part) && part !== ".") ||
      /(^|\/)(?:\.git|\.env(?:\.[^/]*)?|node_modules)(?:\/|$)/i.test(name)
    )
      throw new Error("Unsafe production archive entry");
  }
  if (!entries.some((name) => name.replace(/^\.\//, "") === "index.html"))
    throw new Error("Production archive has no root document");
  return entries;
}
const INITIAL_PRODUCTION_SOURCE = "941852870a712807c020ec29752b19f1ce03aeee";

export function verifyPublishedSource(metadata, status, body) {
  if (
    metadata?.format !== "uniflow-production-v1" ||
    !/^[a-f0-9]{40}$/.test(metadata.sourceRef || "")
  )
    throw new Error("Invalid production source metadata");
  if (status === 404 && metadata.sourceRef === INITIAL_PRODUCTION_SOURCE)
    return true;
  if (
    status !== 200 ||
    body?.format !== "uniflow-scope-v1" ||
    body.channel !== "production" ||
    !/^[a-f0-9]{40}$/.test(body.sourceRef || "") ||
    body.sourceRef !== metadata.sourceRef
  )
    throw new Error(
      "Published production does not match the archived release; refusing a root rollback.",
    );
  return true;
}

async function safeWorkspaceTarget(target) {
  const workspace = resolve(process.cwd());
  const output = resolve(target);
  if (output === workspace || !output.startsWith(workspace + sep))
    throw new Error("Production base must be inside this workspace");
  const actualWorkspace = await realpath(workspace);
  let ancestor = workspace;
  for (const segment of relative(workspace, output).split(sep)) {
    ancestor = resolve(ancestor, segment);
    try {
      if ((await lstat(ancestor)).isSymbolicLink())
        throw new Error("Production base paths cannot contain symbolic links");
      const actual = await realpath(ancestor);
      if (
        actual !== actualWorkspace &&
        !actual.startsWith(actualWorkspace + sep)
      )
        throw new Error("Production base escapes the workspace");
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
  }
  return output;
}

export async function extractProductionBase(archivePath, metadata, target) {
  const archive = await readFile(archivePath);
  if (archive.length > 64 * 1024 * 1024)
    throw new Error("Production archive is too large");
  validateMetadata(metadata, archive);
  verifyArchiveIdentity(archive, metadata);
  const output = await safeWorkspaceTarget(target);
  await mkdir(dirname(output), { recursive: true });
  await safeWorkspaceTarget(output);
  const staging = await mkdtemp(
    resolve(dirname(output), ".production-verified-"),
  );
  await safeWorkspaceTarget(staging);
  try {
    try {
      execFileSync("tar", ["-xf", "-", "-C", staging], {
        input: archive,
        stdio: "pipe",
      });
    } catch {
      throw Error("Production archive extraction failed.");
    }
    // Verify what the platform actually extracted before touching the old target.
    validateArtifactRelease(
      parseArtifactRelease(await readFile(resolve(staging, "release.json"))),
      metadata.sourceRef,
    );
    await writeFile(
      resolve(staging, ".uniflow-production-base.json"),
      JSON.stringify(metadata, null, 2),
    );
    // Recheck every ancestor immediately before recursive removal. A lexical
    // child path alone does not protect a pre-existing junction/symlink.
    await safeWorkspaceTarget(output);
    await rm(output, { recursive: true, force: true });
    await rename(staging, output);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return metadata;
}

async function main() {
  const args = process.argv.slice(2);
  const repository = process.env.GITHUB_REPOSITORY || "xan-xz/schedule";
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository)
  )
    throw Error("Invalid repository");
  const releases = JSON.parse(
    execFileSync("gh", ["api", `repos/${repository}/releases?per_page=100`], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    }),
  );
  const release = selectLockedProductionRelease(releases);
  const output = resolve(
    args.includes("--output")
      ? args[args.indexOf("--output") + 1]
      : ".release/production-base",
  );
  const workspace = resolve(process.cwd());
  if (!output.startsWith(workspace + sep))
    throw Error("Unsafe production base target");
  await safeWorkspaceTarget(output);
  await mkdir(dirname(output), { recursive: true });
  const download = await mkdtemp(
    resolve(dirname(output), ".production-download-"),
  );
  if (!download.startsWith(dirname(output) + sep))
    throw Error("Unsafe download cleanup");
  await safeWorkspaceTarget(download);
  try {
    execFileSync(
      "gh",
      [
        "release",
        "download",
        release.tag_name,
        "--repo",
        repository,
        "--pattern",
        "production-site.tar",
        "--pattern",
        "production.json",
        "--dir",
        download,
      ],
      { stdio: "pipe" },
    );
    const manifestBytes = await readFile(resolve(download, "production.json"));
    const archiveBytes = await readFile(
      resolve(download, "production-site.tar"),
    );
    const metadata = verifyDownloadedRelease(
      release,
      archiveBytes,
      manifestBytes,
    );
    verifyProductionTag(
      parseGitHubLookup(
        spawnSync(
          "gh",
          [
            "api",
            "--include",
            "repos/" + repository + "/git/ref/tags/" + release.tag_name,
            "-H",
            "X-GitHub-Api-Version: 2026-03-10",
          ],
          { encoding: "utf8", maxBuffer: 1024 * 1024 },
        ),
      ),
      metadata.sourceRef,
      true,
    );
    const pages = JSON.parse(
      execFileSync("gh", ["api", `repos/${repository}/pages`], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      }),
    );
    const publishedUrl = new URL("release.json", pages.html_url);
    if (publishedUrl.protocol !== "https:")
      throw Error("Published Pages URL must use HTTPS");
    const published = await fetch(publishedUrl, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(15000),
    });
    const publishedBody =
      published.status === 200 ? await published.json() : null;
    verifyPublishedSource(metadata, published.status, publishedBody);
    await extractProductionBase(
      resolve(download, "production-site.tar"),
      metadata,
      output,
    );
    console.log(
      JSON.stringify({
        productionSource: metadata.sourceRef,
        release: release.tag_name,
        providerImmutable: true,
        output,
      }),
    );
  } finally {
    await rm(download, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
)
  await main();
