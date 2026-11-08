import { test, expect } from "@playwright/test";
import { mockManager } from "./manager-fixture.mjs";
import { mockState } from "./fixtures.mjs";

test("management requires owner login and rejects an incorrect password without a session", async ({
  page,
}) => {
  const manager = await mockManager(page, { rejectPassword: true });
  await page.goto("/schedule/manage/");
  await expect(page).toHaveURL(/\/admin\/$/);
  await manager.login({ navigate: false });
  await expect(page.getByRole("alert")).toBeVisible();
  expect(manager.calls.some((call) => call.action === "login.begin")).toBe(
    true,
  );
  expect(manager.calls.some((call) => call.action === "login.verify")).toBe(
    false,
  );
  expect(manager.writes()).toEqual([]);
  expect(
    await page.evaluate(() =>
      Object.entries(localStorage).filter(([key]) =>
        /token|session/i.test(key),
      ),
    ),
  ).toEqual([]);
});

test("owner previews and publishes a one-date draft, then restores the server version", async ({
  page,
}) => {
  const manager = await mockManager(page);
  await manager.login();
  await page.locator('[data-page="schedule"]').click();
  await page
    .getByRole("button", { name: "Создать черновик", exact: true })
    .click();
  const revision = manager.state().revision;
  await page.locator('[data-action="exception"]').first().click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("combobox", { name: "Действие", exact: true })
    .selectOption("cancelled");
  await dialog
    .getByLabel("Причина / комментарий", { exact: true })
    .fill("Тестовая отмена");
  await dialog
    .getByRole("button", { name: "Применить на дату", exact: true })
    .click();
  await expect(
    page.getByText("Отменено", { exact: true }).first(),
  ).toBeVisible();
  expect(manager.state().revision).toBe(revision);
  expect(manager.writes()).toEqual([]);
  await page
    .getByRole("button", { name: "Предпросмотр студента", exact: true })
    .click();
  await expect(
    dialog.getByRole("heading", { name: "Предпросмотр студента", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText(/Отменено/)).toBeVisible();
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await page.getByRole("button", { name: "Опубликовать", exact: true }).click();
  await expect(
    page.getByText(
      "Черновик опубликован. Предыдущая версия доступна в истории.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(manager.state().revision).toBe(revision + 1);
  expect(manager.writes()).toHaveLength(1);
  expect(manager.writes()[0].op).toBe("import");
  await page.locator('[data-page="history"]').click();
  await page.locator('[data-action="rollback"]').first().click();
  await dialog
    .getByRole("button", { name: "Восстановить", exact: true })
    .click();
  await expect(
    page.getByText("Версия восстановлена", { exact: true }),
  ).toBeVisible();
  await page.locator('[data-page="schedule"]').click();
  await expect(page.getByText("Отменено", { exact: true })).toHaveCount(0);
  expect(manager.state().revision).toBe(revision + 2);
  expect(manager.state().data.exceptions).toEqual([]);
});

test("copying onto the same day fails without sending a publish request", async ({
  page,
}) => {
  const manager = await mockManager(page);
  await manager.login();
  await page.locator('[data-page="schedule"]').click();
  const before = manager.state();
  await page
    .getByRole("button", { name: "Копировать день", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("combobox", { name: "Откуда", exact: true })
    .selectOption("4");
  await dialog
    .getByRole("combobox", { name: "Куда", exact: true })
    .selectOption("4");
  await dialog
    .getByRole("button", { name: "Добавить в черновик", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).not.toBeEmpty();
  expect(manager.state()).toEqual(before);
  expect(manager.writes()).toEqual([]);
});

test("assignment title remains literal text through server mutation and escaped rendering", async ({
  page,
}) => {
  const manager = await mockManager(page);
  await manager.login();
  await page.locator('[data-page="tasks"]').click();
  await page.locator('[data-action="task"]').first().click();
  const title = '<img src=x onerror="window.xssExecuted=true">';
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Название", { exact: true }).fill(title);
  await dialog
    .getByRole("button", { name: "Опубликовать", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  expect(await page.locator("main img, main script").count()).toBe(0);
  expect(await page.evaluate(() => globalThis.xssExecuted)).toBeUndefined();
  expect(manager.state().data.tasks.some((task) => task.title === title)).toBe(
    true,
  );
  expect(manager.writes()).toHaveLength(1);
});

test("moving one date keeps a source notice and renders the lesson on its target day", async ({
  page,
}) => {
  const manager = await mockManager(page);
  await manager.login();
  await page.locator('[data-page="schedule"]').click();
  await page
    .getByRole("button", { name: "Создать черновик", exact: true })
    .click();
  await page.locator('[data-action="exception"]').first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Новая дата", { exact: true }).fill("2026-11-08");
  await dialog
    .getByLabel("Причина / комментарий", { exact: true })
    .fill("Одно занятие перенесено на воскресенье");
  await dialog
    .getByRole("button", { name: "Применить на дату", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "Опубликовать", exact: true }).click();
  await expect(
    page.getByText(
      "Черновик опубликован. Предыдущая версия доступна в истории.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.goto("/schedule/");
  await expect(
    page.getByRole("heading", { name: "Изменения", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Одно занятие перенесено на воскресенье", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/6 нояб.*→.*8 нояб/)).toBeVisible();
  await page.getByRole("button", { name: "Неделя", exact: true }).click();
  await expect(
    page
      .locator("#day-2026-11-08")
      .getByRole("heading", { name: "Алгоритмы", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator("#day-2026-11-06")
      .getByRole("heading", { name: "Алгоритмы", exact: true }),
  ).toHaveCount(0);
  expect(manager.writes()).toHaveLength(1);
});

test("owner workspace omits retired role workflows and publishing retains archived records", async ({
  page,
}) => {
  const manager = await mockManager(page, { archived: true });
  const before = manager.state();
  await manager.login();
  for (const section of [
    "overview",
    "schedule",
    "tasks",
    "notifications",
    "catalogs",
    "conflicts",
    "history",
    "guide",
  ]) {
    await page.locator(`[data-page="${section}"]`).click();
    await expect(
      page.locator(
        '[data-page="requests"], [data-page="attendance"], [data-action="request"], [data-action="decide"], [data-action="attendanceCsv"], [data-attendance]',
      ),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: /Запрос переноса|Запросить перенос|Согласовать перенос/,
      }),
    ).toHaveCount(0);
  }
  await page.locator('[data-page="schedule"]').click();
  await page
    .getByRole("button", { name: "Создать черновик", exact: true })
    .click();
  await page.locator('[data-action="exception"]').first().click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("combobox", { name: "Действие", exact: true })
    .selectOption("cancelled");
  await dialog
    .getByRole("button", { name: "Применить на дату", exact: true })
    .click();
  await page.getByRole("button", { name: "Опубликовать", exact: true }).click();
  await expect(
    page.getByText(
      "Черновик опубликован. Предыдущая версия доступна в истории.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(manager.state().data.attendance).toEqual(before.data.attendance);
  expect(manager.state().data.requests).toEqual(before.data.requests);
  expect(manager.writes()).toHaveLength(1);
  expect(manager.writes()[0].op).toBe("import");
});

test("owner shares subgroup Б through a canonical link that a fresh student confirms", async ({
  page,
  browser,
  baseURL,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        async writeText(value) {
          globalThis.managerCopiedUrl = String(value);
        },
      },
    });
  });
  const manager = await mockManager(page);
  await manager.login();
  await page.locator('[data-page="schedule"]').click();
  await page.locator('[data-filter="subgroup"]').last().selectOption("Б");
  await page.getByRole("button", { name: "Поделиться", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Скопировать ссылку", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => globalThis.managerCopiedUrl))
    .toBeTruthy();
  const copied = new URL(
    await page.evaluate(() => globalThis.managerCopiedUrl),
  );
  expect(copied.origin).toBe(new URL(baseURL).origin);
  expect(copied.pathname).toBe("/schedule/");
  expect(copied.searchParams.get("g")).toBe("g-main");
  expect(copied.searchParams.get("subgroup")).toBe("Б");
  expect(copied.searchParams.has("sub")).toBe(false);
  expect(manager.writes()).toEqual([]);

  const freshContext = await browser.newContext({
    viewport: page.viewportSize(),
    timezoneId: "Pacific/Honolulu",
  });
  try {
    const student = await freshContext.newPage();
    const requests = await mockState(student, { savedChoice: false });
    await student.goto(copied.href);
    await expect(
      student.getByRole("heading", { name: "Выбери свою группу", exact: true }),
    ).toBeVisible();
    await expect(
      student.getByRole("combobox", { name: "Группа", exact: true }),
    ).toHaveValue("g-main");
    await expect(
      student.getByRole("combobox", { name: "Подгруппа", exact: true }),
    ).toHaveValue("Б");
    await expect(student.locator("#navigation")).toBeHidden();
    await student
      .getByRole("button", {
        name: "Сохранить и открыть расписание",
        exact: true,
      })
      .click();
    await expect(student.locator("#identity")).toHaveText("06-057-25-11 · Б");
    await expect(student.locator("#navigation")).toBeVisible();
    expect(requests.every((request) => request.action === "state")).toBe(true);
  } finally {
    await freshContext.close();
  }
});
