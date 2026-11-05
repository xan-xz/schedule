import { defineConfig, devices } from "@playwright/test";
const release = process.env.RELEASE_CHANNEL === "production";
const port = release ? 4175 : 4173;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  workers: 2,
  outputDir: release ? "test-results/production" : "test-results/source",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    timezoneId: "Pacific/Honolulu",
    ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
  },
  projects: [
    {
      name: "mobile-360",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 360, height: 800 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "mobile-390",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 900 },
      },
    },
  ],
  webServer: {
    command: `node scripts/serve.mjs --port ${port} --root ${process.env.PW_SERVER_ROOT === "dist" ? "dist" : "."}`,
    url: `http://127.0.0.1:${port}/schedule/beta/`,
    reuseExistingServer: !process.env.CI && !release,
  },
});
