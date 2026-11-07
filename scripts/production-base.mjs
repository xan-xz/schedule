import { execFileSync } from "node:child_process";
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
  const listing = execFileSync("tar", ["-tf", archivePath], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  safeTarEntries(listing);
  const details = execFileSync("tar", ["-tvf", archivePath], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (details.split(/\r?\n/).some((line) => line && !/^[d-]/.test(line)))
    throw new Error("Production archive links/special files are forbidden");
  const output = await safeWorkspaceTarget(target);
  await mkdir(dirname(output), { recursive: true });
  await safeWorkspaceTarget(output);
  const staging = await mkdtemp(
    resolve(dirname(output), ".production-verified-"),
  );
  await safeWorkspaceTarget(staging);
  try {
    execFileSync("tar", ["-xf", resolve(archivePath), "-C", staging], {
      stdio: "pipe",
    });
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
  const release = releases
    .filter(
      (r) =>
        !r.draft &&
        !r.prerelease &&
        /^uniflow-production-\d+$/.test(r.tag_name),
    )
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
  if (!release)
    throw Error(
      "No verified production release exists. Refusing to restore the archived root.",
    );
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
    const metadata = JSON.parse(
      await readFile(resolve(download, "production.json"), "utf8"),
    );
    if (metadata.sourceRef !== release.target_commitish)
      throw Error("Release source does not match immutable metadata");
    validateMetadata(
      metadata,
      await readFile(resolve(download, "production-site.tar")),
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
