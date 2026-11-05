import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { mockState } from "./fixtures.mjs";

const require = createRequire(import.meta.url);

test("staff overview, schedule and guide remain accessible in both themes", async ({
  page,
}) => {
  await mockState(page);
  await page.goto("/schedule/beta/manage/?demo=admin");
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
  }
});
