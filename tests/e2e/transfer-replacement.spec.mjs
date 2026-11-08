import { test, expect } from "@playwright/test";
import { mockManager } from "./manager-fixture.mjs";
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
const owner = "11111111-1111-4111-8111-111111111111";
const ack =
  "Подтверждаю замену собственных занятий выбранной области назначения";
const issues = new WeakMap();
test.beforeEach(({ page }) => {
  const found = [];
  issues.set(page, found);
  page.on("pageerror", (e) => found.push(e.message));
  page.on("console", (m) => {
    if (["error", "warning"].includes(m.type())) found.push(m.text());
  });
});
test.afterEach(({ page }) => expect(issues.get(page)).toEqual([]));
const records = (page) =>
  page.evaluate(
    async (owner) =>
      (await import("/schedule/manage/drafts.mjs"))
        .createDraftJournal()
        .list(owner),
    owner,
  );
const saved = (page) =>
  expect(page.locator("#draft-save-status")).toHaveText(
    "Черновик сохранён на этом устройстве. Не опубликован.",
  );
async function setup(page, options = {}) {
  const manager = await mockManager(page, options);
  await manager.login();
  await page.locator('[data-page="schedule"]').click();
  return manager;
}
async function open(page, kind = "day") {
  await page
    .getByRole("button", {
      name: kind === "day" ? "Копировать день" : "Копировать неделю",
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", {
      name: kind === "day" ? "Копировать день" : "Копировать неделю",
      exact: true,
    }),
  ).toBeVisible();
  return dialog;
}
async function choose(dialog, from = "4", to = "0") {
  await dialog.getByLabel("Откуда", { exact: true }).selectOption(from);
  await dialog.getByLabel("Куда", { exact: true }).selectOption(to);
}
async function replace(dialog) {
  await dialog
    .getByLabel("Режим копирования", { exact: true })
    .selectOption("replace-destination");
}
async function preview(dialog) {
  await dialog
    .getByRole("button", { name: "Предпросмотр копирования", exact: true })
    .click();
}
const ready = (dialog) =>
  expect(
    dialog.getByRole("heading", {
      name: "Предпросмотр замены назначений",
      exact: true,
    }),
  ).toBeVisible();
const apply = (dialog) =>
  dialog.getByRole("button", { name: "Добавить в черновик", exact: true });
async function accept(dialog) {
  await dialog.getByLabel(ack, { exact: true }).check();
  await apply(dialog).click();
  await expect(dialog).not.toBeVisible();
}
async function audit(page) {
  const require = createRequire(import.meta.url);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) =>
      window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)),
    );
  });
  await page.evaluate(
    await readFile(require.resolve("axe-core/axe.min.js"), "utf8"),
  );
  expect(
    await page.evaluate(
      async () =>
        (
          await window.axe.run(document.querySelector("#modal"), {
            runOnly: {
              type: "tag",
              values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
            },
          })
        ).violations,
    ),
  ).toEqual([]);
}
async function allGroups(page) {
  await page
    .locator('select[data-filter="subgroup"]:has(option[value="all"])')
    .selectOption("all");
}
async function seedTemplate(page, manager, kind = "day", omitSunday = false) {
  await page.evaluate(
    async ({ data, kind, omitSunday }) => {
      const tools = await import("/schedule/manage/templates.mjs");
      if (omitSunday)
        data.lessons = data.lessons.filter((row) => row.day !== 6);
      await tools.withTemplateLock(() =>
        tools.saveTemplate(
          tools.createTemplate(data, {
            name: "Replacement template",
            kind,
            day: 4,
            groupId: "g-main",
            subgroup: "all",
          }),
        ),
      );
    },
    { data: manager.state().data, kind, omitSunday },
  );
}
async function openTemplate(page) {
  await page.getByRole("button", { name: "Шаблоны", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", {
      name: "Применить шаблон Replacement template",
      exact: true,
    })
    .click();
  await expect(
    dialog.getByRole("heading", { name: "Применить шаблон", exact: true }),
  ).toBeVisible();
  return dialog;
}

