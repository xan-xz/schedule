import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { mockState } from "./fixtures.mjs";

const require = createRequire(import.meta.url);
const axePath = require.resolve("axe-core/axe.min.js");

test("first screen answers current and next room without a tap", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mockState(page);
  await page.goto("/schedule/beta/");
  await expect(
    page.getByRole("navigation", { name: /Основная|Разделы|Навигация/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Алгоритмы", exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText(/204/).first()).toBeVisible();
  const next = page.getByText("Операционные системы", { exact: true }).first();
  await expect(next).toBeVisible();
  const box = await next.boundingBox();
  expect(box.y).toBeLessThan(page.viewportSize().height);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("all four student screens have no WCAG A/AA violations", async ({
  page,
}) => {
  await mockState(page);
  await page.goto("/schedule/beta/");
  await expect(
    page.getByText("Алгоритмы", { exact: true }).first(),
  ).toBeVisible();
  await page.addScriptTag({ path: axePath });
  for (const label of ["Сегодня", "Неделя", "Задания", "Ещё"]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    const violations = await page.evaluate(async () =>
      (
        await globalThis.axe.run(document, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
        })
      ).violations.map((item) => ({
        id: item.id,
        impact: item.impact,
        nodes: item.nodes.map((node) => node.target),
      })),
    );
    expect(violations, label).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
});

test("demo never sends a production mutation", async ({ page }) => {
  const requests = await mockState(page);
  await page.goto("/schedule/beta/?demo=student");
  await expect(
    page.getByRole("button", { name: "Сегодня", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Неделя", exact: true }).click();
  await page.getByRole("button", { name: "Задания", exact: true }).click();
  await page.getByRole("button", { name: "Ещё", exact: true }).click();
  expect(requests).toEqual([]);
});

test("offline reload uses a public IndexedDB snapshot and cached application", async ({
  page,
  context,
}) => {
  await mockState(page);
  await page.goto("/schedule/beta/");
  await expect(
    page.getByText("Алгоритмы", { exact: true }).first(),
  ).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByText("Алгоритмы", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText(/Офлайн/).first()).toBeVisible();
  await page.getByRole("button", { name: "Неделя", exact: true }).click();
  await expect(
    page.getByText("Операционные системы", { exact: true }).first(),
  ).toBeVisible();
  await context.setOffline(false);
});
