import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fixture, mockState } from "./fixtures.mjs";
import { mockManager } from "./manager-fixture.mjs";
import { DEFAULT_APPEARANCE_POLICY as defaults } from "../../backend/appearance-policy.mjs";
const axePath = createRequire(import.meta.url).resolve("axe-core/axe.min.js");
async function mockAppearance(
  page,
  initial = defaults,
  clock = {},
  model = fixture,
) {
  await mockState(page, clock);
  let policy = structuredClone(initial),
    revision = 7;
  const requests = [];
  await page.route("**/functions/v1/uniflow-api", async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    await route.fulfill({
      json: {
        data: {
          ...structuredClone(model),
          announcements: [
            {
              id: "layout-announcement",
              title: "Сообщение группе",
              body: "Общее сообщение сохраняется во всех представлениях.",
              roles: ["student"],
              groupId: "g-main",
              createdAt: "2026-11-06T04:00:00Z",
            },
          ],
          siteSettings: { appearance: policy, privateFuture: "not cached" },
        },
        revision,
        user: {
          role: "guest",
          id: "guest",
          groupId: "g-main",
          subgroup: body.subgroup || "А",
        },
        users: [],
        versions: [],
        capabilities: { allSubgroupTasks: true },
      },
    });
  });
  return {
    requests,
    setPolicy: (next) => {
      policy = structuredClone(next);
      revision++;
    },
  };
}
const nav = (page, label) =>
  page.getByRole("button", { name: label, exact: true }).click();