test("occupied day replacement is read-only until acknowledgment, recovers exact IDs, and publishes separately", async ({
  page,
}, info) => {
  const manager = await setup(page, {
      prepareData(data) {
        data.groups.push({ id: "other", name: "Other", subgroups: ["А"] });
        const row = data.lessons[0];
        data.lessons.push(
          {
            ...row,
            id: "keep-common",
            day: 0,
            subgroup: "all",
            start: "15:00",
            end: "15:50",
          },
          {
            ...row,
            id: "keep-b",
            day: 0,
            subgroup: "Б",
            start: "16:00",
            end: "16:50",
          },
          {
            ...row,
            id: "keep-other",
            groupId: "other",
            day: 0,
            start: "17:00",
            end: "17:50",
          },
        );
      },
    }),
    before = manager.state(),
    dialog = await open(page);
  await choose(dialog);
  await replace(dialog);
  await expect(dialog.getByLabel(ack, { exact: true })).toBeDisabled();
  await preview(dialog);
  await ready(dialog);
  expect(
    await dialog.evaluate(
      (root) =>
        root.querySelector(".batch-preview h3").getBoundingClientRect().top >=
        root.querySelector(".batch-actions").getBoundingClientRect().bottom + 8,
    ),
  ).toBe(true);
  await expect(dialog).toContainText(
    "Область назначения: 06-057-25-11 · Подгруппа А · Понедельник",
  );
  await expect(dialog.locator(".batch-count")).toContainText(
    "Будет добавлено: 2. Будет удалено: 1.",
  );
  await expect(dialog.locator("[data-transfer-removed]")).toHaveAttribute(
    "data-transfer-removed",
    "monday-lesson",
  );
  const ids = await dialog
    .locator("[data-transfer-lesson]")
    .evaluateAll((rows) => rows.map((row) => row.dataset.transferLesson));
  await expect(apply(dialog)).toBeDisabled();
  await expect(dialog.getByLabel(ack, { exact: true })).toBeInViewport();
  expect(await records(page)).toEqual([]);
  expect(manager.state()).toEqual(before);
  expect(manager.writes()).toEqual([]);
  await audit(page);
  await mkdir(resolve("../../outputs/replacement-next"), { recursive: true });
  await page.screenshot({
    path: resolve(
      `../../outputs/replacement-next/replacement-${info.project.name}-light.png`,
    ),
  });
  await page.evaluate(() => document.body.classList.add("dark"));
  await audit(page);
  await page.screenshot({
    path: resolve(
      `../../outputs/replacement-next/replacement-${info.project.name}-dark.png`,
    ),
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
  ).toBe(false);
  await accept(dialog);
  await saved(page);
  const record = (await records(page))[0];
  expect(record.changes).toHaveLength(3);
  expect(
    record.changes.find((row) => row.id === "monday-lesson").after,
  ).toBeNull();
  expect(record.changes.filter((row) => ids.includes(row.id))).toHaveLength(2);
  expect(manager.writes()).toEqual([]);
  await page.reload();
  await manager.login({ navigate: false });
  await page
    .getByRole("button", { name: "Локальные черновики", exact: true })
    .click();
  await page
    .locator("[data-local-draft]")
    .filter({ hasText: "Не завершён" })
    .first()
    .getByRole("button", { name: "Проверить восстановление", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Восстановить в черновик", exact: true })
    .click();
  await saved(page);
  await page.getByRole("button", { name: "Опубликовать", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("Черновик опубликован");
  const after = manager.state();
  expect(after.revision).toBe(before.revision + 1);
  expect(manager.writes()).toHaveLength(1);
  expect(after.data.lessons.some((row) => row.id === "monday-lesson")).toBe(
    false,
  );
  expect(
    after.data.lessons
      .filter((row) => ids.includes(row.id))
      .map((row) => row.subgroup),
  ).toEqual(["А", "А"]);
  for (const id of [
    "keep-common",
    "keep-b",
    "keep-other",
    "now-a",
    "next",
    "later-b",
  ])
    expect(after.data.lessons.find((row) => row.id === id)).toEqual(
      before.data.lessons.find((row) => row.id === id),
    );
  expect(after.data.tasks).toEqual(before.data.tasks);
});

test("replacement acknowledgment resets on pages, target and mode changes; append remains available", async ({
  page,
}) => {
  const manager = await setup(page, {
      prepareData(data) {
        const row = data.lessons[0];
        data.lessons.push(
          ...Array.from({ length: 41 }, (_, i) => ({
            ...row,
            id: "old-" + i,
            day: 0,
            teacherId: "",
            roomId: "",
            start: `${String(Math.floor(i / 12)).padStart(2, "0")}:${String((i % 12) * 5).padStart(2, "0")}`,
            end: `${String(Math.floor(i / 12)).padStart(2, "0")}:${String((i % 12) * 5 + 4).padStart(2, "0")}`,
          })),
        );
      },
    }),
    dialog = await open(page);
  await choose(dialog);
  await replace(dialog);
  await preview(dialog);
  await ready(dialog);
  await expect(dialog.locator("[data-transfer-kind]")).toHaveCount(40);
  await dialog.getByLabel(ack, { exact: true }).check();
  await expect(apply(dialog)).toBeEnabled();
  await dialog
    .getByRole("button", { name: "Следующие занятия", exact: true })
    .click();
  await expect(dialog.locator("[data-transfer-kind]")).toHaveCount(4);
  await expect(dialog.getByLabel(ack, { exact: true })).not.toBeChecked();
  await expect(apply(dialog)).toBeDisabled();
  await dialog.getByLabel(ack, { exact: true }).check();
  await dialog.getByLabel("Куда", { exact: true }).selectOption("1");
  await expect(dialog.getByLabel(ack, { exact: true })).not.toBeChecked();
  await expect(dialog.locator("[data-transfer-kind]")).toHaveCount(0);
  await dialog
    .getByLabel("Режим копирования", { exact: true })
    .selectOption("append");
  await expect(dialog.getByLabel(ack, { exact: true })).not.toBeVisible();
  await preview(dialog);
  await expect(
    dialog.getByRole("heading", {
      name: "Предпросмотр новых занятий",
      exact: true,
    }),
  ).toBeVisible();
  await expect(apply(dialog)).toBeEnabled();
  expect(await records(page)).toEqual([]);
  expect(manager.writes()).toEqual([]);
});

test("parity replacement preserves every-week rows and night/date fields", async ({
  page,
}) => {
  const manager = await setup(page, {
      prepareData(data) {
        const row = data.lessons[0];
        row.week = "odd";
        row.start = "23:00";
        row.end = "00:30";
        row.endDayOffset = 1;
        row.validUntil = "2026-12-01";
        data.lessons.push({ ...row, id: "target-even", week: "even" });
      },
    }),
    dialog = await open(page, "week");
  await replace(dialog);
  await preview(dialog);
  await ready(dialog);
  await expect(dialog.locator(".batch-count")).toContainText(
    "Будет добавлено: 1. Будет удалено: 1.",
  );
  await expect(dialog.locator("[data-transfer-lesson]")).toContainText(
    "(+1 день)",
  );
  await expect(dialog.locator("[data-transfer-lesson]")).toContainText(
    "2026-12-01",
  );
  await accept(dialog);
  await saved(page);
  const changes = (await records(page))[0].changes;
  expect(changes.find((row) => row.id === "target-even").after).toBeNull();
  expect(changes.find((row) => row.after)?.after).toMatchObject({
    week: "even",
    endDayOffset: 1,
    validUntil: "2026-12-01",
  });
  expect(changes.some((row) => row.id === "next")).toBe(false);
  expect(manager.writes()).toEqual([]);
});

test("day template can explicitly replace the occupied day of all subgroups", async ({
  page,
}) => {
  const manager = await setup(page);
  await allGroups(page);
  await seedTemplate(page, manager);
  const dialog = await openTemplate(page);
  await dialog.getByLabel("День назначения", { exact: true }).selectOption("4");
  await replace(dialog);
  await preview(dialog);
  await ready(dialog);
  await expect(dialog.locator(".batch-count")).toContainText(
    "Будет добавлено: 3. Будет удалено: 3.",
  );
  await accept(dialog);
  await saved(page);
  const changes = (await records(page))[0].changes;
  expect(changes).toHaveLength(6);
  expect(
    changes.filter((row) => row.after).map((row) => row.after.subgroup),
  ).toEqual(["А", "all", "Б"]);
  expect(changes.some((row) => row.id === "monday-lesson")).toBe(false);
  expect(manager.writes()).toEqual([]);
});

test("week template replacement also removes destination days absent from the template", async ({
  page,
}) => {
  const manager = await setup(page, {
    prepareData(data) {
      data.lessons.push({ ...data.lessons[0], id: "extra-sunday", day: 6 });
    },
  });
  await allGroups(page);
  await seedTemplate(page, manager, "week", true);
  const dialog = await openTemplate(page);
  await expect(
    dialog.getByLabel("День назначения", { exact: true }),
  ).toHaveCount(0);
  await replace(dialog);
  await preview(dialog);
  await ready(dialog);
  await expect(dialog).toContainText("Вся регулярная неделя");
  await expect(dialog.locator(".batch-count")).toContainText(
    "Будет добавлено: 4. Будет удалено: 5.",
  );
  await accept(dialog);
  await saved(page);
  await page.getByRole("button", { name: "Опубликовать", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("Черновик опубликован");
  expect(manager.state().data.lessons).toHaveLength(4);
  expect(manager.state().data.lessons.some((row) => row.day === 6)).toBe(false);
  expect(manager.writes()).toHaveLength(1);
});

test("linked destination overrides block replacement without creating a draft or deleting private records", async ({
  page,
}) => {
  const manager = await setup(page, {
      prepareData(data) {
        data.exceptions = [
          {
            id: "linked",
            lessonId: "monday-lesson",
            date: "2026-11-02",
            status: "cancelled",
          },
        ];
      },
    }),
    before = manager.state(),
    dialog = await open(page);
  await choose(dialog);
  await replace(dialog);
  await preview(dialog);
  await expect(dialog.getByRole("alert")).not.toBeEmpty();
  await expect(apply(dialog)).toBeDisabled();
  await expect(dialog.getByLabel(ack, { exact: true })).toBeDisabled();
  expect(await records(page)).toEqual([]);
  expect(manager.state()).toEqual(before);
  expect(manager.writes()).toEqual([]);
});

test("shared destination rows are retained; choosing all subgroups is a separate explicit replacement", async ({
  page,
}) => {
  const manager = await setup(page, {
      prepareData(data) {
        data.lessons.push({ ...data.lessons[1], id: "target-common", day: 0 });
      },
    }),
    before = manager.state();
  let dialog = await open(page);
  await choose(dialog);
  await replace(dialog);
  await preview(dialog);
  await expect(dialog.getByRole("alert")).not.toBeEmpty();
  expect(await records(page)).toEqual([]);
  await dialog
    .getByRole("button", { name: "Закрыть копирование", exact: true })
    .click();
  await allGroups(page);
  dialog = await open(page);
  await choose(dialog);
  await replace(dialog);
  await preview(dialog);
  await ready(dialog);
  await expect(dialog.locator(".batch-count")).toContainText(
    "Будет добавлено: 3. Будет удалено: 2.",
  );
  await expect(apply(dialog)).toBeDisabled();
  expect(manager.state()).toEqual(before);
  expect(manager.writes()).toEqual([]);
});

test("a refreshed revision rejects an acknowledged replacement without changing the draft", async ({
  page,
}) => {
  const manager = await setup(page),
    dialog = await open(page);
  await choose(dialog);
  await replace(dialog);
  await preview(dialog);
  await ready(dialog);
  await dialog.getByLabel(ack, { exact: true }).check();
  manager.advance("lesson.save", {
    ...manager.state().data.lessons[0],
    type: "Server change",
  });
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/uniflow-api") &&
      r.request().postDataJSON().action === "state",
  );
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await response;
  await expect(dialog.getByRole("alert")).toContainText("Данные изменились");
  await apply(dialog).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Откройте копирование заново",
  );
  await expect(apply(dialog)).toBeDisabled();
  expect(await records(page)).toEqual([]);
  expect(manager.writes()).toEqual([]);
});

test("replacement quota retry keeps the previous durable draft and writes the exact additions/removal once", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.IDBDatabase.prototype.transaction;
    window.IDBDatabase.prototype.transaction = function (names, mode, ...rest) {
      if (
        this.name === "uniflow-owner-drafts-v1" &&
        mode === "readwrite" &&
        localStorage.getItem("qa.replaceQuota") === "1"
      )
        throw Error("quota fixture");
      return original.call(this, names, mode, ...rest);
    };
  });
  const manager = await setup(page);
  let dialog = await open(page);
  await choose(dialog, "4", "1");
  await preview(dialog);
  await expect(
    dialog.getByRole("heading", {
      name: "Предпросмотр новых занятий",
      exact: true,
    }),
  ).toBeVisible();
  await apply(dialog).click();
  await saved(page);
  const previous = (await records(page))[0];
  await page.evaluate(() => localStorage.setItem("qa.replaceQuota", "1"));
  dialog = await open(page);
  await choose(dialog);
  await replace(dialog);
  await preview(dialog);
  await ready(dialog);
  const ids = await dialog
    .locator("[data-transfer-lesson]")
    .evaluateAll((rows) => rows.map((row) => row.dataset.transferLesson));
  await dialog.getByLabel(ack, { exact: true }).check();
  await apply(dialog).click();
  await expect(
    dialog.getByRole("button", { name: "Повторить сохранение", exact: true }),
  ).toBeEnabled();
  expect((await records(page))[0]).toEqual(previous);
  await expect(
    dialog.getByLabel("Режим копирования", { exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => localStorage.removeItem("qa.replaceQuota"));
  await dialog
    .getByRole("button", { name: "Повторить сохранение", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await saved(page);
  const changes = (await records(page))[0].changes;
  expect(changes).toHaveLength(5);
  expect(changes.find((row) => row.id === "monday-lesson").after).toBeNull();
  expect(changes.filter((row) => ids.includes(row.id))).toHaveLength(2);
  expect(new Set(changes.map((row) => row.id)).size).toBe(5);
  expect(manager.writes()).toEqual([]);
});

test("closing during replacement save preserves the applied result and the next dialog", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.IDBDatabase.prototype.transaction;
    window.IDBDatabase.prototype.transaction = function (names, mode, ...rest) {
      const tx = original.call(this, names, mode, ...rest);
      if (
        this.name === "uniflow-owner-drafts-v1" &&
        mode === "readwrite" &&
        window.qaCloseReplacement
      ) {
        window.qaCloseReplacement = false;
        const prop = Object.getOwnPropertyDescriptor(
          window.IDBTransaction.prototype,
          "oncomplete",
        );
        Object.defineProperty(tx, "oncomplete", {
          set(handler) {
            prop.set.call(tx, function (event) {
              document.querySelector("#modal .dialog-head button")?.click();
              document.querySelector('[data-action="profile"]')?.click();
              handler.call(this, event);
            });
          },
        });
      }
      return tx;
    };
  });
  const manager = await setup(page),
    dialog = await open(page);
  await choose(dialog);
  await replace(dialog);
  await preview(dialog);
  await ready(dialog);
  await dialog.getByLabel(ack, { exact: true }).check();
  await page.evaluate(() => {
    window.qaCloseReplacement = true;
  });
  await apply(dialog).click();
  await expect(
    dialog.getByRole("heading", { name: "Копировать день", exact: true }),
  ).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await saved(page);
  expect((await records(page))[0].changes).toHaveLength(3);
  expect(manager.writes()).toEqual([]);
});
