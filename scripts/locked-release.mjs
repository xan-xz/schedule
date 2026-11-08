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

export function parseGitHubLookup(result) {
  if (result.error || result.signal || typeof result.stdout !== "string")
    throw Error("GitHub release lookup failed before a valid HTTP response.");
  const raw = result.stdout.replace(/\r\n/g, "\n");
  const boundary = raw.indexOf("\n\n");
  const status = Number(/^HTTP\/[\d.]+ (\d{3})(?: |\n)/.exec(raw)?.[1]);
  if (boundary < 0 || ![200, 404].includes(status))
    throw Error("Unexpected GitHub release lookup HTTP status.");
  let body;
  try {
    body = JSON.parse(raw.slice(boundary + 2));
  } catch {
    throw Error("GitHub release lookup did not return valid JSON.");
  }
  if (status === 200 && result.status !== 0)
    throw Error("GitHub release lookup failed despite HTTP 200.");
  if (
    status === 404 &&
    (result.status !== 1 ||
      typeof body?.message !== "string" ||
      (body.status !== undefined && String(body.status) !== "404"))
  )
    throw Error("Malformed GitHub release absence response.");
  return { status, body };
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
  ...expected
}) {
  expectations(expected);
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
    state = inspectRelease(await lookup(), expected);
    if (state.kind === "missing")
      throw failure || Error("Draft creation was not confirmed.");
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
    state = inspectRelease(await lookup(), expected);
    if (state.kind === "published") return "existing";
    if (
      state.kind !== "draft" ||
      state.missing.some((item) => item.name === asset.name)
    )
      throw failure || Error("Asset upload was not confirmed.");
  }
  if (state.kind !== "draft" || state.missing.length)
    throw Error("Complete draft verification is required before publication.");
  let failure;
  try {
    await publish();
  } catch (error) {
    failure = error;
  }
  state = inspectRelease(await lookup(), expected);
  if (state.kind !== "published")
    throw failure || Error("Immutable release publication was not confirmed.");
  return startedMissing ? "created" : "completed";
}
