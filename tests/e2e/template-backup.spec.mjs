import { test, expect } from "@playwright/test";
import { mockManager } from "./manager-fixture.mjs";
import { fixture } from "./fixtures.mjs";
import { createTemplate } from "../../app/manage/templates.mjs";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const key = "uf.schedule.templates.v1.live",
  ack = "Подтверждаю добавление шаблонов в локальную библиотеку";
const row = (name = "Пятница") =>
  createTemplate(fixture, {
    name,
    kind: "day",
    day: 4,
    groupId: "g-main",
    subgroup: "А",
  });
const raw = (rows = [row()]) =>
  JSON.stringify({
    format: "uniflow-template-library-v1",
    version: 1,
    exportedAt: "2026-11-08T09:00:00Z",
    templates: rows,
  });
const issues = new WeakMap();
test.beforeEach(({ page }) => {
  const found = [];
  issues.set(page, found);
  page.on("pageerror", (e) => found.push(e.message));
  page.on("console", (m) => {
    if (["warning", "error"].includes(m.type())) found.push(m.text());
  });
});
test.afterEach(({ page }) => expect(issues.get(page)).toEqual([]));
async function seed(page, rows = []) {
  await page.addInitScript(
    ({ key, rows }) => {
      if (!localStorage.getItem("qa.templateSeeded")) {
        localStorage.setItem(key, JSON.stringify(rows));
        localStorage.setItem("qa.templateSeeded", "1");
      }
    },
    { key, rows },
  );
  const manager = await mockManager(page);
  await manager.login();
  return manager;
}
const stored = (page) => page.evaluate((key) => localStorage.getItem(key), key);
async function managerDialog(page) {
  await page.locator('[data-page="schedule"]').click();
  await page.getByRole("button", { name: "Шаблоны", exact: true }).click();
  return page.getByRole("dialog");
}
async function open(page) {
  const dialog = await managerDialog(page);
  await dialog
    .getByRole("button", { name: "Импортировать копию шаблонов", exact: true })
    .click();
  await expect(
    dialog.getByRole("heading", { name: "Импорт копии шаблонов", exact: true }),
  ).toBeVisible();
  return dialog;
}
async function file(dialog, text = raw(), name = "templates.json") {
  await dialog
    .getByLabel("Файл копии шаблонов", { exact: true })
    .setInputFiles({
      name,
      mimeType: "application/json",
      buffer: Buffer.isBuffer(text) ? text : Buffer.from(text),
    });
}
async function preview(dialog) {
  await dialog
    .getByRole("button", { name: "Проверить копию", exact: true })
    .click();
}
const apply = (dialog) =>
  dialog.getByRole("button", { name: "Импортировать шаблоны", exact: true });
