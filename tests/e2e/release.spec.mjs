import { test, expect } from "@playwright/test";
import { mockState } from "./fixtures.mjs";

test.describe("production artifact promotion", () => {
  test.skip(
    process.env.RELEASE_CHANNEL !== "production",
    "Runs only against the explicitly built production artifact.",
  );

  test("root and retained beta/demo addresses render the same student application", async ({
    page,
  }) => {
    const requests = await mockState(page);
    for (const path of ["/schedule/", "/schedule/beta/"]) {
      await page.goto(path);
      await expect(
        page.getByRole("heading", { name: "Алгоритмы", exact: true }).first(),
      ).toBeVisible();
      await expect(
        page.getByRole("navigation", { name: "Основные разделы", exact: true }),
      ).toBeVisible();
    }
    for (const path of [
      "/schedule/?demo=student",
      "/schedule/beta/?demo=student",
    ]) {
      await page.goto(path);
      await expect(
        page.getByRole("button", { name: "Сегодня", exact: true }),
      ).toBeVisible();
      await expect(page.locator("#identity")).toContainText("Демо");
    }
    expect(requests.every((req) => req.action === "state")).toBe(true);
  });

  test("root offline shell and staff lazy route work after service worker activation", async ({
    page,
    context,
  }) => {
    await mockState(page);
    await page.goto("/schedule/");
    await expect(
      page.getByRole("heading", { name: "Алгоритмы", exact: true }).first(),
    ).toBeVisible();
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.waitForFunction(
      () => navigator.serviceWorker.controller !== null,
    );
    await context.setOffline(true);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Алгоритмы", exact: true }).first(),
    ).toBeVisible();
    await context.setOffline(false);
    await page.goto("/schedule/manage/?demo=admin");
    await expect(
      page.getByRole("button", { name: "Создать черновик", exact: true }),
    ).toBeVisible();
    await page.locator('[data-page="schedule"]').click();
    await expect(
      page.locator('[data-action="exception"]').first(),
    ).toBeVisible();
  });
});
