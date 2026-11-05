import { test, expect } from "@playwright/test";
import { mockState } from "./fixtures.mjs";

test("incorrect staff password is rejected without receiving a session", async ({
  page,
}) => {
  const requests = await mockState(page);
  await page.route("https://cdn.jsdelivr.net/**", (route) => route.abort());
  await page.goto("/schedule/beta/manage/");
  await page.locator('[data-action="login"]').click();
  await page.getByLabel("Логин", { exact: true }).fill("admin");
  await page
    .getByLabel("Пароль", { exact: true })
    .fill("incorrect-test-password");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Войти", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByText("Неверный логин или пароль"),
  ).toBeVisible();
  expect(requests.some((req) => req.action === "login")).toBe(true);
  expect(
    requests.every((req) => !["mutate", "rollback"].includes(req.action)),
  ).toBe(true);
  const stored = await page.evaluate(() =>
    Object.entries(localStorage).filter(([key]) => /token|session/i.test(key)),
  );
  expect(stored).toEqual([]);
});

test("admin can preview and publish a one-date draft and restore the previous demo version", async ({
  page,
}) => {
  const requests = await mockState(page);
  await page.route("https://cdn.jsdelivr.net/**", (route) => route.abort());
  await page.goto("/schedule/beta/manage/?demo=admin");
  await page.locator('[data-page="schedule"]').click();
  await page
    .getByRole("button", { name: "Создать черновик", exact: true })
    .click();
  const revision = await page.evaluate(
    () => JSON.parse(localStorage.getItem("uf.demo.source.v4")).revision,
  );
  await page.locator('[data-action="exception"]').first().click();
  await page
    .getByRole("dialog")
    .getByRole("combobox", { name: "Действие", exact: true })
    .selectOption("cancelled");
  await page
    .getByRole("dialog")
    .getByLabel("Причина / комментарий", { exact: true })
    .fill("Тестовая отмена в изолированном демо");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Применить на дату", exact: true })
    .click();
  await expect(
    page.getByText("Отменено", { exact: true }).first(),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("uf.demo.source.v4")).revision,
    ),
  ).toBe(revision);
  await page
    .getByRole("button", { name: "Предпросмотр студента", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("heading", { name: "Предпросмотр студента", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog").getByText(/Отменено/)).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Закрыть", exact: true })
    .click();
  await page.getByRole("button", { name: "Опубликовать", exact: true }).click();
  await expect(
    page.getByText(
      "Черновик опубликован. Предыдущая версия доступна в истории.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("uf.demo.source.v4")).revision,
    ),
  ).toBe(revision + 1);
  await page.locator('[data-page="history"]').click();
  await page.locator('[data-action="rollback"]').first().click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Восстановить", exact: true })
    .click();
  await expect(
    page.getByText("Версия восстановлена", { exact: true }),
  ).toBeVisible();
  await page.locator('[data-page="schedule"]').click();
  await expect(page.getByText("Отменено", { exact: true })).toHaveCount(0);
  expect(requests).toEqual([]);
});

test("copying onto the same day fails validation and does not publish a draft", async ({
  page,
}) => {
  const requests = await mockState(page);
  await page.goto("/schedule/beta/manage/?demo=admin");
  await page.locator('[data-page="schedule"]').click();
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
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("uf.demo.source.v4")).revision,
    ),
  ).toBe(1);
  expect(requests).toEqual([]);
});

test("staff assignment title stays text through escaped template rendering", async ({
  page,
}) => {
  const requests = await mockState(page);
  await page.goto("/schedule/beta/manage/?demo=admin");
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
  expect(requests).toEqual([]);
});

test("moving a date keeps a student notice on the source day and shows the lesson on its target day", async ({
  page,
}) => {
  const requests = await mockState(page);
  await page.goto("/schedule/beta/manage/?demo=admin");
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
  await page.goto("/schedule/beta/?demo=student");
  await expect(
    page.getByRole("heading", { name: "Изменения", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Одно занятие перенесено на воскресенье", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/6 нояб.*→.*8 нояб/)).toBeVisible();
  await page.getByRole("button", { name: "Неделя", exact: true }).click();
  await expect(
    page.locator("#day-2026-11-08").getByRole("heading", {
      name: "Алгоритмдер және деректер құрылымы",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.locator("#day-2026-11-06").getByRole("heading", {
      name: "Алгоритмдер және деректер құрылымы",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(requests).toEqual([]);
});
