import { expect, test } from "@playwright/test";
import { mockManager } from "./manager-fixture.mjs";

test("planner invalidates stale previews and publishes a dated change through the owner's draft as a move", async ({
  page,
}) => {
  const manager = await mockManager(page);
  await manager.login();
  await page.locator('[data-page="schedule"]').click();
  await page
    .getByRole("button", { name: "Помощник расписания", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const mode = dialog.getByRole("combobox", { name: "Режим планирования" });
  const start = dialog.getByRole("textbox", { name: "Время начала" });
  const preview = dialog.getByRole("button", { name: "Рассчитать варианты" });

  await mode.selectOption("faculty");
  await start.fill("14:00, 16:00, 18:00");
  await preview.click();
  await expect(dialog.locator("[data-ai-change]").first()).toBeVisible();
  expect(manager.writes()).toEqual([]);

  await mode.selectOption("move");
  await expect(dialog.locator("[data-ai-change]")).toHaveCount(0);
  await start.fill("14:00");
  await preview.click();
  await expect(dialog.locator("[data-ai-move]")).toHaveText(/14:00–15:50/);

  await start.fill("15:00");
  await expect(dialog.locator("[data-ai-move]")).toHaveCount(0);
  await preview.click();
  await expect(dialog.locator("[data-ai-move]")).toHaveText(/15:00–16:50/);
  await dialog
    .getByRole("button", { name: "Добавить этот перенос в черновик" })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator("#draft-save-status")).toContainText(
    "Черновик сохранён",
  );
  expect(manager.writes()).toEqual([]);
  const revision = manager.state().revision;
  await page.getByRole("button", { name: "Опубликовать", exact: true }).click();
  await expect.poll(() => manager.state().revision).toBe(revision + 1);
  const published = manager.state().data;
  expect(published.exceptions).toHaveLength(1);
  expect(published.exceptions[0]).toMatchObject({
    start: "15:00",
    status: "moved",
  });
  expect(published.history[0]).toMatchObject({
    action: "exception.save",
    summary: "Пара перенесена",
  });
  expect(published.announcements.map((item) => item.title)).toEqual([
    "Пара перенесена",
  ]);
});
