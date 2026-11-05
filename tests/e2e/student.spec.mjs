import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
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
    page.getByRole("navigation", { name: "Основные разделы" }),
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
  // CDP evaluation runs the audit without weakening the application's strict CSP.
  await page.evaluate(await readFile(axePath, "utf8"));
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

test("personal assignment and own progress survive reload without a server write", async ({
  page,
}) => {
  const requests = await mockState(page);
  await page.goto("/schedule/beta/");
  await expect(
    page.getByText("Алгоритмы", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Задания", exact: true }).click();
  await page
    .getByRole("button", { name: "+ Личное задание", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Что нужно сделать", { exact: true })
    .fill("Повторить сортировки");
  await dialog
    .getByRole("combobox", { name: "Предмет", exact: true })
    .selectOption("math");
  await dialog.getByLabel("Срок", { exact: true }).fill("2026-11-08");
  await dialog.getByRole("button", { name: "Добавить", exact: true }).click();
  await page
    .getByRole("combobox", {
      name: "Повторить сортировки · Статус",
      exact: true,
    })
    .selectOption("progress");
  await page
    .getByRole("combobox", {
      name: "Решить задачи по алгоритмам · Статус",
      exact: true,
    })
    .selectOption("done");
  await page.reload();
  await page.getByRole("button", { name: "Задания", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Повторить сортировки", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", {
      name: "Повторить сортировки · Статус",
      exact: true,
    }),
  ).toHaveValue("progress");
  await expect(
    page.getByRole("combobox", {
      name: "Решить задачи по алгоритмам · Статус",
      exact: true,
    }),
  ).toHaveValue("done");
  expect(requests.every((req) => req.action === "state")).toBe(true);
});

test("subgroup, theme and language persist and the dark theme remains accessible", async ({
  page,
}) => {
  await mockState(page);
  await page.goto("/schedule/beta/");
  await expect(
    page.getByText("Алгоритмы", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Ещё", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Подгруппа", exact: true })
    .selectOption("Б");
  await page
    .getByRole("combobox", { name: "Тема", exact: true })
    .selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.evaluate(await readFile(axePath, "utf8"));
  expect(
    await page.evaluate(async () =>
      (
        await globalThis.axe.run(document, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
        })
      ).violations.map((v) => v.id),
    ),
  ).toEqual([]);
  await page
    .getByRole("combobox", { name: "Язык", exact: true })
    .selectOption("en");
  await expect(
    page.getByRole("button", { name: "Today", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("#identity")).toContainText("Б");
  await page.getByRole("button", { name: "More", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Subgroup", exact: true }),
  ).toHaveValue("Б");
});

test("personal assignment text is rendered literally without creating HTML", async ({
  page,
}) => {
  await mockState(page);
  await page.goto("/schedule/beta/");
  await expect(
    page.getByText("Алгоритмы", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Задания", exact: true }).click();
  await page
    .getByRole("button", { name: "+ Личное задание", exact: true })
    .click();
  const title = '<img src=x onerror="window.xssExecuted=true">';
  await page
    .getByRole("dialog")
    .getByLabel("Что нужно сделать", { exact: true })
    .fill(title);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Добавить", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  expect(await page.locator("main img").count()).toBe(0);
  expect(await page.evaluate(() => globalThis.xssExecuted)).toBeUndefined();
});

test("the student service worker does not replace the staff route with the student shell", async ({
  page,
}) => {
  await mockState(page);
  await page.route("https://cdn.jsdelivr.net/**", (route) => route.abort());
  await page.goto("/schedule/beta/");
  await expect(
    page.getByText("Алгоритмы", { exact: true }).first(),
  ).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.goto("/schedule/beta/manage/");
  await expect(page.locator('[data-action="login"]')).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Разделы", exact: true }),
  ).toBeVisible();
});

test("keyboard skip link and 200 percent text preserve all student screens", async ({
  page,
}) => {
  await mockState(page);
  await page.goto("/schedule/beta/");
  await expect(
    page.getByText("Алгоритмы", { exact: true }).first(),
  ).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "К содержимому", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  for (const label of ["Сегодня", "Неделя", "Задания", "Ещё"]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      label,
    ).toBe(true);
  }
});

test("calendar subscription contains only public scope and demo offers downloads", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["notifications"]);
  await mockState(page);
  await page.goto("/schedule/beta/");
  await expect(
    page.getByText("Алгоритмы", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Ещё", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Подгруппа", exact: true })
    .selectOption("Б");
  await page
    .getByRole("combobox", { name: "За сколько минут", exact: true })
    .selectOption("15");
  const input = page.getByRole("textbox", {
    name: "Ссылка для подписки",
    exact: true,
  });
  await expect(input).toHaveAttribute("readonly", "");
  const url = new URL(await input.inputValue());
  expect(url.origin).toBe("https://anfwdrcazwbkkayczkxg.supabase.co");
  expect(url.pathname).toBe("/functions/v1/uniflow-calendar");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    group: "g-main",
    subgroup: "Б",
    reminder: "15",
  });
  expect(url.href).not.toMatch(/token|apikey|password|session/i);
  await page.goto("/schedule/beta/?demo=student");
  await page.getByRole("button", { name: "Ещё", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Ссылка для подписки", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText(
      "В демо доступно скачивание .ics. Подписка относится только к настоящему расписанию.",
      { exact: true },
    ),
  ).toBeVisible();
});
