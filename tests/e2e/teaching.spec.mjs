import { test, expect } from "@playwright/test";
import { mockManager } from "./manager-fixture.mjs";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";

const settings = () => ({
  version: 1,
  lessonTypes: [
    { id: "seminar", name: "Семинар", enabled: true },
    { id: "disabled", name: "Лекция", enabled: false },
  ],
  bellSchedules: [
    {
      id: "day",
      name: "Учебная схема",
      enabled: true,
      slots: [
        {
          id: "morning",
          name: "Утренняя пара",
          start: "09:00",
          end: "09:50",
          endDayOffset: 0,
        },
        {
          id: "night",
          name: "Ночная пара",
          start: "23:00",
          end: "01:00",
          endDayOffset: 1,
        },
      ],
    },
  ],
  defaultBellScheduleId: "day",
});
const owner = "11111111-1111-4111-8111-111111111111";
const health = new WeakMap();
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
  await page.locator('[data-page="catalogs"]').click();
  await page
    .getByRole("button", { name: "Звонки и типы", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Звонки и типы", exact: true }),
  ).toBeVisible();
  return page.getByRole("dialog");
}
async function apply(page) {
  await page
    .getByRole("dialog")
    .getByRole("button", {
      name: "Сохранить настройки в черновик",
      exact: true,
    })
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
async function recover(page) {
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
function prepared(data) {
  data.siteSettings = {
    teaching: settings(),
    privateSibling: { marker: "NEVER_EXPORT_PRIVATE" },
  };
}

test("teaching presets save only to a durable owner draft, recover after reauthentication and publish without retiming historical lessons", async ({
  page,
}, info) => {
  const manager = await mockManager(page, {
    prepareData(data) {
      prepared(data);
      data.lessons.push({
        ...data.lessons[0],
        id: "historical-long",
        day: 1,
        start: "09:00",
        end: "17:00",
        type: "Тип из импорта",
      });
    },
  });
  await manager.login();
  const original = manager.state().data;
  const dialog = await open(page);
  await dialog
    .getByLabel("Название типа 1", { exact: true })
    .fill("Семинар <b>");
  await dialog
    .getByLabel("Название схемы", { exact: true })
    .fill("Новые звонки");
  await dialog.getByLabel("Начало интервала 1", { exact: true }).fill("09:05");
  await dialog.getByLabel("Конец интервала 1", { exact: true }).fill("09:55");
  await axe(page);
  const shots = resolve("../../outputs/teaching-next/screenshots");
  await mkdir(shots, { recursive: true });
  await page.screenshot({
    path: join(shots, `editor-${info.project.name}.png`),
  });
  await apply(page);
  expect(manager.writes()).toEqual([]);
  const changes = (await records(page))[0].changes;
  expect(changes).toHaveLength(1);
  expect(changes[0].path).toBe("siteSettings.teaching");
  expect(JSON.stringify(changes)).not.toContain("NEVER_EXPORT_PRIVATE");
  expect(JSON.stringify(changes)).not.toContain("historical-long");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Вход владельца", exact: true }),
  ).toBeVisible();
  await manager.login({ navigate: false });
  await recover(page);
  expect(manager.writes()).toEqual([]);
  await publish(page, manager);
  expect(manager.state().data.lessons).toEqual(original.lessons);
  expect(manager.state().data.exceptions).toEqual(original.exceptions);
  expect(manager.state().data.announcements).toEqual(original.announcements);
  expect(manager.state().data.siteSettings.privateSibling).toEqual(
    original.siteSettings.privateSibling,
  );
  expect(manager.state().data.siteSettings.teaching.lessonTypes[0].name).toBe(
    "Семинар <b>",
  );
  expect(
    manager.state().data.siteSettings.teaching.bellSchedules[0].slots[0].start,
  ).toBe("09:05");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("explicit slot selection sets start end and day offset; manual input clears it and arbitrary historical type text survives", async ({
  page,
}) => {
  const raw = "Тип <b>из импорта</b>";
  const manager = await mockManager(page, {
    prepareData(data) {
      prepared(data);
      data.lessons.push({
        ...data.lessons[0],
        id: "night-legacy",
        start: "23:00",
        end: "01:00",
        endDayOffset: 1,
        type: raw,
      });
    },
  });
  await manager.login();
  await page.locator('[data-page="schedule"]').click();
  await page
    .getByRole("button", { name: "Создать черновик", exact: true })
    .click();
  await page
    .locator("tbody tr")
    .filter({ hasText: "23:00" })
    .getByRole("button", { name: "Изменить", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Начало", { exact: true })).toHaveValue(
    "23:00",
  );
  await expect(dialog.getByLabel("Конец", { exact: true })).toHaveValue(
    "01:00",
  );
  await expect(dialog.getByLabel("Окончание", { exact: true })).toHaveValue(
    "1",
  );
  await expect(
    dialog.getByRole("combobox", { name: "Интервал звонков", exact: true }),
  ).toHaveValue("");
  await expect(dialog.getByLabel("Тип занятия", { exact: true })).toHaveValue(
    raw,
  );
  expect(
    await dialog
      .locator("#suggest-lesson-types option")
      .evaluateAll((rows) => rows.map((row) => row.value)),
  ).toContain(raw);
  await dialog
    .getByRole("combobox", { name: "Интервал звонков", exact: true })
    .selectOption("morning");
  await expect(dialog.getByLabel("Начало", { exact: true })).toHaveValue(
    "09:00",
  );
  await expect(dialog.getByLabel("Конец", { exact: true })).toHaveValue(
    "09:50",
  );
  await expect(dialog.getByLabel("Окончание", { exact: true })).toHaveValue(
    "0",
  );
  await dialog
    .getByRole("combobox", { name: "Интервал звонков", exact: true })
    .selectOption("night");
  await expect(dialog.getByLabel("Окончание", { exact: true })).toHaveValue(
    "1",
  );
  await dialog.getByLabel("Начало", { exact: true }).fill("22:00");
  await dialog.getByLabel("Конец", { exact: true }).fill("22:50");
  await dialog.getByLabel("Окончание", { exact: true }).selectOption("0");
  await expect(
    dialog.getByRole("combobox", { name: "Интервал звонков", exact: true }),
  ).toHaveValue("");
  await dialog
    .getByRole("button", { name: "Сохранить для участников", exact: true })
    .click();
  await saved(page);
  expect(manager.writes()).toEqual([]);
  await publish(page, manager);
  expect(
    manager.state().data.lessons.find((row) => row.id === "night-legacy"),
  ).toMatchObject({ start: "22:00", end: "22:50", endDayOffset: 0, type: raw });
});

test("cyclic midnight overlap and duplicate type names retain the editor input and cannot create a draft until corrected", async ({
  page,
}) => {
  const manager = await mockManager(page, { prepareData: prepared });
  await manager.login();
  const dialog = await open(page);
  await dialog.getByLabel("Начало интервала 1", { exact: true }).fill("00:30");
  await dialog.getByLabel("Конец интервала 1", { exact: true }).fill("01:30");
  await dialog
    .getByRole("button", {
      name: "Сохранить настройки в черновик",
      exact: true,
    })
    .click();
  await expect(dialog.locator(".form-error")).toContainText(/пересек/);
  await expect(
    dialog.getByLabel("Начало интервала 1", { exact: true }),
  ).toHaveValue("00:30");
  expect(await records(page)).toEqual([]);
  expect(manager.writes()).toEqual([]);
  await dialog.getByLabel("Начало интервала 1", { exact: true }).fill("01:00");
  await dialog.getByLabel("Название типа 2", { exact: true }).fill("СЕМИНАР");
  await dialog
    .getByRole("button", {
      name: "Сохранить настройки в черновик",
      exact: true,
    })
    .click();
  await expect(dialog.locator(".form-error")).toContainText("Повторяется");
  await dialog
    .getByLabel("Название типа 2", { exact: true })
    .fill("Другой тип");
  await apply(page);
  expect(manager.writes()).toEqual([]);
});

test("type and scheme lists add disable reorder and remove choices without touching lesson records", async ({
  page,
}) => {
  const manager = await mockManager(page, { prepareData: prepared });
  await manager.login();
  const original = manager.state().data.lessons,
    dialog = await open(page);
  await dialog
    .getByRole("button", { name: "Добавить тип", exact: true })
    .click();
  await dialog.getByLabel("Название типа 3", { exact: true }).fill("Экзамен");
  await dialog.getByRole("button", { name: "Тип 3 выше", exact: true }).click();
  await expect(
    dialog.getByLabel("Название типа 2", { exact: true }),
  ).toHaveValue("Экзамен");
  await dialog
    .getByRole("button", { name: "Убрать тип 3", exact: true })
    .click();
  await dialog.getByLabel("Предлагать тип 1", { exact: true }).uncheck();
  await dialog
    .getByRole("button", { name: "Добавить схему", exact: true })
    .click();
  await dialog
    .getByLabel("Название схемы", { exact: true })
    .fill("Экзаменационная");
  const scheme = await dialog
    .getByRole("combobox", { name: "Редактировать схему звонков", exact: true })
    .inputValue();
  await dialog
    .getByRole("combobox", { name: "Основная схема звонков", exact: true })
    .selectOption(scheme);
  await dialog
    .getByRole("button", { name: "Добавить интервал", exact: true })
    .click();
  await dialog.getByLabel("Начало интервала 2", { exact: true }).fill("10:00");
  await dialog.getByLabel("Конец интервала 2", { exact: true }).fill("10:50");
  await apply(page);
  await publish(page, manager);
  expect(manager.state().data.lessons).toEqual(original);
  expect(manager.state().data.siteSettings.teaching.defaultBellScheduleId).toBe(
    scheme,
  );
  expect(manager.state().data.siteSettings.teaching.lessonTypes).toMatchObject([
    { name: "Семинар", enabled: false },
    { name: "Экзамен", enabled: true },
  ]);
});

test("quota denial preserves the previous teaching copy and latest in-memory settings until explicit retry", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.IDBDatabase.prototype.transaction;
    window.IDBDatabase.prototype.transaction = function (names, mode, ...rest) {
      if (
        this.name === "uniflow-owner-drafts-v1" &&
        mode === "readwrite" &&
        localStorage.getItem("qa.teachingQuota") === "1"
      )
        throw Error("quota fixture");
      return original.call(this, names, mode, ...rest);
    };
  });
  const manager = await mockManager(page, { prepareData: prepared });
  await manager.login();
  let dialog = await open(page);
  await dialog
    .getByLabel("Название схемы", { exact: true })
    .fill("Первая копия");
  await apply(page);
  const original = (await records(page))[0];
  await page.evaluate(() => localStorage.setItem("qa.teachingQuota", "1"));
  dialog = await open(page);
  await dialog
    .getByLabel("Название схемы", { exact: true })
    .fill("Не потерять новую схему");
  await dialog
    .getByRole("button", {
      name: "Сохранить настройки в черновик",
      exact: true,
    })
    .click();
  await expect(page.locator("#draft-save-status")).toContainText(
    "Локальное сохранение недоступно",
  );
  expect((await records(page))[0]).toEqual(original);
  expect(manager.writes()).toEqual([]);
  await page.evaluate(() => localStorage.removeItem("qa.teachingQuota"));
  await page
    .getByRole("button", { name: "Повторить сохранение", exact: true })
    .click();
  await saved(page);
  expect(
    (await records(page))[0].changes[0].after.value.bellSchedules[0].name,
  ).toBe("Не потерять новую схему");
});

test("JSON export includes only authored teaching settings and a legacy import without them preserves the current configuration", async ({
  page,
}) => {
  const manager = await mockManager(page, { prepareData: prepared });
  await manager.login();
  await page.locator('[data-page="schedule"]').click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Экспорт JSON", exact: true }).click();
  const exported = JSON.parse(
    await readFile(await (await downloading).path(), "utf8"),
  );
  expect(Object.keys(exported.siteSettings)).toEqual(["teaching"]);
  expect(exported.siteSettings.teaching).toEqual(settings());
  expect(JSON.stringify(exported)).not.toContain("NEVER_EXPORT_PRIVATE");
  delete exported.siteSettings;
  exported.rooms[0].name = "204 из старого файла";
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Импорт JSON", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "legacy.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(exported)),
  });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Добавить в черновик", exact: true })
    .click();
  await saved(page);
  expect(manager.writes()).toEqual([]);
  await publish(page, manager);
  expect(manager.state().data.siteSettings.teaching).toEqual(settings());
  expect(manager.state().data.siteSettings.privateSibling.marker).toBe(
    "NEVER_EXPORT_PRIVATE",
  );
  expect(manager.state().data.rooms[0].name).toBe("204 из старого файла");
});

