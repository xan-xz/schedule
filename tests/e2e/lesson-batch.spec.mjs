import { test, expect } from "@playwright/test";
import { mockManager } from "./manager-fixture.mjs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";

const owner = "11111111-1111-4111-8111-111111111111",
  health = new WeakMap();
test.beforeEach(async ({ page }) => {
  const issues = [];
  health.set(page, issues);
  page.on("pageerror", (error) => issues.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()))
      issues.push(message.text());
  });
});
test.afterEach(async ({ page }) => expect(health.get(page)).toEqual([]));
const saved = (page) =>
  expect(page.locator("#draft-save-status")).toHaveText(
    "Черновик сохранён на этом устройстве. Не опубликован.",
  );
async function records(page) {
  return page.evaluate(
    async (owner) =>
      (await import("/schedule/manage/drafts.mjs"))
        .createDraftJournal()
        .list(owner),
    owner,
  );
}
async function open(page) {
  await page.locator('[data-page="schedule"]').click();
  await page
    .getByRole("button", { name: "Массовая правка", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Массовая правка", exact: true }),
  ).toBeVisible();
  return page.getByRole("dialog");
}
async function choose(page, ids) {
  for (const id of ids)
    await page.locator(`[data-batch-row="${id}"] input`).check();
}
async function action(page, kind, value) {
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("combobox", { name: "Что изменить", exact: true })
    .selectOption(kind);
  if (kind === "type")
    await dialog.getByLabel("Новый тип занятия", { exact: true }).fill(value);
  else if (["roomId", "teacherId", "subjectId"].includes(kind))
    await dialog
      .getByRole("combobox", { name: "Новое значение", exact: true })
      .selectOption(JSON.stringify(value));
}
async function preview(page, valid = true) {
  await page.getByRole("button", { name: "Предпросмотр", exact: true }).click();
  const apply = page.getByRole("button", {
    name: "Применить в черновике",
    exact: true,
  });
  if (valid) await expect(apply).toBeEnabled();
  else {
    await expect(
      page.getByRole("dialog").locator("#form-error"),
    ).not.toBeEmpty();
    await expect(apply).toBeDisabled();
  }
}
async function apply(page) {
  await page
    .getByRole("button", { name: "Применить в черновике", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await saved(page);
}
async function publish(page, manager) {
  const count = manager.writes().length;
  await page.getByRole("button", { name: "Опубликовать", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("Черновик опубликован");
  expect(manager.writes()).toHaveLength(count + 1);
}
async function axe(page) {
  const require = createRequire(import.meta.url);
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

test("explicit selected IDs preview only actual changes, recover as ordinary durable deltas and publish separately without touching archives", async ({
  page,
}, info) => {
  const manager = await mockManager(page, {
    archived: true,
    prepareData(data) {
      data.lessons[0].source = { sheet: "Source", row: 7, timeCell: "B7" };
      data.lessons[0].futureMetadata = { marker: "PRIVATE_FUTURE_METADATA" };
    },
  });
  await manager.login();
  const original = manager.state().data,
    dialog = await open(page);
  await expect(dialog).toContainText(
    "разовые изменения по датам и исторические снимки не переписываются",
  );
  await expect(
    page.getByRole("button", { name: "Применить в черновике", exact: true }),
  ).toBeDisabled();
  await choose(page, ["now-a", "next"]);
  const target = dialog.getByRole("combobox", {
    name: "Новое значение",
    exact: true,
  });
  await expect(target).toHaveValue("");
  expect(await target.evaluate((input) => input.validity.valueMissing)).toBe(
    true,
  );
  await page.getByRole("button", { name: "Предпросмотр", exact: true }).click();
  await expect(dialog.locator("[data-batch-preview-row]")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Применить в черновике", exact: true }),
  ).toBeDisabled();
  await action(page, "roomId", "205");
  await preview(page);
  await expect(
    dialog.getByRole("region", {
      name: "Предпросмотр массовой правки",
      exact: true,
    }),
  ).toContainText("Выбрано: 2; изменится: 1; без изменений: 1");
  await expect(dialog.locator("[data-batch-preview-row]")).toHaveCount(1);
  await expect(
    dialog.locator('[data-batch-preview-row="now-a"]'),
  ).toContainText("Было: 08:00–09:50");
  await axe(page);
  const shots = resolve("../../outputs/bulk-next/screenshots");
  await mkdir(shots, { recursive: true });
  await page.screenshot({
    path: join(shots, `preview-${info.project.name}.png`),
  });
  expect(manager.writes()).toEqual([]);
  expect(await records(page)).toEqual([]);
  await apply(page);
  const copy = (await records(page))[0];
  expect(copy.changes.map((row) => row.id)).toEqual(["now-a"]);
  for (const excluded of [
    "PRIVATE_FUTURE_METADATA",
    "archived-request",
    "archived-student",
    "owner@example.invalid",
    "ow1a.",
  ])
    expect(JSON.stringify(copy)).not.toContain(excluded);
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
  expect(manager.writes()).toEqual([]);
  await publish(page, manager);
  const state = manager.state().data;
  expect(state.lessons.find((row) => row.id === "now-a").roomId).toBe("205");
  for (const id of ["next", "later-b", "monday-lesson"])
    expect(state.lessons.find((row) => row.id === id)).toEqual(
      original.lessons.find((row) => row.id === id),
    );
  expect(state.lessons[0].source).toEqual(original.lessons[0].source);
  expect(state.lessons[0].futureMetadata).toEqual(
    original.lessons[0].futureMetadata,
  );
  expect(state.requests).toEqual(original.requests);
  expect(state.attendance).toEqual(original.attendance);
});

test("filters clear selected IDs and patch edits invalidate previews instead of applying a larger hidden set", async ({
  page,
}) => {
  const manager = await mockManager(page);
  await manager.login();
  const dialog = await open(page);
  await choose(page, ["now-a", "next"]);
  await action(page, "type", '<img src=x onerror="x">');
  await preview(page);
  await expect(dialog.locator(".batch-preview img")).toHaveCount(0);
  await dialog
    .getByRole("combobox", { name: "День недели", exact: true })
    .selectOption("0");
  await expect(dialog.locator(".batch-count")).toContainText("Выбрано: 0");
  await expect(dialog).toContainText("Выбор и предпросмотр сброшены");
  await expect(dialog.locator("[data-batch-preview-row]")).toHaveCount(0);
  await expect(dialog.locator("[data-batch-row]")).toHaveCount(1);
  await dialog
    .getByRole("button", { name: "Выбрать все найденные (1)", exact: true })
    .click();
  await preview(page);
  await expect(
    dialog.locator('[data-batch-preview-row="monday-lesson"]'),
  ).toHaveCount(1);
  await action(page, "teacherId", "");
  await expect(
    page.getByRole("button", { name: "Применить в черновике", exact: true }),
  ).toBeDisabled();
  await expect(dialog.locator("[data-batch-preview-row]")).toHaveCount(0);
  expect(manager.writes()).toEqual([]);
  expect(await records(page)).toEqual([]);
});

test("validation blocks a real room conflict and no-op; overnight shift and fixed-time previews remain separate explicit actions", async ({
  page,
}) => {
  const manager = await mockManager(page, {
    prepareData(data) {
      data.groups.push({
        id: "other",
        name: "Другая группа",
        subgroups: ["А"],
      });
      data.lessons.push({
        ...data.lessons[0],
        id: "room-conflict",
        groupId: "other",
        teacherId: "",
        roomId: "205",
      });
      data.lessons.push({
        ...data.lessons[0],
        id: "overnight",
        start: "23:00",
        end: "01:00",
        endDayOffset: 1,
      });
    },
  });
  await manager.login();
  const dialog = await open(page);
  await choose(page, ["now-a"]);
  await action(page, "roomId", "205");
  await preview(page, false);
  await expect(dialog.locator("#form-error")).toContainText("занята");
  expect(await records(page)).toEqual([]);
  await action(page, "roomId", "204");
  await preview(page, false);
  await expect(
    dialog.getByRole("region", {
      name: "Предпросмотр массовой правки",
      exact: true,
    }),
  ).toContainText("изменится: 0");
  await action(page, "teacherId", "");
  await preview(page);
  await expect(
    dialog.locator('[data-batch-preview-row="now-a"]'),
  ).toContainText("Будет: 08:00–09:50 · Алгоритмы · Не назначено");
  await dialog
    .getByRole("button", { name: "Очистить выбор", exact: true })
    .click();
  await choose(page, ["overnight"]);
  await action(page, "shiftTime");
  await dialog.getByLabel("Сдвиг в минутах", { exact: true }).fill("120");
  await preview(page, false);
  await expect(dialog.locator("#form-error")).toContainText("границы");
  await dialog.getByLabel("Сдвиг в минутах", { exact: true }).fill("30");
  await preview(page);
  await expect(
    dialog.locator('[data-batch-preview-row="overnight"]'),
  ).toContainText("Будет: 23:30–01:30 (+1 день)");
  await action(page, "setTime");
  await expect(
    page.getByRole("button", { name: "Применить в черновике", exact: true }),
  ).toBeDisabled();
  await dialog.getByLabel("Новое начало", { exact: true }).fill("21:30");
  await dialog.getByLabel("Новый конец", { exact: true }).fill("23:30");
  await dialog
    .getByRole("combobox", { name: "Окончание", exact: true })
    .selectOption("0");
  await preview(page);
  await apply(page);
  await publish(page, manager);
  expect(
    manager.state().data.lessons.find((row) => row.id === "overnight"),
  ).toMatchObject({ start: "21:30", end: "23:30", endDayOffset: 0 });
  expect(
    manager.state().data.lessons.find((row) => row.id === "now-a").teacherId,
  ).toBe("teacher");
});

test("server refresh after a preview blocks stale apply without creating a fresh-base draft", async ({
  page,
}) => {
  const manager = await mockManager(page);
  await manager.login();
  let dialog = await open(page);
  await choose(page, ["now-a"]);
  await action(page, "type", "Моя правка");
  await preview(page);
  manager.advance("lesson.save", {
    ...manager.state().data.lessons[0],
    type: "Серверная правка",
  });
  let release, observed;
  const gate = new Promise((resolve) => {
      release = resolve;
    }),
    requested = new Promise((resolve) => {
      observed = resolve;
    });
  await page.route("**/functions/v1/uniflow-api", async (route) => {
    if (route.request().postDataJSON().action === "state") {
      observed();
      await gate;
    }
    return route.fallback();
  });
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await requested;
  release();
  await expect(dialog.locator("#form-error")).toContainText(
    "Данные изменились",
  );
  await page
    .getByRole("button", { name: "Применить в черновике", exact: true })
    .click();
  await expect(dialog.locator("#form-error")).toContainText(
    "Откройте массовую правку заново",
  );
  await expect(
    page.getByRole("button", { name: "Применить в черновике", exact: true }),
  ).toBeDisabled();
  expect(manager.writes()).toEqual([]);
  expect(await records(page)).toEqual([]);
  expect(
    manager.state().data.lessons.find((row) => row.id === "now-a").type,
  ).toBe("Серверная правка");
  await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
  dialog = await open(page);
  await choose(page, ["now-a"]);
  await action(page, "type", "На актуальной версии");
  await preview(page);
  await apply(page);
  expect(manager.writes()).toEqual([]);
});

test("batch quota failure retains the earlier durable generation and supports explicit retry of the full latest draft", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.IDBDatabase.prototype.transaction;
    window.IDBDatabase.prototype.transaction = function (names, mode, ...rest) {
      if (
        this.name === "uniflow-owner-drafts-v1" &&
        mode === "readwrite" &&
        localStorage.getItem("qa.batchQuota") === "1"
      )
        throw Error("quota fixture");
      return original.call(this, names, mode, ...rest);
    };
  });
  const manager = await mockManager(page);
  await manager.login();
  await open(page);
  await choose(page, ["now-a"]);
  await action(page, "type", "Первая копия");
  await preview(page);
  await apply(page);
  const original = (await records(page))[0];
  await page.evaluate(() => localStorage.setItem("qa.batchQuota", "1"));
  await open(page);
  await choose(page, ["next"]);
  await action(page, "type", "Вторая правка");
  await preview(page);
  await page
    .getByRole("button", { name: "Применить в черновике", exact: true })
    .click();
  await expect(page.locator("#draft-save-status")).toContainText(
    "Локальное сохранение недоступно",
  );
  expect((await records(page))[0]).toEqual(original);
  expect(manager.writes()).toEqual([]);
  await page.evaluate(() => localStorage.removeItem("qa.batchQuota"));
  await page
    .getByRole("button", { name: "Повторить сохранение", exact: true })
    .click();
  await saved(page);
  expect((await records(page))[0].changes.map((row) => row.id)).toEqual([
    "now-a",
    "next",
  ]);
});

test("four thousand lessons render forty rows, enforce an explicit thousand selection cap and preview exact paginated IDs", async ({
  page,
}, info) => {
  const manager = await mockManager(page, {
    prepareData(data) {
      const base = data.lessons[0];
      data.lessons = Array.from({ length: 4000 }, (_, i) => {
        const start = (i % 720) * 2,
          end = start + 1,
          clock = (minute) =>
            `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
        return {
          ...base,
          id: `bulk-${i}`,
          day: Math.floor(i / 720),
          start: clock(start),
          end: clock(end),
          teacherId: "",
          roomId: "",
          type: "Исходный тип",
        };
      });
    },
  });
  await manager.login();
  const dialog = await open(page);
  await expect(dialog.locator("[data-batch-row]")).toHaveCount(40);
  await dialog
    .getByRole("button", { name: "Выбрать все найденные (4000)", exact: true })
    .click();
  await expect(dialog.locator("#form-error")).toContainText("Предел — 1000");
  await expect(dialog.locator(".batch-count")).toContainText("Выбрано: 0");
  await choose(page, ["bulk-0"]);
  await dialog
    .getByRole("group", { name: "Страницы найденных занятий", exact: true })
    .getByRole("button", { name: "Далее", exact: true })
    .click();
  await choose(page, ["bulk-40"]);
  await action(page, "type", "Проверенный тип");
  await preview(page);
  expect(
    await dialog
      .locator("[data-batch-preview-row]")
      .evaluateAll((rows) => rows.map((row) => row.dataset.batchPreviewRow)),
  ).toEqual(["bulk-0", "bulk-40"]);
  await dialog
    .getByRole("combobox", { name: "День недели", exact: true })
    .selectOption("0");
  await expect(dialog.locator(".batch-count")).toContainText("Выбрано: 0");
  await dialog
    .getByRole("button", { name: "Выбрать все найденные (720)", exact: true })
    .click();
  const started = Date.now();
  await preview(page);
  const elapsed = Date.now() - started;
  await expect(
    dialog.getByRole("region", {
      name: "Предпросмотр массовой правки",
      exact: true,
    }),
  ).toContainText("Выбрано: 720; изменится: 720");
  await expect(dialog.locator("[data-batch-preview-row]")).toHaveCount(40);
  const output = resolve("../../outputs/bulk-next");
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, `large-${info.project.name}.json`),
    JSON.stringify({
      lessons: 4000,
      foundRowsRendered: 40,
      cap: 1000,
      selected: 720,
      previewRowsRendered: 40,
      previewElapsedMs: elapsed,
    }) + "\n",
  );
  expect(manager.writes()).toEqual([]);
  expect(await records(page)).toEqual([]);
});

test("sticky bulk actions and previews remain accessible in dark mode; empty reference catalogs and non-owner roles are safe", async ({
  page,
  context,
}, info) => {
  const manager = await mockManager(page, {
    prepareData(data) {
      data.rooms = [];
      data.teachers = [];
      data.tasks = [];
      for (const row of data.lessons) {
        row.roomId = "";
        row.teacherId = "";
      }
    },
  });
  await manager.login();
  await page.locator('[data-action="profile"]').first().click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Светлая / тёмная тема", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Закрыть", exact: true })
    .click();
  const dialog = await open(page);
  await expect(dialog).toContainText("Справочник пуст");
  await choose(page, ["now-a"]);
  await action(page, "type", "Доступная правка");
  await preview(page);
  await axe(page);
  for (const label of ["Предпросмотр", "Применить в черновике", "Отмена"])
    await expect(
      dialog.getByRole("button", { name: label, exact: true }),
    ).toBeInViewport({ ratio: 1 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const shots = resolve("../../outputs/bulk-next/screenshots");
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `dark-${info.project.name}.png`) });
  await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
  const other = await context.newPage(),
    staff = await mockManager(other, { role: "teacher" });
  await staff.login();
  await other.locator('[data-page="schedule"]').click();
  await expect(
    other.getByRole("button", { name: "Массовая правка", exact: true }),
  ).toHaveCount(0);
  await other.close();
  expect(manager.writes()).toEqual([]);
});
