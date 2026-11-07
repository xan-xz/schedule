import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { mockManager } from "./manager-fixture.mjs";

const require = createRequire(import.meta.url);

test("staff overview, schedule and guide remain accessible in both themes", async ({
  page,
}) => {
  const manager = await mockManager(page);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await manager.login();
  await expect(
    page.getByRole("button", { name: "Создать черновик", exact: true }),
  ).toBeVisible();
  await page.evaluate(
    await readFile(require.resolve("axe-core/axe.min.js"), "utf8"),
  );
  for (const theme of ["light", "dark"]) {
    if (theme === "dark") {
      await page.locator('[data-action="profile"]').first().click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Светлая / тёмная тема", exact: true })
        .click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Закрыть", exact: true })
        .click();
    }
    for (const section of ["overview", "schedule", "guide"]) {
      await page.locator(`[data-page="${section}"]`).click();
      const violations = await page.evaluate(async () =>
        (
          await globalThis.axe.run(document, {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
          })
        ).violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => n.target),
        })),
      );
      expect(violations, theme + " " + section).toEqual([]);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(page.viewportSize().width);
    }
    await page.locator('[data-page="schedule"]').click();
    await page
      .getByRole("button", { name: "Создать черновик", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Предпросмотр студента", exact: true })
      .click();
    const dialogViolations = await page.evaluate(async () =>
      (
        await globalThis.axe.run(document, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
        })
      ).violations.map((violation) => ({
        id: violation.id,
        nodes: violation.nodes.map((node) => ({
          target: node.target,
          summary: node.failureSummary,
        })),
      })),
    );
    expect(dialogViolations, theme + " draft preview").toEqual([]);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Закрыть", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Отменить черновик", exact: true })
      .click();
  }
  expect(pageErrors).toEqual([]);
});
