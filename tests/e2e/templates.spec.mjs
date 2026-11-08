import { test, expect } from "@playwright/test";
import { mockManager } from "./manager-fixture.mjs";

test("named day templates save locally, survive reload, validate conflicts and apply only to a publishable draft", async ({
  page,
}) => {
  const manager = await mockManager(page);
  await manager.login();
  await page.locator('[data-page="schedule"]').click();
  const before = manager.state();
  const title = '<img src=x onerror="window.templateXss=1">';
  await page.getByRole("button", { name: "Шаблоны", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Сохранить новый шаблон", exact: true })
    .click();
  await dialog.getByLabel("Название шаблона", { exact: true }).fill(title);
  await dialog
    .getByRole("button", { name: "Сохранить шаблон", exact: true })
    .click();
  await expect(dialog.getByText(title, { exact: true })).toBeVisible();
  expect(await dialog.locator("img,script").count()).toBe(0);
  expect(await page.evaluate(() => window.templateXss)).toBeUndefined();
  const stored = await page.evaluate(() =>
    localStorage.getItem("uf.schedule.templates.v1.live"),
  );
  expect(stored).not.toContain('"accounts"');
  expect(stored).not.toContain('"attendance"');
  expect(stored).not.toContain('"password"');
  expect(manager.state().revision).toBe(before.revision);
  await page.reload();
  await manager.login({ navigate: false });
  await page.locator('[data-page="schedule"]').click();
  await page.getByRole("button", { name: "Шаблоны", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByText(title, { exact: true })).toBeVisible();
  await dialog
    .getByRole("button", { name: "Переименовать шаблон " + title, exact: true })
    .click();
  await dialog
    .getByLabel("Новое название", { exact: true })
    .fill("Пятничный шаблон");
  await dialog
    .getByRole("button", { name: "Переименовать", exact: true })
    .click();
  await dialog
    .getByRole("button", {
      name: "Применить шаблон Пятничный шаблон",
      exact: true,
    })
    .click();
  await dialog.getByLabel("День назначения", { exact: true }).selectOption("4");
  await dialog
    .getByRole("button", { name: "Добавить в черновик", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).not.toBeEmpty();
  expect(manager.state().revision).toBe(before.revision);
  await dialog.getByLabel("День назначения", { exact: true }).selectOption("6");
  await dialog
    .getByRole("button", { name: "Добавить в черновик", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByText("Черновик · не опубликован", { exact: true }),
  ).toBeVisible();
  expect(manager.state().data.lessons.length).toBe(before.data.lessons.length);
  await page
    .getByRole("button", { name: "Предпросмотр студента", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("heading", { name: "Предпросмотр студента", exact: true }),
  ).toBeVisible();
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
  await expect(
    page.getByText("Черновик · не опубликован", { exact: true }),
  ).not.toBeVisible();
  const after = manager.state();
  expect(after.revision).toBe(before.revision + 1);
  expect(after.data.lessons.length).toBeGreaterThan(before.data.lessons.length);
  expect(
    after.data.lessons.filter(
      (lesson) => lesson.day === 6 && lesson.groupId === "g-main",
    ).length,
  ).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Шаблоны", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", {
      name: "Удалить шаблон Пятничный шаблон",
      exact: true,
    })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Удалить шаблон", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog")
      .getByText("Сохранённых шаблонов пока нет.", { exact: true }),
  ).toBeVisible();
  expect(manager.state().revision).toBe(after.revision);
  expect(manager.writes()).toHaveLength(1);
});

test("staff without admin role does not get template controls", async ({
  page,
}) => {
  const manager = await mockManager(page, { role: "teacher" });
  await manager.login();
  await page.locator('[data-page="schedule"]').click();
  await expect(
    page.getByRole("button", { name: "Шаблоны", exact: true }),
  ).toHaveCount(0);
  expect(manager.writes()).toEqual([]);
});

test("week template keeps the whole selected scope and refuses to overwrite occupied week", async ({
  page,
}) => {
  const manager = await mockManager(page);
  await manager.login();
  await page.locator('[data-page="schedule"]').click();
  const before = manager.state();
  await page.getByRole("button", { name: "Шаблоны", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Сохранить новый шаблон", exact: true })
    .click();
  await dialog
    .getByLabel("Название шаблона", { exact: true })
    .fill("Учебная неделя");
  await dialog.getByLabel("Сохранить", { exact: true }).selectOption("week");
  await dialog
    .getByRole("button", { name: "Сохранить шаблон", exact: true })
    .click();
  const template = await page.evaluate(
    () => JSON.parse(localStorage.getItem("uf.schedule.templates.v1.live"))[0],
  );
  expect(template.kind).toBe("week");
  expect(template.lessons.length).toBe(
    before.data.lessons.filter(
      (lesson) =>
        lesson.groupId === "g-main" && ["all", "А"].includes(lesson.subgroup),
    ).length,
  );
  expect(
    new Set(template.lessons.map((lesson) => lesson.day)).size,
  ).toBeGreaterThan(1);
  await dialog
    .getByRole("button", {
      name: "Применить шаблон Учебная неделя",
      exact: true,
    })
    .click();
  await expect(
    dialog.getByLabel("День назначения", { exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Добавить в черновик", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).not.toBeEmpty();
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(
    page.getByText("Черновик · не опубликован", { exact: true }),
  ).toHaveCount(0);
  expect(manager.state().revision).toBe(before.revision);
  expect(manager.writes()).toEqual([]);
});
