const categories = ["performance", "accessibility", "best-practices", "seo"];
const floors = Object.freeze({
  performance: 95,
  accessibility: 100,
  "best-practices": 95,
  seo: 90,
});
export function performanceRun(report, exitCode) {
  return {
    exitCode,
    categories: Object.fromEntries(
      categories.map((key) => [key, report?.categories?.[key]?.score * 100]),
    ),
    lcpMs: report?.audits?.["largest-contentful-paint"]?.numericValue,
    tbtMs: report?.audits?.["total-blocking-time"]?.numericValue,
    cls: report?.audits?.["cumulative-layout-shift"]?.numericValue,
  };
}
export function assessPerformanceRuns(runs) {
  const failures = [];
  if (runs.length !== 5) failures.push("Exactly five fresh runs are required");
  for (const [index, run] of runs.entries()) {
    if (run.exitCode !== 0) failures.push(`Run ${index + 1}: process failed`);
    if (
      categories.some(
        (key) =>
          !Number.isFinite(run.categories?.[key]) ||
          run.categories[key] < floors[key] ||
          run.categories[key] > 100,
      )
    )
      failures.push(`Run ${index + 1}: category budget failed`);
    if (
      !Number.isFinite(run.lcpMs) ||
      run.lcpMs <= 0 ||
      !Number.isFinite(run.tbtMs) ||
      run.tbtMs < 0 ||
      run.cls !== 0
    )
      failures.push(`Run ${index + 1}: invalid metrics or layout shift`);
  }
  const validLcp = runs
    .map((run) => run.lcpMs)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  const medianLcpMs =
    runs.length === 5 && validLcp.length === 5 ? validLcp[2] : null;
  if (medianLcpMs === null || medianLcpMs > 1000)
    failures.push("Median mobile LCP must be at most 1000 ms");
  const medianCategories = Object.fromEntries(
    categories.map((key) => {
      const values = runs
        .map((run) => run.categories?.[key])
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      return [key, runs.length === 5 && values.length === 5 ? values[2] : null];
    }),
  );
  if (categories.some((key) => medianCategories[key] !== 100))
    failures.push("Every category median must score 100");
  return {
    gatePassed: failures.length === 0,
    medianLcpMs,
    medianCategories,
    floors,
    failures,
    runs,
  };
}
