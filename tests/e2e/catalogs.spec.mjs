import { test, expect } from "@playwright/test";
import { mockManager } from "./manager-fixture.mjs";
import { mkdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";

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
const row = (page, name) =>
  page
    .locator("tbody tr")
    .filter({ has: page.locator("strong").filter({ hasText: name }) });
async function catalog(page, kind = "groups") {
  await page.locator('[data-page="catalogs"]').click();
  await page.locator(`[data-kind="${kind}"]`).click();
}
async function save(page) {
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Сохранить", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await saved(page);
}
async function records(page) {
  return page.evaluate(
    async (owner) =>
      (await import("/schedule/manage/drafts.mjs"))
        .createDraftJournal()
        .list(owner),
    owner,
  );
}
async function recover(page, button = "Восстановить в черновик") {
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
    .getByRole("button", { name: button, exact: true })
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

test("group metadata is literal searchable durable draft data and requires reauthentication, recovery and separate publication", async ({
  page,
}, info) => {
  const issues = [];
  page.on("pageerror", (error) => issues.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()))
      issues.push(message.text());
  });
  const manager = await mockManager(page);
  await manager.login();
  await catalog(page);
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  const dialog = page.getByRole("dialog"),
    literal = '<img src=x onerror="alert(1)"> Группа';
  await dialog.getByLabel("Название / имя", { exact: true }).fill(literal);
  await dialog
    .getByLabel("Публичный код группы", { exact: true })
    .fill("IT-2030");
  await dialog
    .getByLabel("Специальность", { exact: true })
    .fill("Информационные системы");
  await dialog.getByLabel("Язык обучения", { exact: true }).selectOption("kk");
  await dialog
    .getByLabel("Подгруппы через запятую", { exact: true })
    .fill("А, Б");
  await axe(page);
  const shots = resolve("../../outputs/catalog-next/screenshots");
  await mkdir(shots, { recursive: true });
  await page.screenshot({
    path: join(shots, `group-form-${info.project.name}.png`),
  });
  await save(page);
  expect(manager.writes()).toEqual([]);
  await page
    .getByRole("searchbox", { name: "Найти в справочнике", exact: true })
    .fill("IT-2030");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(row(page, literal).locator("img")).toHaveCount(0);
  await expect(row(page, literal)).toContainText("Казахский");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Вход владельца", exact: true }),
  ).toBeVisible();
  await manager.login({ navigate: false });
  await recover(page);
  await catalog(page);
  await expect(row(page, literal)).toBeVisible();
  expect(manager.writes()).toEqual([]);
  await publish(page, manager);
  const group = manager
    .state()
    .data.groups.find((group) => group.code === "IT-2030");
  expect(group).toMatchObject({
    name: literal,
    specialty: "Информационные системы",
    language: "kk",
    subgroups: ["А", "Б"],
  });
  expect(manager.state().data.lessons).toHaveLength(4);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(issues).toEqual([]);
});

