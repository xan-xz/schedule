import { createHash } from "node:crypto";

const names = ["production-site.tar", "production.json"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function releaseAssets(archive, manifest) {
  return [archive, manifest].map((bytes, index) => ({
    name: names[index],
    size: bytes.length,
    sha256: sha256(bytes),
  }));
}

/** target_commitish is ignored by GitHub when a tag already exists. Generated
 * production tags must therefore be checked against the actual Git ref too. */
export function verifyProductionTag(result, sourceRef, required = false) {
  if (!/^[a-f0-9]{40}$/.test(sourceRef || ""))
    throw Error("Invalid pinned source");
  if (
    result.status === 404 &&
    !required &&
    typeof result.body?.message === "string"
  )
    return;
  if (
    result.status !== 200 ||
    result.body?.object?.type !== "commit" ||
    result.body.object.sha !== sourceRef
  )
    throw Error(
      "Production Git tag does not point to the verified source commit.",
    );
}

function parseGitHubResponse(result, successStatus, allowAbsence) {
  if (result.error || result.signal || typeof result.stdout !== "string")
    throw Error("GitHub release lookup failed before a valid HTTP response.");
  const raw = result.stdout.replace(/\r\n/g, "\n");
  const boundary = raw.indexOf("\n\n");
  const status = Number(/^HTTP\/[\d.]+ (\d{3})(?: |\n)/.exec(raw)?.[1]);
  if (
    boundary < 0 ||
    !(status === successStatus || (allowAbsence && status === 404))
  )
    throw Error("Unexpected GitHub release lookup HTTP status.");
  let body;
  try {
    body = JSON.parse(raw.slice(boundary + 2));
  } catch {
    throw Error("GitHub release lookup did not return valid JSON.");
  }
  if (status === successStatus && result.status !== 0)
    throw Error(
      "GitHub release lookup failed despite HTTP " + successStatus + ".",
    );
  if (
    status === 404 &&
    (result.status !== 1 ||
      typeof body?.message !== "string" ||
      (body.status !== undefined && String(body.status) !== "404"))
  )
    throw Error("Malformed GitHub release absence response.");
  return { status, body };
}

export function parseGitHubLookup(result) {
  return parseGitHubResponse(result, 200, true);
}
/** Preserve the numeric identity acknowledged by the successful POST. */
export function parseGitHubCreatedDraft(result, expected) {
  const created = parseGitHubResponse(result, 201, false);
  if (
    !Number.isSafeInteger(created.body?.id) ||
    created.body.id <= 0 ||
    inspectRelease({ status: 200, body: created.body }, expected).kind !==
      "draft"
  )
    throw Error("Created draft identity is invalid.");
  return created.body.id;
}

/** The tag endpoint exposes published releases only. A 404 is not evidence
 * that an authenticated same-tag draft is absent. Enumerate every page before
 * creating, then fetch the matching draft by its numeric release ID. */
export async function lookupReleaseIncludingDrafts({
  tag,
  lookupPublished,
  listPages,
  lookupById,
  releaseId = null,
}) {
  if (!/^uniflow-production-\d+$/.test(tag || ""))
    throw Error("Invalid production tag");
  if (releaseId !== null) {
    if (!Number.isSafeInteger(releaseId) || releaseId <= 0)
      throw Error("Invalid pinned release ID.");
    const found = parseGitHubLookup(await lookupById(releaseId));
    if (
      found.status === 200 &&
      (found.body?.id !== releaseId || found.body.tag_name !== tag)
    )
      throw Error("Pinned release identity changed during lookup.");
    return found;
  }
  const published = parseGitHubLookup(await lookupPublished());
  if (published.status === 200) return published;
  const result = await listPages();
  if (
    result.error ||
    result.signal ||
    result.status !== 0 ||
    typeof result.stdout !== "string"
  )
    throw Error("Complete authenticated draft lookup failed.");
  let pages;
  try {
    pages = JSON.parse(result.stdout);
  } catch {
    throw Error("Invalid release pagination response.");
  }
  if (
    !Array.isArray(pages) ||
    !pages.length ||
    pages.some((page) => !Array.isArray(page))
  )
    throw Error("Incomplete release pagination response.");
  const rows = pages.flat();
  if (rows.some((row) => !row || typeof row.tag_name !== "string"))
    throw Error("Malformed release list.");
  const matches = rows.filter((row) => row.tag_name === tag);
  if (!matches.length) return published;
  if (
    matches.length !== 1 ||
    !Number.isSafeInteger(matches[0].id) ||
    matches[0].id <= 0
  )
    throw Error("Ambiguous production draft identity.");
  const found = parseGitHubLookup(await lookupById(matches[0].id));
  if (
    found.status !== 200 ||
    found.body?.tag_name !== tag ||
    found.body?.id !== matches[0].id
  )
    throw Error("Production draft identity changed during lookup.");
  return found;
}

function expectations({ sourceRef, tag, assets }) {
  if (
    !/^[a-f0-9]{40}$/.test(sourceRef || "") ||
    !/^uniflow-production-\d+$/.test(tag || "") ||
    !Array.isArray(assets) ||
    assets.length !== 2 ||
    names.some(
      (name) => assets.filter((asset) => asset.name === name).length !== 1,
    ) ||
    assets.some(
      (asset) =>
        !Number.isSafeInteger(asset.size) ||
        asset.size <= 0 ||
        asset.size >
          (asset.name === "production.json" ? 8192 : 64 * 1024 * 1024) ||
        !/^[a-f0-9]{64}$/.test(asset.sha256 || ""),
    )
  )
    throw Error("Invalid pinned production release expectations.");
}

/** A draft can be resumed without replacing an existing byte. A published
 * release is accepted only with the provider lock and both exact digests. */
export function inspectRelease({ status, body }, expected) {
  expectations(expected);
  if (status === 404) {
    if (
      typeof body?.message !== "string" ||
      (body.status !== undefined && String(body.status) !== "404")
    )
      throw Error("Release absence is not confirmed.");
    return { kind: "missing", missing: expected.assets };
  }
  if (
    status !== 200 ||
    body?.tag_name !== expected.tag ||
    body?.target_commitish !== expected.sourceRef ||
    typeof body.draft !== "boolean" ||
    body.prerelease !== false ||
    !Array.isArray(body.assets)
  )
    throw Error("Release identity or publication state does not match.");
  const present = new Set();
  for (const asset of body.assets) {
    const local = expected.assets.find((item) => item.name === asset.name);
    if (
      !local ||
      present.has(asset.name) ||
      asset.size !== local.size ||
      asset.state !== "uploaded" ||
      asset.digest !== "sha256:" + local.sha256
    )
      throw Error("Existing release asset differs from the verified artifact.");
    present.add(asset.name);
  }
  const missing = expected.assets.filter((item) => !present.has(item.name));
  if (body.draft) {
    if (body.immutable === true)
      throw Error("Unexpected lock on an unpublished release.");
    return { kind: "draft", missing };
  }
  if (missing.length || body.immutable !== true)
    throw Error(
      "Published release must contain both artifacts and be immutable.",
    );
  return { kind: "published", missing: [] };
}

/** Every write is followed by an authoritative read. A lost response may be
 * reconciled with positive evidence; it never triggers a blind repeated write.
 * No deletion, replacement, clobber, tag movement or publication of bad bytes. */
export async function ensureLockedRelease({
  lookup,
  createDraft,
  upload,
  publish,
  pause = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ...expected
}) {
  expectations(expected);
  // Provider reads may briefly lag a successful write. Retry reads only;
  // every candidate still passes the complete identity/digest/lock checks.
  const confirm = async (accepted, message, failure) => {
    const delays = [0, 100, 250, 500, 1000];
    for (const delay of delays) {
      if (delay) await pause(delay);
      const candidate = inspectRelease(await lookup(), expected);
      if (accepted(candidate)) return candidate;
    }
    throw failure || Error(message);
  };
  let state = inspectRelease(await lookup(), expected);
  if (state.kind === "published") return "existing";
  const startedMissing = state.kind === "missing";
  if (startedMissing) {
    let failure;
    try {
      await createDraft();
    } catch (error) {
      failure = error;
    }
    state = await confirm(
      (candidate) => candidate.kind !== "missing",
      "Draft creation was not confirmed.",
      failure,
    );
    if (state.kind === "published") return "existing";
  }
  for (const asset of expected.assets) {
    if (!state.missing.some((item) => item.name === asset.name)) continue;
    let failure;
    try {
      await upload(asset.name);
    } catch (error) {
      failure = error;
    }
    state = await confirm(
      (candidate) =>
        candidate.kind === "published" ||
        (candidate.kind === "draft" &&
          !candidate.missing.some((item) => item.name === asset.name)),
      "Asset upload was not confirmed.",
      failure,
    );
    if (state.kind === "published") return "existing";
  }
  if (state.kind !== "draft" || state.missing.length)
    throw Error("Complete draft verification is required before publication.");
  let failure;
  try {
    await publish();
  } catch (error) {
    failure = error;
  }
  state = await confirm(
    (candidate) => candidate.kind === "published",
    "Immutable release publication was not confirmed.",
    failure,
  );
  return startedMissing ? "created" : "completed";
}