async function ready(dialog) {
  await expect(dialog.getByRole("status")).toContainText("Добавить:");
}
test("owner exports and restores a closed library with fresh IDs, offline/reload persistence and idempotent repeat import", async ({
  page,
  context,
}) => {
  const originals = [row("Пятница"), row("Запасной день")],
    manager = await seed(page, originals),
    before = manager.state();
  let dialog = await managerDialog(page);
  const download = page.waitForEvent("download");
  await dialog
    .getByRole("button", { name: "Скачать копию шаблонов", exact: true })
    .click();
  const downloaded = await download,
    text = await readFile(await downloaded.path(), "utf8");
  expect(JSON.parse(text).templates).toHaveLength(2);
  expect(text).not.toMatch(
    /password|token|attendance|sourceConflictPairs|sharedSessionId/,
  );
  await page.evaluate((key) => localStorage.removeItem(key), key);
  await dialog
    .getByRole("button", { name: "Импортировать копию шаблонов", exact: true })
    .click();
  await file(dialog, text);
  await preview(dialog);
  await ready(dialog);
  expect(await stored(page)).toBeNull();
  await expect(apply(dialog)).toBeDisabled();
  await dialog.getByLabel(ack, { exact: true }).check();
  await context.setOffline(true);
  await apply(dialog).click();
  await expect(
    dialog.getByRole("heading", { name: "Шаблоны расписания", exact: true }),
  ).toBeVisible();
  const restored = JSON.parse(await stored(page));
  expect(restored).toHaveLength(2);
  expect(restored.every((r) => !originals.some((o) => o.id === r.id))).toBe(
    true,
  );
  expect(manager.state()).toEqual(before);
  expect(manager.writes()).toEqual([]);
  await context.setOffline(false);
  await page.reload();
  await manager.login({ navigate: false });
  dialog = await open(page);
  await file(dialog, text);
  await preview(dialog);
  await ready(dialog);
  await expect(dialog.getByRole("status")).toHaveText(
    "Добавить: 0. Уже есть: 2. Конфликт названий: 0.",
  );
  await expect(apply(dialog)).toBeDisabled();
  expect(JSON.parse(await stored(page))).toEqual(restored);
});
test("preview is literal, accessible in both themes and does not create a draft or write storage", async ({
  page,
}, info) => {
  const manager = await seed(page),
    before = await stored(page),
    dialog = await open(page);
  await file(dialog, raw([row("Вечерний резерв")]));
  await preview(dialog);
  await ready(dialog);
  await expect(dialog.locator(".batch-preview")).not.toContainText("false");
  expect(await stored(page)).toBe(before);
  expect(manager.writes()).toEqual([]);
  await expect(
    page.getByRole("button", { name: "Создать черновик", exact: true }),
  ).toBeVisible();
  await page.evaluate(
    await readFile(
      createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
      "utf8",
    ),
  );
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (theme) => document.body.classList.toggle("dark", theme === "dark"),
      theme,
    );
    await expect(
      dialog.getByRole("button", { name: "Проверить копию", exact: true }),
    ).toHaveCSS(
      "background-color",
      theme === "dark" ? "rgb(39, 33, 50)" : "rgb(255, 255, 255)",
    );
    expect(
      await page.evaluate(
        async () =>
          (
            await window.axe.run(document.querySelector("#modal"), {
              runOnly: {
                type: "tag",
                values: ["wcag2a", "wcag2aa", "wcag21aa"],
              },
            })
          ).violations,
      ),
    ).toEqual([]);
    expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(
      true,
    );
    if (process.env.QA_EVIDENCE_DIR) {
      await mkdir(resolve(process.env.QA_EVIDENCE_DIR), { recursive: true });
      await page.screenshot({
        path: resolve(
          process.env.QA_EVIDENCE_DIR,
          `templates-${info.project.name}-${theme}.png`,
        ),
      });
    }
  }
  await file(dialog, raw([row('<img src=x onerror="window.templateXss=1">')]));
  await preview(dialog);
  await ready(dialog);
  await expect(dialog.getByText(/<img src=x/)).toBeVisible();
  await expect(dialog.locator("img,script")).toHaveCount(0);
  expect(await page.evaluate(() => window.templateXss)).toBeUndefined();
  expect(await stored(page)).toBe(before);
});
test("same-name changed content blocks every addition until an explicit library rename and repreview", async ({
  page,
}) => {
  const original = row(),
    changed = structuredClone(original);
  changed.lessons[0].type = "Другой тип";
  const manager = await seed(page, [original]),
    before = await stored(page);
  let dialog = await open(page);
  const text = raw([changed, row("Вторая")]);
  await file(dialog, text);
  await preview(dialog);
  await ready(dialog);
  await expect(dialog).toContainText(
    "Одноимённые шаблоны с другим содержимым не заменяются",
  );
  await expect(apply(dialog)).toBeDisabled();
  expect(await stored(page)).toBe(before);
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  dialog = await managerDialog(page);
  await dialog
    .getByRole("button", { name: "Переименовать шаблон Пятница", exact: true })
    .click();
  await dialog
    .getByLabel("Новое название", { exact: true })
    .fill("Мой прежний");
  await dialog
    .getByRole("button", { name: "Переименовать", exact: true })
    .click();
  await expect(
    dialog.getByRole("heading", { name: "Шаблоны расписания", exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Импортировать копию шаблонов", exact: true })
    .click();
  await file(dialog, text);
  await preview(dialog);
  await ready(dialog);
  await dialog.getByLabel(ack).check();
  await apply(dialog).click();
  await expect(
    dialog.getByRole("heading", { name: "Шаблоны расписания", exact: true }),
  ).toBeVisible();
  expect(JSON.parse(await stored(page)).map((r) => r.name)).toEqual([
    "Мой прежний",
    "Пятница",
    "Вторая",
  ]);
  expect(manager.writes()).toEqual([]);
});
test("bad JSON, oversized and invalid UTF-8 files, secret fields and duplicate names fail without erasing storage", async ({
  page,
}) => {
  const manager = await seed(page, [row("Мой")]),
    before = await stored(page),
    dialog = await open(page),
    unknown = JSON.parse(raw());
  unknown.templates[0].token = "private";
  const duplicate = JSON.parse(raw());
  duplicate.templates.push({ ...duplicate.templates[0], id: "another" });
  for (const text of [
    "{",
    "я".repeat(150001),
    Buffer.from([0xff, 0xfe, 0xfd]),
    JSON.stringify(unknown),
    JSON.stringify(duplicate),
  ]) {
    await file(dialog, text);
    await preview(dialog);
    await expect(dialog.getByRole("alert")).not.toBeEmpty();
    await expect(apply(dialog)).toBeDisabled();
    expect(await stored(page)).toBe(before);
  }
  expect(manager.writes()).toEqual([]);
});
test("quota denial preserves the entire old library and an explicit preview retry adds exactly once", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const set = window.Storage.prototype.setItem;
    window.Storage.prototype.setItem = function (k, v) {
      if (k === "uf.schedule.templates.v1.live" && window.qaTemplateQuota)
        throw Error("quota");
      return set.call(this, k, v);
    };
  });
  const manager = await seed(page, [row("Мой")]),
    before = await stored(page),
    dialog = await open(page);
  await file(dialog);
  await preview(dialog);
  await ready(dialog);
  await page.evaluate(() => {
    window.qaTemplateQuota = true;
  });
  await dialog.getByLabel(ack).check();
  await apply(dialog).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Проверь доступное место",
  );
  expect(await stored(page)).toBe(before);
  await expect(apply(dialog)).toBeDisabled();
  await page.evaluate(() => {
    window.qaTemplateQuota = false;
  });
  await preview(dialog);
  await ready(dialog);
  await expect(dialog.getByLabel(ack)).not.toBeChecked();
  await dialog.getByLabel(ack).check();
  await apply(dialog).click();
  await expect(
    dialog.getByRole("heading", { name: "Шаблоны расписания", exact: true }),
  ).toBeVisible();
  expect(JSON.parse(await stored(page))).toHaveLength(2);
  expect(manager.writes()).toEqual([]);
});
test("a second owner tab changes the library; stale import rejects and shared writers preserve both tabs' additions", async ({
  page,
  context,
}) => {
  const manager = await seed(page, [row("Исходный")]),
    dialog = await open(page);
  await file(dialog);
  await preview(dialog);
  await ready(dialog);
  await dialog.getByLabel(ack).check();
  const other = await context.newPage(),
    second = await mockManager(other);
  await second.login();
  let otherDialog = await managerDialog(other);
  await otherDialog
    .getByRole("button", { name: "Сохранить новый шаблон", exact: true })
    .click();
  await otherDialog
    .getByLabel("Название шаблона", { exact: true })
    .fill("Другая вкладка");
  await page.evaluate(() => {
    window.qaWriterLockReady = false;
    window.qaWriterLock = navigator.locks.request(
      "uniflow-template-library-v1",
      () =>
        new Promise((resolve) => {
          window.qaWriterLockReady = true;
          window.qaReleaseWriter = resolve;
        }),
    );
  });
  await expect
    .poll(() => page.evaluate(() => window.qaWriterLockReady))
    .toBe(true);
  await otherDialog
    .getByRole("button", { name: "Сохранить шаблон", exact: true })
    .click();
  await expect(otherDialog.getByRole("status")).toHaveText(
    "Ожидаем безопасную запись библиотеки…",
  );
  await expect(
    otherDialog.getByRole("button", { name: "Сохранить шаблон", exact: true }),
  ).toBeDisabled();
  expect(JSON.parse(await stored(page))).toHaveLength(1);
  await page.evaluate(() => window.qaReleaseWriter());
  await page.evaluate(() => window.qaWriterLock);
  await expect(
    otherDialog.getByRole("heading", {
      name: "Шаблоны расписания",
      exact: true,
    }),
  ).toBeVisible();
  const before = await stored(page);
  await apply(dialog).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Библиотека или справочники изменились",
  );
  expect(await stored(page)).toBe(before);
  await preview(dialog);
  await ready(dialog);
  await dialog.getByLabel(ack).check();
  await apply(dialog).click();
  await expect(
    dialog.getByRole("heading", { name: "Шаблоны расписания", exact: true }),
  ).toBeVisible();
  expect(JSON.parse(await stored(page)).map((r) => r.name)).toEqual([
    "Исходный",
    "Другая вкладка",
    "Пятница",
  ]);
  expect(manager.writes()).toEqual([]);
  expect(second.writes()).toEqual([]);
  await other.close();
});
test("closing while the shared lock is held prevents a late import and leaves the next dialog intact", async ({
  page,
}) => {
  const manager = await seed(page),
    before = await stored(page),
    dialog = await open(page);
  await file(dialog);
  await preview(dialog);
  await ready(dialog);
  await page.evaluate(() => {
    window.qaTemplateLockReady = false;
    window.qaTemplateLock = navigator.locks.request(
      "uniflow-template-library-v1",
      () =>
        new Promise((resolve) => {
          window.qaTemplateLockReady = true;
          window.qaReleaseTemplateLock = resolve;
        }),
    );
  });
  await expect
    .poll(() => page.evaluate(() => window.qaTemplateLockReady))
    .toBe(true);
  await dialog.getByLabel(ack).check();
  await apply(dialog).click();
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await page.locator('[data-action="profile"]').first().click();
  const title = await dialog.locator("h2").textContent();
  await page.evaluate(() => {
    window.qaReleaseTemplateLock();
  });
  await page.evaluate(() => window.qaTemplateLock);
  await expect(dialog.locator("h2")).toHaveText(title);
  expect(await stored(page)).toBe(before);
  expect(manager.writes()).toEqual([]);
});
test("missing references are visible, and capacity or unavailable Web Locks block writes without replacing the old library", async ({
  page,
}) => {
  const templates = Array.from({ length: 20 }, (_, i) => row("Мой " + i)),
    manager = await seed(page, templates),
    before = await stored(page),
    dialog = await open(page);
  const missing = row();
  missing.lessons[0].teacherId = "missing";
  missing.refs.teachers.push({ id: "missing", name: "Прежний преподаватель" });
  await file(dialog, raw([missing]));
  await preview(dialog);
  await ready(dialog);
  await expect(dialog).toContainText("Не найдены справочники");
  await expect(dialog).toContainText("максимум 20 шаблонов");
  await expect(apply(dialog)).toBeDisabled();
  expect(await stored(page)).toBe(before);
  await page.evaluate((key) => localStorage.setItem(key, "[]"), key);
  await preview(dialog);
  await ready(dialog);
  await dialog.getByLabel(ack).check();
  await page.evaluate(() =>
    Object.defineProperty(navigator, "locks", {
      value: undefined,
      configurable: true,
    }),
  );
  await apply(dialog).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "безопасную запись шаблонов",
  );
  expect(await stored(page)).toBe("[]");
  expect(manager.writes()).toEqual([]);
});
test("corrupt storage and changed file invalidate the reviewed plan instead of silently replacing it", async ({
  page,
}) => {
  const manager = await seed(page),
    dialog = await open(page);
  await file(dialog);
  await preview(dialog);
  await ready(dialog);
  await dialog.getByLabel(ack).check();
  await file(dialog, raw([row("Другой файл")]));
  await expect(apply(dialog)).toBeDisabled();
  await expect(dialog.getByLabel(ack)).not.toBeChecked();
  await page.evaluate((key) => localStorage.setItem(key, "{recoverable"), key);
  await preview(dialog);
  await expect(dialog.getByRole("alert")).toContainText("не перезаписаны");
  expect(await stored(page)).toBe("{recoverable");
  expect(manager.writes()).toEqual([]);
});

test("a late file read cannot repopulate a closed importer or write into the next dialog", async ({
  page,
}) => {
  const manager = await seed(page),
    before = await stored(page),
    dialog = await open(page);
  await file(dialog);
  await page.evaluate(() => {
    const original = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      const selected = this;
      return new Promise((resolve) => {
        window.qaReleaseTemplateFile = async () =>
          resolve(await original.call(selected));
      });
    };
  });
  await preview(dialog);
  await expect
    .poll(() => page.evaluate(() => typeof window.qaReleaseTemplateFile))
    .toBe("function");
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await page.locator('[data-action="profile"]').first().click();
  const title = await dialog.locator("h2").textContent();
  await page.evaluate(() => window.qaReleaseTemplateFile());
  await expect(dialog.locator("h2")).toHaveText(title);
  await expect(dialog.locator("[data-template-import]")).toHaveCount(0);
  expect(await stored(page)).toBe(before);
  expect(manager.writes()).toEqual([]);
});
