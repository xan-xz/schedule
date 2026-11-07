import lighthouse from "lighthouse";
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const url = process.argv[2] || "http://127.0.0.1:4173/schedule/";
const output =
  process.env.LH_OUTPUT || resolve(tmpdir(), "uniflow.lighthouse.json");
const profile = await mkdtemp(resolve(tmpdir(), "uniflow-lighthouse-"));
const chromePath = process.env.CHROME_PATH || chromium.executablePath();
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--remote-debugging-port=9223",
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch("http://127.0.0.1:9223/json/version");
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      /* Wait for browser endpoint. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready)
    throw new Error(
      "Chrome debugging endpoint did not start; set CHROME_PATH if needed.",
    );
  const result = await lighthouse(url, {
    port: 9223,
    output: "json",
    logLevel: "error",
    onlyCategories: ["performance", "accessibility", "best-practices", "seo"],
    formFactor: "mobile",
    screenEmulation: {
      mobile: true,
      width: 360,
      height: 800,
      deviceScaleFactor: 1,
      disabled: false,
    },
    throttling: {
      rttMs: 150,
      throughputKbps: 1638.4,
      cpuSlowdownMultiplier: 4,
      requestLatencyMs: 562.5,
      downloadThroughputKbps: 1474.56,
      uploadThroughputKbps: 675,
    },
  });
  await writeFile(output, result.report);
  const categories = Object.fromEntries(
    Object.entries(result.lhr.categories).map(([id, category]) => [
      id,
      category.score * 100,
    ]),
  );
  const metrics = Object.fromEntries(
    [
      "first-contentful-paint",
      "largest-contentful-paint",
      "speed-index",
      "total-blocking-time",
      "cumulative-layout-shift",
    ].map((id) => [id, result.lhr.audits[id]?.numericValue]),
  );
  console.log(
    JSON.stringify(
      {
        url,
        report: output,
        lighthouseVersion: result.lhr.lighthouseVersion,
        categories,
        metrics,
      },
      null,
      2,
    ),
  );
  if (
    categories.performance < 95 ||
    categories.accessibility < 100 ||
    categories["best-practices"] < 95 ||
    categories.seo < 90
  )
    process.exitCode = 1;
} finally {
  chrome.kill();
  await new Promise((resolve) => chrome.once("exit", resolve));
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 4,
    retryDelay: 250,
  });
}