test("archiving and restoring a used group retain every schedule and private archive row until explicit publication", async ({
  page,
}) => {
  const manager = await mockManager(page, {
    archived: true,
    prepareData(data) {
      data.groups[0].archived = true;
      data.groups[0].archivedAt = null;
      data.groups[0].sourceNote = "Original provenance";
    },
  });
  await manager.login();
  const original = manager.state().data;
  await catalog(page);
  await row(page, "06-057-25-11")
    .getByRole("button", { name: "В архив", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Занятия: 4");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "В архив в черновике", exact: true })
    .click();
  await saved(page);
  await expect(page.locator("tbody tr")).toHaveCount(0);
  expect(manager.writes()).toEqual([]);
  await publish(page, manager);
  expect(manager.state().data.groups[0].archivedAt).toEqual(expect.any(String));
  for (const kind of ["lessons", "tasks", "requests", "attendance"])
    expect(manager.state().data[kind]).toEqual(original[kind]);
  await page
    .getByLabel("Состояние групп", { exact: true })
    .selectOption("archived");
  await row(page, "06-057-25-11")
    .getByRole("button", { name: "Восстановить", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Восстановить в черновике", exact: true })
    .click();
  await saved(page);
  await publish(page, manager);
  const group = manager.state().data.groups[0];
  expect(group.archivedAt).toBeNull();
  expect(group.archived).toBe(true);
  expect(group.sourceNote).toBe("Original provenance");
  await page
    .getByLabel("Состояние групп", { exact: true })
    .selectOption("active");
  await expect(row(page, "06-057-25-11")).toBeVisible();
});

test("duplicate is explicitly metadata-only and copies no lessons, archive data or fabricated provenance", async ({
  page,
}) => {
  const manager = await mockManager(page, {
    archived: true,
    prepareData(data) {
      Object.assign(data.groups[0], {
        code: "ORIGINAL",
        specialty: "IT",
        language: "ru",
        sourceNote: "Never fabricate",
      });
    },
  });
  await manager.login();
  const original = manager.state().data;
  await catalog(page);
  await row(page, "06-057-25-11")
    .getByRole("button", { name: "Дублировать без расписания", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "Расписание, задания, архивы и исходные ссылки не копируются",
  );
  await page
    .getByRole("dialog")
    .getByLabel("Название копии", { exact: true })
    .fill("Новая группа");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Создать копию в черновике", exact: true })
    .click();
  await saved(page);
  expect(manager.writes()).toEqual([]);
  await publish(page, manager);
  const copy = manager
    .state()
    .data.groups.find((group) => group.name === "Новая группа");
  expect(copy.id).not.toBe(original.groups[0].id);
  expect(copy).toMatchObject({
    code: "",
    specialty: "IT",
    language: "ru",
    subgroups: ["А", "Б"],
  });
  expect(copy.sourceNote).toBeUndefined();
  for (const kind of ["lessons", "tasks", "requests", "attendance"])
    expect(manager.state().data[kind]).toEqual(original[kind]);
});

test("used group replacement survives reauthentication as a primitive intent and repoints fresh private references only on publish", async ({
  page,
}) => {
  const manager = await mockManager(page, {
    archived: true,
    prepareData(data) {
      data.announcements = [
        {
          id: "private-notice",
          title: "Private body marker",
          body: "Not in draft storage",
          groupId: "g-main",
          roles: ["student"],
          createdAt: "2026-11-06T04:00:00Z",
        },
      ];
      data.groups[0].provenance = { private: "Original metadata" };
    },
  });
  await manager.login();
  await catalog(page);
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Название / имя", { exact: true })
    .fill("Замена группы");
  await save(page);
  await row(page, "06-057-25-11")
    .getByRole("button", { name: "Удалить", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Объявления: 1");
  await expect(dialog).toContainText("Архив посещаемости: 1");
  const picker = dialog.getByLabel("Конечная запись для замены", {
    exact: true,
  });
  const target = await picker
    .locator("option")
    .filter({ hasText: "Замена группы" })
    .getAttribute("value");
  await picker.selectOption(target);
  await dialog
    .getByRole("button", { name: "Заменить в черновике", exact: true })
    .click();
  await saved(page);
  await expect(row(page, "06-057-25-11")).toHaveCount(0);
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await dialog
    .getByLabel("Название / имя", { exact: true })
    .fill("Третья группа");
  await save(page);
  await row(page, "Замена группы")
    .getByRole("button", { name: "Удалить", exact: true })
    .click();
  const third = await picker
    .locator("option")
    .filter({ hasText: "Третья группа" })
    .getAttribute("value");
  await picker.selectOption(third);
  await dialog
    .getByRole("button", { name: "Заменить в черновике", exact: true })
    .click();
  await expect(dialog.locator(".form-error")).toContainText("Цепочки замен");
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(row(page, "Замена группы")).toBeVisible();
  const local = (await records(page))[0],
    serialized = JSON.stringify(local);
  expect(local.changes).toContainEqual({
    kind: "catalogReplacement",
    entity: "groups",
    id: "g-main",
    replacementId: target,
  });
  for (const privateValue of [
    "Not in draft storage",
    "Private body marker",
    "archived-student",
    "archived-request",
    "Original metadata",
  ])
    expect(serialized).not.toContain(privateValue);
  expect(manager.writes()).toEqual([]);
  await page.reload();
  await manager.login({ navigate: false });
  await recover(page);
  expect(manager.writes()).toEqual([]);
  await publish(page, manager);
  const state = manager.state().data;
  expect(state.groups.map((group) => group.id)).toEqual([target, third]);
  expect(state.lessons.every((lesson) => lesson.groupId === target)).toBe(true);
  expect(state.tasks[0].groupId).toBe(target);
  expect(
    state.announcements.find((row) => row.id === "private-notice").groupId,
  ).toBe(target);
  expect(state.requests).toHaveLength(1);
  expect(state.attendance).toHaveLength(1);
  expect(manager.writes()[0].payload.catalogReplacements).toEqual([
    { entity: "groups", id: "g-main", replacementId: target },
  ]);
});

test("incompatible group replacement and a real room collision cannot delete or partially rewrite a used record", async ({
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
        id: "other-room",
        groupId: "other",
        teacherId: null,
        roomId: "205",
      });
    },
  });
  await manager.login();
  await catalog(page);
  await row(page, "06-057-25-11")
    .getByRole("button", { name: "Удалить", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "Удаление заблокировано",
  );
  await expect(
    page
      .getByRole("dialog")
      .getByLabel("Конечная запись для замены", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Понятно", exact: true })
    .click();
  await catalog(page, "rooms");
  await row(page, /^204$/)
    .getByRole("button", { name: "Удалить", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Конечная запись для замены", { exact: true })
    .selectOption("205");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Заменить в черновике", exact: true })
    .click();
  await expect(page.getByRole("dialog").locator(".form-error")).toContainText(
    "Аудитория уже занята · Пятница 08:00",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Закрыть", exact: true })
    .click();
  await expect(row(page, /^204$/)).toBeVisible();
  expect(manager.writes()).toEqual([]);
  expect(
    manager.state().data.lessons.find((lesson) => lesson.id === "now-a").roomId,
  ).toBe("204");
});

test("room unknown capacity, owner-only note and subject short name retain metadata without inventing a confirmed capacity", async ({
  page,
}) => {
  const manager = await mockManager(page, {
    prepareData(data) {
      Object.assign(data.rooms[0], {
        capacityEstimated: true,
        sourceNote: { keep: "unknown original" },
      });
      Object.assign(data.subjects[0], { shortName: "АЛГ", color: "#124678" });
    },
  });
  await manager.login();
  await catalog(page, "rooms");
  await row(page, /^204$/)
    .getByRole("button", { name: "Изменить", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByLabel("Достоверность вместимости", { exact: true }),
  ).toHaveValue("estimated");
  await dialog.getByLabel("Корпус", { exact: true }).fill("Учебный корпус");
  await dialog.getByLabel("Этаж", { exact: true }).fill("цоколь");
  await dialog
    .getByLabel("Примечание владельца (не показывается студентам)", {
      exact: true,
    })
    .fill("Ключ только у владельца");
  await save(page);
  await expect(row(page, /^204$/)).toContainText("Вместимость не подтверждена");
  await catalog(page, "subjects");
  await row(page, "Алгоритмы")
    .getByRole("button", { name: "Изменить", exact: true })
    .click();
  await expect(
    dialog.getByLabel("Цвет (#RRGGBB)", { exact: true }),
  ).toHaveValue("#124678");
  await dialog.getByLabel("Короткое название", { exact: true }).fill("Алго");
  await save(page);
  await publish(page, manager);
  expect(manager.state().data.rooms[0]).toMatchObject({
    capacityEstimated: true,
    building: "Учебный корпус",
    floor: "цоколь",
    note: "Ключ только у владельца",
    sourceNote: { keep: "unknown original" },
  });
  expect(manager.state().data.subjects[0]).toMatchObject({
    shortName: "Алго",
    color: "#124678",
  });
});

test("catalog quota failure keeps the previous durable generation and allows an explicit safe save retry", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.IDBDatabase.prototype.transaction;
    window.IDBDatabase.prototype.transaction = function (names, mode, ...rest) {
      if (
        this.name === "uniflow-owner-drafts-v1" &&
        mode === "readwrite" &&
        localStorage.getItem("qa.catalogQuota") === "1"
      )
        throw Error("quota fixture");
      return original.call(this, names, mode, ...rest);
    };
  });
  const manager = await mockManager(page);
  await manager.login();
  await catalog(page, "subjects");
  await row(page, "Алгоритмы")
    .getByRole("button", { name: "Изменить", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Короткое название", { exact: true })
    .fill("Первая копия");
  await save(page);
  const original = (await records(page))[0];
  await page.evaluate(() => localStorage.setItem("qa.catalogQuota", "1"));
  await row(page, "Алгоритмы")
    .getByRole("button", { name: "Изменить", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Короткое название", { exact: true })
    .fill("Не потерять");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Сохранить", exact: true })
    .click();
  await expect(page.locator("#draft-save-status")).toContainText(
    "Локальное сохранение недоступно",
  );
  expect((await records(page))[0]).toEqual(original);
  expect(manager.writes()).toEqual([]);
  await page.evaluate(() => localStorage.removeItem("qa.catalogQuota"));
  await page
    .getByRole("button", { name: "Повторить сохранение", exact: true })
    .click();
  await saved(page);
  expect(
    (await records(page))[0].changes.find(
      (change) => change.kind === "subjects",
    ).after.shortName,
  ).toBe("Не потерять");
});

test("a published active group shares a local QR and stable public URL while unpublished or archived groups are blocked", async ({
  page,
}, info) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        async writeText(value) {
          globalThis.catalogCopiedUrl = value;
        },
      },
    }),
  );
  const manager = await mockManager(page);
  await manager.login();
  await catalog(page);
  await row(page, "06-057-25-11")
    .getByRole("button", { name: "Ссылка / QR", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("img", {
      name: "QR-код публичной ссылки на группу",
      exact: true,
    }),
  ).toBeVisible();
  await dialog
    .getByLabel("Подгруппа для ссылки", { exact: true })
    .selectOption("Б");
  await dialog
    .getByRole("button", { name: "Скопировать ссылку", exact: true })
    .click();
  const url = new URL(await page.evaluate(() => globalThis.catalogCopiedUrl));
  expect(url.pathname).toBe("/schedule/");
  expect([...url.searchParams.keys()].sort()).toEqual(["g", "subgroup"]);
  expect(url.searchParams.get("g")).toBe("g-main");
  expect(url.searchParams.get("subgroup")).toBe("Б");
  expect(url.hash).toBe("");
  await axe(page);
  const download = page.waitForEvent("download");
  await dialog
    .getByRole("button", { name: "Скачать QR (SVG)", exact: true })
    .click();
  expect((await download).suggestedFilename()).toBe("uniflow-group-g-main.svg");
  const shots = resolve("../../outputs/catalog-next/screenshots");
  await mkdir(shots, { recursive: true });
  await page.screenshot({
    path: join(shots, `group-qr-${info.project.name}.png`),
  });
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await row(page, "06-057-25-11")
    .getByRole("button", { name: "Дублировать без расписания", exact: true })
    .click();
  await dialog
    .getByLabel("Название копии", { exact: true })
    .fill("Не опубликована");
  await dialog
    .getByRole("button", { name: "Создать копию в черновике", exact: true })
    .click();
  await saved(page);
  await row(page, "Не опубликована")
    .getByRole("button", { name: "Ссылка / QR", exact: true })
    .click();
  await expect(page.locator("#toast")).toContainText(
    "Сначала опубликуй новую группу",
  );
  await expect(dialog).not.toBeVisible();
  await row(page, "06-057-25-11")
    .getByRole("button", { name: "В архив", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "В архив в черновике", exact: true })
    .click();
  await saved(page);
  await page
    .getByLabel("Состояние групп", { exact: true })
    .selectOption("archived");
  await row(page, "06-057-25-11")
    .getByRole("button", { name: "Ссылка / QR", exact: true })
    .click();
  await expect(page.locator("#toast")).toContainText(
    "восстановления группы из архива",
  );
  expect(manager.writes()).toEqual([]);
});

test("room finder releases archived schedule occupancy and reports unknown capacity separately from rooms meeting the minimum", async ({
  page,
}) => {
  const manager = await mockManager(page, {
    prepareData(data) {
      data.rooms.push({
        id: "unknown",
        name: "Неизвестная вместимость",
        capacity: 5,
        capacityEstimated: true,
      });
      data.rooms.push({
        id: "small",
        name: "Маленькая подтверждённая",
        capacity: 5,
      });
    },
  });
  await manager.login();
  const findRooms = async () => {
    await catalog(page, "rooms");
    await page
      .getByRole("button", { name: "Найти свободную", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Дата", { exact: true }).fill("2026-11-06");
    await dialog.getByLabel("Минимум мест", { exact: true }).fill("20");
    await dialog.getByLabel("Начало", { exact: true }).fill("08:00");
    await dialog.getByLabel("Конец", { exact: true }).fill("09:00");
    await dialog.getByRole("button", { name: "Найти", exact: true }).click();
    await expect(dialog.locator("#free-results")).toContainText(
      "Вместимость неизвестна; подтвердите отдельно: Неизвестная вместимость",
    );
    await expect(dialog.locator("#free-results")).not.toContainText(
      "Маленькая подтверждённая",
    );
    await expect(dialog.locator("#free-results")).not.toContainText("5 мест");
    return dialog;
  };
  let dialog = await findRooms();
  await expect(dialog.locator("#free-results")).not.toContainText("204");
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await catalog(page);
  await row(page, "06-057-25-11")
    .getByRole("button", { name: "В архив", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "В архив в черновике", exact: true })
    .click();
  await saved(page);
  dialog = await findRooms();
  await expect(dialog.locator("#free-results")).toContainText("204 (30 мест)");
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await catalog(page);
  await page
    .getByLabel("Состояние групп", { exact: true })
    .selectOption("archived");
  await row(page, "06-057-25-11")
    .getByRole("button", { name: "Восстановить", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Восстановить в черновике", exact: true })
    .click();
  await saved(page);
  dialog = await findRooms();
  await expect(dialog.locator("#free-results")).not.toContainText("204");
  expect(manager.writes()).toEqual([]);
});

test("held rollback blocks catalog edits and publication even after closing its dialog, retaining the exact local copy for recovery", async ({
  page,
}) => {
  const manager = await mockManager(page);
  await manager.login();
  await catalog(page, "subjects");
  await row(page, "Алгоритмы")
    .getByRole("button", { name: "Изменить", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Короткое название", { exact: true })
    .fill("Published basis");
  await save(page);
  await publish(page, manager);
  await catalog(page);
  await row(page, "06-057-25-11")
    .getByRole("button", { name: "Изменить", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Специальность", { exact: true })
    .fill("Сохранить перед откатом");
  await save(page);
  const pending = (await records(page)).find(
    (record) => record.status === "active",
  );
  let release, observed;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const requested = new Promise((resolve) => {
    observed = resolve;
  });
  await page.route("**/functions/v1/uniflow-api", async (route) => {
    if (route.request().postDataJSON().action === "rollback") {
      observed();
      await gate;
    }
    return route.fallback();
  });
  await page.locator('[data-page="history"]').click();
  await page.locator('[data-action="rollback"]').first().click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Восстановить", exact: true })
    .click();
  await requested;
  try {
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Закрыть", exact: true })
      .click();
    await page.locator('[data-page="catalogs"]').click();
    await expect(
      page.getByRole("button", { name: "Добавить", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Опубликовать", exact: true }),
    ).toBeDisabled();
    await expect(
      row(page, "06-057-25-11").getByRole("button", {
        name: "Изменить",
        exact: true,
      }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Добавить", exact: true })
      .evaluate((button) => button.click());
    await page
      .getByRole("button", { name: "Опубликовать", exact: true })
      .evaluate((button) => button.click());
    await expect(page.getByRole("dialog")).not.toBeVisible();
    expect(manager.writes()).toHaveLength(1);
    expect(
      (await records(page)).find((record) => record.id === pending.id),
    ).toEqual(pending);
  } finally {
    release();
  }
  await expect(page.locator("#toast")).toContainText("Версия восстановлена");
  const retained = (await records(page)).find(
    (record) => record.id === pending.id,
  );
  expect(retained.changes).toEqual(pending.changes);
  expect(retained.generation).toBe(pending.generation + 1);
  expect(retained.status).toBe("archived");
  expect(retained.reason).toBe("rollback");
  await expect(
    page.getByRole("button", { name: "Создать черновик", exact: true }),
  ).toBeEnabled();
  expect(manager.writes().map((call) => call.action)).toEqual([
    "mutate",
    "rollback",
  ]);
});

test("room finder blocks both sides of an overnight lesson and frees its exact ending boundary", async ({
  page,
}) => {
  const manager = await mockManager(page, {
    prepareData(data) {
      data.lessons.push({
        ...data.lessons[0],
        id: "overnight-room",
        start: "23:00",
        end: "01:00",
        endDayOffset: 1,
      });
    },
  });
  await manager.login();
  await catalog(page, "rooms");
  await page
    .getByRole("button", { name: "Найти свободную", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const find = async (date, start, end) => {
    await dialog.getByLabel("Дата", { exact: true }).fill(date);
    await dialog.getByLabel("Начало", { exact: true }).fill(start);
    await dialog.getByLabel("Конец", { exact: true }).fill(end);
    await dialog.getByRole("button", { name: "Найти", exact: true }).click();
  };
  await find("2026-11-06", "23:30", "23:59");
  await expect(dialog.locator("#free-results")).toContainText("205 (30 мест)");
  await expect(dialog.locator("#free-results")).not.toContainText("204");
  await find("2026-11-07", "00:30", "00:50");
  await expect(dialog.locator("#free-results")).not.toContainText("204");
  await find("2026-11-07", "01:00", "01:30");
  await expect(dialog.locator("#free-results")).toContainText("204 (30 мест)");
  await find("2026-11-06", "23:30", "00:30");
  await expect(dialog.locator(".form-error")).toContainText(
    "Конец должен быть позже начала",
  );
  await expect(dialog.locator("#free-results")).toHaveCount(0);
  expect(manager.writes()).toEqual([]);
});