const more = async (page) => {
  await nav(page, "Ещё");
  await expect(
    page.getByRole("heading", { name: "Оформление на этом устройстве" }),
  ).toBeVisible();
};
async function axe(page) {
  await page.evaluate(await readFile(axePath, "utf8"));
  return page.evaluate(async () =>
    (
      await globalThis.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      })
    ).violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => n.target),
    })),
  );
}
test("six distinct palettes work in both modes with AA and responsive content", async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()))
      errors.push(message.text());
  });
  await mockAppearance(page);
  await page.goto("/schedule/");
  const accents = [];
  for (const palette of [
    "violet",
    "graphite",
    "ocean",
    "forest",
    "sunset",
    "contrast",
  ]) {
    await more(page);
    await page
      .getByRole("combobox", { name: "Палитра", exact: true })
      .selectOption(palette);
    for (const theme of ["light", "dark"]) {
      await page
        .getByRole("combobox", { name: "Тема", exact: true })
        .selectOption(theme);
      await nav(page, "Сегодня");
      await expect(page.locator("html")).toHaveAttribute(
        "data-palette",
        palette,
      );
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(
        page.getByRole("heading", { name: "Алгоритмы", exact: true }).first(),
      ).toBeVisible();
      expect(await axe(page), palette + "/" + theme).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      if (theme === "light")
        accents.push(
          await page.evaluate(() =>
            window
              .getComputedStyle(document.documentElement)
              .getPropertyValue("--accent")
              .trim(),
          ),
        );
      await page.screenshot({
        path: testInfo.outputPath(palette + "-" + theme + ".png"),
        fullPage: false,
      });
      await more(page);
    }
  }
  await page
    .getByRole("combobox", { name: "Тема", exact: true })
    .selectOption("system");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "system");
  await expect
    .poll(() =>
      page.evaluate(() =>
        window
          .getComputedStyle(document.documentElement)
          .getPropertyValue("--bg")
          .trim(),
      ),
    )
    .toBe("#000000");
  await page.emulateMedia({ colorScheme: "light" });
  await expect
    .poll(() =>
      page.evaluate(() =>
        window
          .getComputedStyle(document.documentElement)
          .getPropertyValue("--bg")
          .trim(),
      ),
    )
    .toBe("#ffffff");
  expect(new Set(accents).size).toBe(6);
  expect(errors).toEqual([]);
});
test("four layouts preserve data and navigation without reload or horizontal page overflow", async ({
  page,
}, testInfo) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()))
      errors.push(message.text());
  });
  const state = await mockAppearance(page);
  await page.goto("/schedule/");
  expect(
    await page.evaluate(
      () =>
        performance
          .getEntriesByType("resource")
          .filter((r) => r.name.includes("/layouts/")).length,
    ),
  ).toBe(0);
  for (const layout of ["focus", "timeline", "grid", "cards"]) {
    await more(page);
    await page
      .getByRole("combobox", { name: "Представление расписания", exact: true })
      .selectOption(layout);
    await nav(page, "Сегодня");
    await expect(page.locator("html")).toHaveAttribute("data-layout", layout);
    if (layout === "timeline") {
      await expect(page.locator(".timeline-list")).toBeVisible();
      await expect(
        page.getByText("Окно · 70 мин", { exact: true }),
      ).toBeVisible();
      await expect(page.locator('[aria-current="time"]')).toBeVisible();
    } else if (layout === "grid") {
      await expect(page.getByRole("table")).toBeVisible();
      await expect(page.getByRole("columnheader")).toHaveCount(8);
      const metrics = await page
        .locator(".layout-grid-scroll")
        .evaluate((n) => ({ scroll: n.scrollWidth, width: n.clientWidth }));
      if (page.viewportSize().width < 900)
        expect(metrics.scroll).toBeGreaterThan(metrics.width);
      else expect(metrics.scroll).toBe(metrics.width);
      await expect(
        page.getByRole("columnheader", { name: "Время", exact: true }),
      ).toBeVisible();
      const current = await page
        .locator('.layout-grid th[aria-current="date"]')
        .boundingBox();
      expect(current.x).toBeGreaterThanOrEqual(0);
      expect(current.x + current.width).toBeLessThanOrEqual(
        page.viewportSize().width,
      );
    } else if (layout === "cards") {
      await expect(page.locator(".layout-day-card")).toHaveCount(7);
      await expect(
        page
          .locator(".layout-cards")
          .getByText("Решить задачи по алгоритмам", { exact: true }),
      ).toBeVisible();
    } else await expect(page.locator(".hero")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expect(
      page.getByRole("heading", { name: "Сообщение группе", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Ближайшие сроки", exact: true }),
    ).toBeVisible();
    expect(await axe(page), layout).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("layout-" + layout + ".png"),
      fullPage: false,
    });
  }
  expect(state.requests.every((r) => r.action === "state")).toBe(true);
  expect(errors).toEqual([]);
});
test("device appearance survives return and offline while public cache excludes unknown settings", async ({
  page,
  context,
}) => {
  await mockAppearance(page);
  await page.goto("/schedule/");
  await more(page);
  for (const [label, value] of [
    ["Палитра", "forest"],
    ["Представление расписания", "timeline"],
    ["Тема", "dark"],
    ["Плотность", "spacious"],
    ["Размер текста", "large"],
    ["Скругление", "round"],
  ])
    await page
      .getByRole("combobox", { name: label, exact: true })
      .selectOption(value);
  await page.getByLabel("Уменьшить анимации", { exact: true }).check();
  await page.getByLabel("Свой акцент", { exact: true }).evaluate((input) => {
    input.value = "#ffff00";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "forest");
  await expect(page.locator("html")).toHaveAttribute("data-layout", "timeline");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const snapshot = await page.evaluate(async () => {
    const s = await import(new URL("./lib/storage.mjs", document.baseURI).href);
    return s.get("snapshot:g-main:А");
  });
  expect(snapshot.data.siteSettings.privateFuture).toBeUndefined();
  expect(await axe(page)).toEqual([]);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator(".timeline-list")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute(
    "data-reduced-motion",
    "true",
  );
  await expect(page.locator("html")).toHaveAttribute("data-text-size", "large");
});
test("published owner policy overrides forbidden local choices and keeps accessibility preferences", async ({
  page,
}) => {
  const state = await mockAppearance(page);
  await page.goto("/schedule/");
  await more(page);
  await page
    .getByRole("combobox", { name: "Палитра", exact: true })
    .selectOption("forest");
  await page
    .getByRole("combobox", { name: "Представление расписания", exact: true })
    .selectOption("grid");
  await page
    .getByRole("combobox", { name: "Размер текста", exact: true })
    .selectOption("large");
  state.setPolicy({
    ...structuredClone(defaults),
    defaultPalette: "ocean",
    defaultLayout: "cards",
    allowPaletteChoice: false,
    allowLayoutChoice: false,
    allowCustomAccent: false,
    allowedPalettes: ["ocean"],
    allowedLayouts: ["cards"],
  });
  await page.getByRole("button", { name: "Обновить", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "ocean");
  await expect(page.locator("html")).toHaveAttribute("data-layout", "cards");
  await expect(page.locator("html")).toHaveAttribute("data-text-size", "large");
  await expect(
    page.getByRole("combobox", { name: "Палитра", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("combobox", {
      name: "Представление расписания",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    page.getByRole("combobox", { name: "Размер текста", exact: true }),
  ).toBeEnabled();
  await page.reload();
  await expect(page.locator(".layout-day-card")).toHaveCount(7);
});
test("owner previews all real-data layouts and publishes policy only through an explicit draft", async ({
  page,
}, testInfo) => {
  const manager = await mockManager(page);
  await manager.login();
  const before = manager.state();
  await page
    .getByRole("button", { name: "Интерфейс сайта", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(".appearance-owner-preview")).toHaveCount(4);
  await expect(
    dialog.getByText("Алгоритмы", { exact: true }).first(),
  ).toBeVisible();
  await dialog
    .getByRole("combobox", { name: "Основная палитра", exact: true })
    .selectOption("ocean");
  await dialog
    .getByRole("combobox", { name: "Основной интерфейс", exact: true })
    .selectOption("grid");
  await dialog
    .getByLabel("Разрешить студентам менять интерфейс", { exact: true })
    .uncheck();
  expect(manager.state().revision).toBe(before.revision);
  await expect
    .poll(() =>
      dialog
        .locator(".appearance-owner-preview")
        .first()
        .evaluate((node) => window.getComputedStyle(node).borderTopWidth),
    )
    .toBe("2px");
  await expect
    .poll(() =>
      dialog
        .locator(".appearance-owner-preview")
        .first()
        .evaluate((node) =>
          window.getComputedStyle(node).getPropertyValue("--accent").trim(),
        ),
    )
    .toBe("#005e85");
  expect(await axe(page)).toEqual([]);
  await dialog
    .getByRole("combobox", { name: "Освещение предпросмотра", exact: true })
    .selectOption("dark");
  await expect
    .poll(() =>
      dialog
        .locator(".appearance-owner-preview")
        .first()
        .evaluate((node) =>
          window.getComputedStyle(node).getPropertyValue("--accent").trim(),
        ),
    )
    .toBe("#79d3ff");
  expect(await axe(page)).toEqual([]);
  await dialog
    .getByRole("combobox", { name: "Освещение предпросмотра", exact: true })
    .selectOption("light");
  await dialog
    .locator(".appearance-owner-preview")
    .first()
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("owner-policy-preview.png"),
    fullPage: false,
  });
  await dialog
    .getByRole("button", {
      name: "Сделать основным · сохранить в черновик",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("Черновик · не опубликован", { exact: true }),
  ).toBeVisible();
  expect(manager.state().revision).toBe(before.revision);
  await page.getByRole("button", { name: "Опубликовать", exact: true }).click();
  await expect.poll(() => manager.state().revision).toBe(before.revision + 1);
  const after = manager.state();
  expect(after.data.siteSettings.appearance.defaultLayout).toBe("grid");
  expect(after.data.siteSettings.appearance.defaultPalette).toBe("ocean");
  expect(after.data.siteSettings.appearance.allowLayoutChoice).toBe(false);
  expect(after.data.lessons).toEqual(before.data.lessons);
});

test("saved palette is applied before the main UI module loads", async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({
    serviceWorkers: "block",
    viewport: testInfo.project.use.viewport,
  });
  const page = await context.newPage();
  await mockAppearance(page);
  await page.goto("/schedule/");
  await more(page);
  await page
    .getByRole("combobox", { name: "Палитра", exact: true })
    .selectOption("forest");
  await page
    .getByRole("combobox", { name: "Тема", exact: true })
    .selectOption("dark");
  // Withhold only the main UI module in both source and compiled HTML.
  // The early classic script and its exact original CSP bytes remain intact.
  let prerendered = false;
  await page.route("**/schedule/", async (route) => {
    const response = await route.fetch();
    const original = await response.text();
    prerendered = /<form\b[^>]*\bdata-initial-choice(?:\s|=|>)/i.test(original);
    const html = original.replace(
      /<script\b(?=[^>]*\btype=["']module["'])[^>]*>[\s\S]*?<\/script>/gi,
      "",
    );
    await route.fulfill({ response, body: html });
  });
  try {
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute(
      "data-palette",
      "forest",
    );
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    if (prerendered) {
      await expect(page.locator("[data-initial-choice]")).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Выбери свою группу", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("combobox", { name: "Группа", exact: true }),
      ).toBeVisible();
    } else await expect(page.locator(".skeleton")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("timeline follows shared lesson boundaries without repeated stale-current rerenders", async ({
  page,
  context,
}) => {
  await mockAppearance(page, defaults, {
    time: new Date("2026-11-06T04:49:55Z"),
    ticking: true,
  });
  await page.goto("/schedule/");
  await more(page);
  await page
    .getByRole("combobox", { name: "Представление расписания", exact: true })
    .selectOption("timeline");
  await nav(page, "Сегодня");
  await expect(
    page.locator('.timeline-list [aria-current="time"]'),
  ).toHaveCount(1);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  await page.clock.runFor(5011);
  await expect(
    page.locator('.timeline-list [aria-current="time"]'),
  ).toHaveCount(0);
  const list = await page.locator(".timeline-list").elementHandle();
  await page.clock.runFor(60000);
  expect(await list.evaluate((node) => node.isConnected)).toBe(true);
});
test("an unpinned day selection follows Almaty midnight in an alternative layout", async ({
  page,
}) => {
  await mockAppearance(page, defaults, {
    time: new Date("2026-11-06T18:59:55Z"),
    ticking: true,
  });
  await page.goto("/schedule/");
  await more(page);
  await page
    .getByRole("combobox", { name: "Представление расписания", exact: true })
    .selectOption("timeline");
  await nav(page, "Сегодня");
  await expect(page.locator(".timeline-list")).toBeVisible();
  await page.clock.runFor(5011);
  await expect(
    page.getByRole("heading", { name: "суббота, 7 ноября", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".timeline-list")).toHaveCount(0);
});

test("timeline retains a previous-night current through midnight and removes it at the exclusive end", async ({
  page,
}) => {
  const night = {
    ...fixture.lessons[0],
    id: "overnight-layout-current",
    day: 4,
    week: "all",
    start: "23:00",
    end: "01:00",
    endDayOffset: 1,
  };
  await mockAppearance(
    page,
    defaults,
    {
      time: new Date("2026-11-06T18:59:55Z"),
      ticking: true,
    },
    { ...fixture, lessons: [night], exceptions: [] },
  );
  await page.goto("/schedule/");
  await more(page);
  await page
    .getByRole("combobox", { name: "Представление расписания", exact: true })
    .selectOption("timeline");
  await nav(page, "Сегодня");
  const current = page.locator('.timeline-list [aria-current="time"]');
  await expect(current).toHaveCount(1);
  await expect(current).toContainText("Алгоритмы");
  await expect(current).toContainText("23:00");
  await expect(current).toContainText("01:00 +1");
  await expect(page.locator(".timeline-list .lesson-row")).toHaveCount(1);
  await page.clock.runFor(5011);
  await expect(
    page.getByRole("heading", { name: "суббота, 7 ноября", exact: true }),
  ).toBeVisible();
  await expect(current).toHaveCount(1);
  await expect(current).toContainText("Алгоритмы");
  await expect(page.locator(".timeline-list .lesson-row")).toHaveCount(1);
  await page.clock.runFor(60 * 60 * 1000);
  await expect(current).toHaveCount(0);
  await expect(page.locator(".timeline-list")).toHaveCount(0);
  await expect(
    page.getByText("На этот день занятий нет.", { exact: true }),
  ).toBeVisible();
});
