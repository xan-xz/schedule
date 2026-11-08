import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { isGroupActive } from "../backend/group-state.mjs";
import {
  INITIAL_SNAPSHOT_ID,
  INITIAL_SNAPSHOT_FORMAT,
  MAX_INITIAL_SNAPSHOT_BYTES,
  projectInitialSnapshot,
} from "../app/lib/initial-snapshot.mjs";

export const MAX_INITIAL_DOCUMENT_GZIP = 60 * 1024;
const ownerRouteCode = (
  await readFile(new URL("../app/owner-route.js", import.meta.url), "utf8")
).replace(/\r\n?/g, "\n");
function prependOwnerRoute(html) {
  const code = ownerRouteCode;
  const hash =
    "'sha256-" + createHash("sha256").update(code).digest("base64") + "'";
  if (!/script-src [^;]+;/.test(html))
    throw Error("Early owner route requires strict CSP");
  return html
    .replace(
      /<script\b[^>]*\bsrc=["']\.\/owner-route\.js["'][^>]*>\s*<\/script>/i,
      "",
    )
    .replace(
      /script-src ([^;]+);/,
      (_all, policy) => `script-src ${policy} ${hash};`,
    )
    .replace(
      /<script\b/,
      () => `<script data-owner-route>${code}</script>\n<script`,
    );
}
const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
export function renderInitialChoice(snapshot) {
  const groups = snapshot.data.groups.filter(isGroupActive);
  if (!groups.length) return null;
  const subgroups = [
    ...new Set(groups.flatMap((group) => group.subgroups || [])),
    "all",
  ];
  return `<h1 tabindex="-1">Выбери свою группу</h1><p class="notice">Выбор сохранится на этом устройстве. Потом группу можно изменить в «Ещё».</p><form class="settings-section" data-initial-choice method="get" action="./"><label class="field"><span>Найти группу</span><input type="search" autocomplete="off" placeholder="Найти группу" data-choice-search></label><label class="field"><span>Группа</span><select name="g" required><option value="">Выбери группу</option>${groups.map((group) => `<option value="${escapeHtml(group.id)}" data-search="${escapeHtml(group.name + " " + (group.specialty || ""))}" data-subgroups="${escapeHtml(JSON.stringify(group.subgroups || []))}">${escapeHtml(group.name)}</option>`).join("")}</select></label><label class="field initial-choice-subgroup"><span>Подгруппа</span><select name="subgroup" required>${subgroups.map((value) => `<option value="${escapeHtml(value)}">${value === "all" ? "Обе" : escapeHtml(value)}</option>`).join("")}</select></label><button type="submit" class="primary wide">Сохранить и открыть расписание</button><p role="alert" class="form-error"></p></form>`;
}
export function serializeInertSnapshot(snapshot) {
  return JSON.stringify({
    format: INITIAL_SNAPSHOT_FORMAT,
    snapshot: projectInitialSnapshot(snapshot),
  }).replace(
    /[<>&\u2028\u2029]/g,
    (character) =>
      "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}
export async function inlineReleaseSnapshot(directory) {
  const path = resolve(directory, "index.html");
  let html = await readFile(path, "utf8");
  if (!/<script\b[^>]*\btype=["']module["']/i.test(html)) return false;
  html = prependOwnerRoute(html);
  const input = await readFile(resolve(directory, "bootstrap.json"), "utf8");
  if (Buffer.byteLength(input) > 4 * MAX_INITIAL_SNAPSHOT_BYTES)
    throw Error("Public release snapshot exceeds supported input size");
  let decoded;
  try {
    decoded = JSON.parse(input);
  } catch {
    throw Error("Invalid public release snapshot JSON");
  }
  const snapshot = projectInitialSnapshot(decoded);
  const inert = serializeInertSnapshot(snapshot);
  if (!html.includes("</head>") || html.includes(`id="${INITIAL_SNAPSHOT_ID}"`))
    throw Error("Initial public snapshot target is invalid");
  let initialChoiceRendered = false;
  const choice = renderInitialChoice(snapshot);
  if (
    choice &&
    /<main\b[^>]*\bid=["']main["'][^>]*>[\s\S]*?<\/main>/i.test(html)
  ) {
    const prerendered = html
      .replace(
        /(<main\b[^>]*\bid=["']main["'][^>]*>)[\s\S]*?(<\/main>)/i,
        (_all, start, end) => start + choice + end,
      )
      .replace(
        /(<p\b[^>]*\bid=["']identity["'][^>]*>)[\s\S]*?(<\/p>)/i,
        (_all, start, end) => start + "Выбери группу" + end,
      );
    if (gzipSync(prerendered).length <= MAX_INITIAL_DOCUMENT_GZIP) {
      html = prerendered;
      initialChoiceRendered = true;
    }
  }
  const candidate = html
    .replace(
      /<link\b(?=[^>]*\brel=["']preload["'])(?=[^>]*\bhref=["']\.\/bootstrap\.json["'])[^>]*>/gi,
      "",
    )
    .replace(
      "</head>",
      `<script type="application/json" id="${INITIAL_SNAPSHOT_ID}">${inert}</script>\n</head>`,
    );
  await writeFile(
    resolve(directory, "bootstrap.json"),
    JSON.stringify(snapshot) + "\n",
  );
  const embedded =
    Buffer.byteLength(inert) <= MAX_INITIAL_SNAPSHOT_BYTES &&
    gzipSync(candidate).length <= MAX_INITIAL_DOCUMENT_GZIP;
  if (embedded) html = candidate;
  // The routing guard and real native chooser remain useful when the complete
  // public data exceeds the inline budget and must stay in bootstrap.json.
  await writeFile(path, html);
  return {
    embedded,
    initialChoiceRendered,
    ...(embedded
      ? {}
      : { reason: "initial_document_budget", externalSnapshotComplete: true }),
    initialSnapshotBytes: Buffer.byteLength(inert),
    initialSnapshotGzip: gzipSync(inert).length,
    initialDocumentGzip: gzipSync(html).length,
  };
}
