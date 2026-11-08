import test from "node:test";
import assert from "node:assert/strict";
import {
  assessPerformanceRuns,
  performanceRun,
} from "../scripts/lighthouse-policy.mjs";
const run = (lcpMs) => ({
  exitCode: 0,
  categories: {
    performance: 100,
    accessibility: 100,
    "best-practices": 100,
    seo: 100,
  },
  lcpMs,
  tbtMs: 0,
  cls: 0,
});
test("five original runs use the median, retaining slow outliers and the exact 1000 ms boundary", () => {
  const runs = [900, 2000, 1000, 950, 1500].map(run);
  const result = assessPerformanceRuns(runs);
  assert.equal(result.gatePassed, true);
  assert.equal(result.medianLcpMs, 1000);
  assert.deepEqual(result.runs, runs);
});
test("the previous all-100 release still fails its strict LCP target", () => {
  const result = assessPerformanceRuns([1261, 1263, 962, 958, 1269].map(run));
  assert.equal(result.gatePassed, false);
  assert.equal(result.medianLcpMs, 1261);
});
test("one 99 performance score is retained while medians and every original budget remain satisfied", () => {
  const runs = [783, 785, 780, 770, 773].map(run);
  runs[3].categories.performance = 99;
  runs[3].tbtMs = 92;
  const result = assessPerformanceRuns(runs);
  assert.equal(result.gatePassed, true);
  assert.equal(result.medianCategories.performance, 100);
  assert.deepEqual(result.runs, runs);
  assert.equal(result.runs[3].tbtMs, 92);
});
test("a reduced median or any original per-run budget violation still blocks publication", () => {
  for (const [key, below] of [
    ["performance", 94],
    ["accessibility", 99],
    ["best-practices", 94],
    ["seo", 89],
  ]) {
    const runs = Array.from({ length: 5 }, () => run(800));
    runs[0].categories[key] = below;
    assert.equal(assessPerformanceRuns(runs).gatePassed, false);
  }
  for (const key of ["performance", "best-practices", "seo"]) {
    const runs = Array.from({ length: 5 }, () => run(800));
    for (const entry of runs.slice(0, 3)) entry.categories[key] = 99;
    assert.equal(assessPerformanceRuns(runs).gatePassed, false);
  }
});
test("missing runs, malformed metrics, nonzero exits and a single reduced category or shift fail", () => {
  const good = Array.from({ length: 5 }, () => run(800));
  const malformed = performanceRun({}, 0);
  for (const bad of [
    good.slice(0, 4),
    [...good, run(800)],
    [malformed, ...good.slice(1)],
    [{ ...run(800), exitCode: 1 }, ...good.slice(1)],
    [{ ...run(800), cls: 0.01 }, ...good.slice(1)],
    [
      {
        ...run(800),
        categories: { ...run(800).categories, accessibility: 99 },
      },
      ...good.slice(1),
    ],
    [run(NaN), ...good.slice(1)],
  ]) {
    assert.equal(assessPerformanceRuns(bad).gatePassed, false);
  }
});