test("fallback offers legacy presets without persisting them and non-owner staff cannot configure them", async ({
  page,
  context,
}) => {
  const manager = await mockManager(page);
  await manager.login();
  const dialog = await open(page);
  await expect(
    dialog.getByLabel("Начало интервала 14", { exact: true }),
  ).toHaveValue("21:00");
  expect(await records(page)).toEqual([]);
  expect(manager.writes()).toEqual([]);
  await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
  expect(manager.state().data.siteSettings?.teaching).toBeUndefined();
  const other = await context.newPage();
  const staff = await mockManager(other, { role: "teacher" });
  await staff.login();
  await other.locator('[data-page="catalogs"]').click();
  await expect(
    other.getByRole("button", { name: "Звонки и типы", exact: true }),
  ).toHaveCount(0);
  expect(staff.writes()).toEqual([]);
  await other.close();
});

test("disabled observed types stay out of new suggestions while an existing exact value and manual entry remain valid", async ({
  page,
}) => {
  const manager = await mockManager(page, {
    prepareData(data) {
      prepared(data);
      data.siteSettings.teaching.lessonTypes = [
        "Лабораторная",
        "Практика",
        "Лекция",
        "Занятие",
      ].map((name, index) => ({
        id: "disabled-" + index,
        name,
        enabled: false,
      }));
    },
  });
  await manager.login();
  await page.locator('[data-page="schedule"]').click();
  await page
    .getByRole("button", { name: "Добавить занятие", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Тип занятия", { exact: true })).toHaveValue(
    "",
  );
  const values = await dialog
    .locator("#suggest-lesson-types option")
    .evaluateAll((rows) => rows.map((row) => row.value));
  expect(values).toEqual([]);
  await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
  await page
    .locator("tbody tr")
    .filter({ hasText: "11:00" })
    .getByRole("button", { name: "Изменить", exact: true })
    .click();
  await expect(dialog.getByLabel("Тип занятия", { exact: true })).toHaveValue(
    "Лекция",
  );
  expect(
    await dialog
      .locator("#suggest-lesson-types option")
      .evaluateAll((rows) => rows.map((row) => row.value)),
  ).toContain("Лекция");
  await dialog
    .getByLabel("Тип занятия", { exact: true })
    .fill("Введённый вручную тип");
  await expect(
    dialog.getByLabel("Тип занятия", { exact: true }),
  ).toHaveAttribute("maxlength", "40");
  expect(manager.writes()).toEqual([]);
});

test("teaching editor remains accessible in the dark theme without oversized checkboxes or horizontal overflow", async ({
  page,
}, info) => {
  const manager = await mockManager(page, { prepareData: prepared });
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
  await axe(page);
  const size = await dialog
    .getByLabel("Предлагать тип 1", { exact: true })
    .boundingBox();
  expect(size.width).toBe(20);
  expect(size.height).toBe(20);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const shots = resolve("../../outputs/teaching-next/screenshots");
  await mkdir(shots, { recursive: true });
  await page.screenshot({
    path: join(shots, `editor-dark-${info.project.name}.png`),
  });
});

test("a held server refresh cannot turn a stale teaching editor into a fresh-base overwrite", async ({
  page,
}) => {
  const manager = await mockManager(page, { prepareData: prepared });
  await manager.login();
  let dialog = await open(page);
  await dialog
    .getByLabel("Название типа 1", { exact: true })
    .fill("Моя несохранённая правка");
  const remote = settings();
  remote.lessonTypes[0].name = "Серверная правка";
  manager.advance("teaching.save", { settings: remote });
  let release, observed;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const requested = new Promise((resolve) => {
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
  await dialog
    .getByRole("button", {
      name: "Сохранить настройки в черновик",
      exact: true,
    })
    .click();
  await expect(dialog.locator("#form-error")).toContainText(
    "Откройте редактор заново",
  );
  await expect(
    dialog.getByLabel("Название типа 1", { exact: true }),
  ).toHaveValue("Моя несохранённая правка");
  expect(await records(page)).toEqual([]);
  expect(manager.writes()).toEqual([]);
  expect(manager.state().data.siteSettings.teaching).toEqual(remote);
  await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
  dialog = await open(page);
  await expect(
    dialog.getByLabel("Название типа 1", { exact: true }),
  ).toHaveValue("Серверная правка");
  await dialog
    .getByLabel("Название типа 1", { exact: true })
    .fill("Правка на актуальной версии");
  await apply(page);
  await publish(page, manager);
  expect(manager.state().data.siteSettings.teaching.lessonTypes[0].name).toBe(
    "Правка на актуальной версии",
  );
});
