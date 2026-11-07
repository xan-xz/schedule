import { test, expect } from "@playwright/test";
import { mockState } from "./fixtures.mjs";

test("current lesson changes at its exact minute boundary without a manual refresh", async ({
  page,
}) => {
  const requests = await mockState(page, {
    time: new Date("2026-11-06T04:49:00Z"),
    ticking: true,
  });
  // Navigation can take longer than 250 ms on CI. Pause before loading the
  // application so only runFor advances across the boundary being tested.
  await page.clock.pauseAt(new Date("2026-11-06T04:49:59.750Z"));
  await page.goto("/schedule/beta/");
  await expect(
    page
      .locator(".hero")
      .getByRole("heading", { name: "Алгоритмы", exact: true }),
  ).toBeVisible();
  await page.clock.runFor(300);
  await expect(
    page
      .locator(".hero")
      .getByRole("heading", { name: "Сейчас свободно", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#announcement")).toHaveText("Сейчас свободно");
  expect(requests.every((req) => req.action === "state")).toBe(true);
});
