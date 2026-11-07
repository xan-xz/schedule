import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FORBIDDEN = /beta|demo|бета|демо/giu;
const historicalFiles = new Set([
  "compatibility.json",
  "dist/compatibility.json",
  "docs/REMOVAL_INVENTORY.md",
  "CHANGELOG.md",
]);
const ignoredDirectories = new Set([
  "node_modules",
  ".git",
  ".release",
  "test-results",
  "playwright-report",
  "coverage",
]);
const binaryAsset =
  /\.(?:png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip|xlsx?)$/iu;
const matches = (value) => [...value.matchAll(new RegExp(FORBIDDEN))];
const slash = (value) => value.replaceAll("\\", "/");
function validPath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !path.posix.isAbsolute(value) &&
    !value.includes("\\") &&
    !value.includes(":") &&
    !/[?*\n\r]/u.test(value) &&
    value.split("/").every((part) => part && part !== "." && part !== "..")
  );
}
function exceptionMap(manifest) {
  const entries = manifest?.retirementGuard?.exceptions;
  if (!Array.isArray(entries))
    throw new Error("retirementGuard.exceptions must be an array");
  const map = new Map();
  for (const entry of entries) {
    if (
      !validPath(entry?.path) ||
      map.has(entry.path) ||
      typeof entry.reason !== "string" ||
      !entry.reason.trim() ||
      !Array.isArray(entry.literals) ||
      (!entry.literals.length && !matches(entry.path).length) ||
      entry.literals.some(
        (line) =>
          typeof line !== "string" ||
          line !== line.trim() ||
          /[\n\r]/u.test(line) ||
          !matches(line).length,
      ) ||
      new Set(entry.literals).size !== entry.literals.length
    )
      throw new Error("Invalid or duplicate retirement exception");
    map.set(entry.path, new Set(entry.literals));
  }
  return map;
}
function ignored(relative, artifact = false) {
  const parts = relative.split("/");
  return (
    parts.some((part) => ignoredDirectories.has(part)) ||
    (!artifact && parts[0] === "dist")
  );
}
async function artifactPaths(directory, prefix = "dist") {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = prefix + "/" + entry.name;
    if (ignored(relative, true)) continue;
    if (entry.isDirectory())
      result.push(
        ...(await artifactPaths(path.join(directory, entry.name), relative)),
      );
    else result.push(relative);
  }
  return result;
}

/** Exact trimmed lines are the only code exceptions. A new word, route or
 * suffix on an approved line invalidates that exception. No regex/glob permits
 * an entire application file. This is a retirement check, not a secret scanner.
 */
export async function checkRetirement({
  root = process.cwd(),
  manifest,
  sourcePaths,
  requireDist = false,
} = {}) {
  root = path.resolve(root);
  manifest ??= JSON.parse(
    await fs.readFile(path.join(root, "compatibility.json"), "utf8"),
  );
  const exceptions = exceptionMap(manifest);
  sourcePaths ??= execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  const paths = new Set(
    sourcePaths.map(slash).filter((relative) => !ignored(relative)),
  );
  let hasDist = false;
  try {
    hasDist = (await fs.stat(path.join(root, "dist"))).isDirectory();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (hasDist)
    for (const relative of await artifactPaths(path.join(root, "dist")))
      paths.add(relative);
  const findings = [];
  if (requireDist && !hasDist)
    findings.push({ path: "dist", line: 0, code: "MISSING_ARTIFACT" });
  let scannedFiles = 0;
  for (const relative of [...paths].sort()) {
    if (!validPath(relative)) throw new Error("Unsafe source path");
    const absolute = path.resolve(root, relative);
    let stat;
    try {
      stat = await fs.lstat(absolute);
    } catch (error) {
      if (error.code === "ENOENT") continue; // staged source removal
      throw error;
    }
    if (stat.isSymbolicLink()) {
      findings.push({ path: relative, line: 0, code: "UNSCANNED_SYMLINK" });
      continue;
    }
    if (!stat.isFile()) continue;
    if (matches(relative).length && !exceptions.has(relative))
      findings.push({ path: relative, line: 0, code: "FORBIDDEN_PATH" });
    const bytes = await fs.readFile(absolute);
    if (bytes.includes(0)) {
      if (!binaryAsset.test(relative))
        findings.push({ path: relative, line: 0, code: "UNSCANNED_ENCODING" });
      continue;
    }
    let content;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      findings.push({ path: relative, line: 0, code: "UNSCANNED_ENCODING" });
      continue;
    }
    scannedFiles++;
    if (historicalFiles.has(relative)) continue;
    const approved = exceptions.get(relative) || new Set();
    const observed = new Set();
    for (const [index, line] of content.split(/\r?\n/u).entries()) {
      if (!matches(line).length) continue;
      if (approved.has(line.trim())) observed.add(line.trim());
      else
        findings.push({
          path: relative,
          line: index + 1,
          code: "FORBIDDEN_LITERAL",
        });
    }
    for (const literal of approved)
      if (!observed.has(literal))
        findings.push({ path: relative, line: 0, code: "STALE_EXCEPTION" });
  }
  return { ok: !findings.length, scannedFiles, artifact: hasDist, findings };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    const result = await checkRetirement({
      requireDist: process.argv.includes("--dist"),
    });
    for (const finding of result.findings)
      console.error(`${finding.path}:${finding.line} ${finding.code}`);
    console.log(
      `Retirement guard: ${result.ok ? "PASS" : "FAIL"}; ${result.scannedFiles} text files; artifact ${result.artifact ? "checked" : "absent"}`,
    );
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`Retirement guard: ${error.message}`);
    process.exitCode = 1;
  }
}
