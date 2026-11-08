import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performanceRun, assessPerformanceRuns } from "./lighthouse-policy.mjs";

const url = process.argv[2] || "http://127.0.0.1:4174/schedule/";
const parent = resolve(
  process.env.LH_REPORT_DIR || join(tmpdir(), "uniflow-lighthouse"),
);
await mkdir(parent, { recursive: true });
// Every invocation retains its own five original reports, including failures.
const directory = await mkdtemp(join(parent, "batch-"));
const script = fileURLToPath(new URL("./lighthouse.mjs", import.meta.url));
const runs = [];
for (let run = 1; run <= 5; run++) {
  const path = join(directory, `run-${run}.json`);
  const child = spawnSync(globalThis.process.execPath, [script, url], {
    env: { ...globalThis.process.env, LH_OUTPUT: path },
    stdio: "inherit",
  });
  let report;
  try {
    report = JSON.parse(await readFile(path, "utf8"));
  } catch {
    /* Missing/malformed reports fail the policy. */
  }
  runs.push({ run, report: path, ...performanceRun(report, child.status) });
}
const summary = {
  url,
  method:
    "Five sequential fresh Chrome profiles; every original report retained; no retries",
  ...assessPerformanceRuns(runs),
};
await writeFile(
  join(directory, "summary.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
console.log(JSON.stringify(summary, null, 2));
if (!summary.gatePassed) process.exitCode = 1;
