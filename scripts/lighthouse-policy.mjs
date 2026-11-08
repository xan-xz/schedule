const categories = ["performance", "accessibility", "best-practices", "seo"];
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
    if (categories.some((key) => run.categories?.[key] !== 100))
      failures.push(`Run ${index + 1}: every category must score 100`);
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
  return { gatePassed: failures.length === 0, medianLcpMs, failures, runs };
}
