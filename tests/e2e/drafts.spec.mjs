import { test, expect } from "@playwright/test";
import { mockManager } from "./manager-fixture.mjs";
import { mkdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";

const owner = "11111111-1111-4111-8111-111111111111";
const saved = (page) =>
  expect(page.locator("#draft-save-status")).toHaveText(
    "Черновик сохранён на этом устройстве. Не опубликован.",
  );
async function records(page) {
  return page.evaluate(async (owner) => {
    const { createDraftJournal } = await import("/schedule/manage/drafts.mjs");
    return createDraftJournal().list(owner);
  }, owner);
}
async function cancellation(page, note = "Сохранить мою замену") {
  await page.locator('[data-page="schedule"]').click();
  await page
    .getByRole("button", { name: "Создать черновик", exact: true })
    .click();
  await page.locator('[data-action="exception"]').first().click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("combobox", { name: "Действие", exact: true })
    .selectOption("cancelled");
  await dialog.getByLabel("Причина / комментарий", { exact: true }).fill(note);
  await dialog
    .getByRole("button", { name: "Применить на дату", exact: true })
    .click();
  await saved(page);
}
async function roomName(page, name) {
  await page.locator('[data-page="catalogs"]').click();
  await page.locator('[data-kind="rooms"]').click();
  await page
    .locator("tbody tr")
    .filter({ has: page.locator("strong", { hasText: /^204$/ }) })
    .getByRole("button", { name: "Изменить", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Название / имя", { exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
}
async function inspectRecovery(page) {
  await page
    .getByRole("button", { name: "Локальные черновики", exact: true })
    .click();
  await page
    .locator("[data-local-draft]")
    .filter({ hasText: "Не завершён" })
    .first()
    .getByRole("button", { name: "Проверить восстановление", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Проверка восстановления", exact: true }),
  ).toBeVisible();
}
async function axeDialog(page) {
  const require = createRequire(import.meta.url);
  // Audit through CDP evaluation; keep the application's strict CSP intact.
  await page.evaluate(
    await readFile(require.resolve("axe-core/axe.min.js"), "utf8"),
  );
  const issues = await page.evaluate(
    async () =>
      (
        await window.axe.run(document.querySelector("#modal"), {
          runOnly: {
            type: "tag",
            values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
          },
        })
      ).violations,
  );
  expect(issues).toEqual([]);
}

test("a durable draft survives closing its tab and requires fresh owner login plus explicit recovery before publication", async ({
  page: initialPage,
  context,
}, info) => {
  let page = initialPage;
  const issues = [];
  const monitor = (page) => {
    page.on("pageerror", (error) => issues.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") issues.push(message.text());
    });
  };
  monitor(page);
  let manager = await mockManager(page, { archived: true });
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
  await cancellation(page);
  expect(manager.writes()).toEqual([]);
  const initial = (await records(page))[0];
  const serialized = JSON.stringify(initial);
  for (const excluded of [
    "token",
    "refreshToken",
    "password",
    "emailCode",
    "totpCode",
    "attendance",
    "requests",
    "history",
    "owner@example.invalid",
  ])
    expect(serialized).not.toContain(excluded);
  await page.close();
  page = await context.newPage();
  monitor(page);
  manager = await mockManager(page, { archived: true });
  await page.goto("/schedule/admin/");
  await expect(
    page.getByRole("heading", { name: "Вход владельца", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Локальные черновики", exact: true }),
  ).toHaveCount(0);
  expect(await page.locator("body").textContent()).not.toContain(
    "Сохранить мою замену",
  );
  await manager.login({ navigate: false });
  await expect(page.locator("body")).toHaveClass(/dark/);
  await inspectRecovery(page);
  await axeDialog(page);
  const shots = resolve("../../outputs/owner-drafts/screenshots");
  await mkdir(shots, { recursive: true });
  await page.screenshot({
    path: join(shots, `recovery-${info.project.name}.png`),
  });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Восстановить в черновик", exact: true })
    .click();
  await saved(page);
  await page.locator('[data-page="schedule"]').click();
  await expect(
    page.getByText("Отменено", { exact: true }).first(),
  ).toBeVisible();
  expect(manager.writes()).toEqual([]);
  await page.getByRole("button", { name: "Опубликовать", exact: true }).click();
  await expect(
    page.getByText(
      "Черновик опубликован. Предыдущая версия доступна в истории.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(manager.writes()).toHaveLength(1);
  expect(manager.state().data.requests).toHaveLength(1);
  expect(manager.state().data.attendance).toHaveLength(1);
  expect(
    (await records(page)).every((record) => record.status === "archived"),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(issues).toEqual([]);
});

test("changed server fields require reviewed recovery, preserving untouched fresh fields and the current revision", async ({
  page,
}) => {
  const manager = await mockManager(page, { archived: true });
  await manager.login();
  await page
    .getByRole("button", { name: "Создать черновик", exact: true })
    .click();
  await roomName(page, "204 локально");
  await saved(page);
  manager.advance("catalog.save", {
    entity: "rooms",
    item: {
      ...manager.state().data.rooms[0],
      name: "204 на сервере",
      capacity: 40,
    },
  });
  const revision = manager.state().revision;
  await page.reload();
  await manager.login({ navigate: false });
  await inspectRecovery(page);
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("alert").filter({ hasText: "Спорных записей: 1" }),
  ).toBeVisible();
  const restore = dialog.getByRole("button", {
    name: "Перенести в текущую версию",
    exact: true,
  });
  await restore.click();
  await expect(dialog.locator(".form-error")).toContainText(
    "Сначала подтвердите",
  );
  await dialog
    .getByRole("checkbox", {
      name: "Я проверил спорные правки и выбираю локальные значения",
      exact: true,
    })
    .check();
  await axeDialog(page);
  await restore.click();
  await saved(page);
  expect(manager.writes()).toEqual([]);
  await page.getByRole("button", { name: "Опубликовать", exact: true }).click();
  await expect.poll(() => manager.writes().length).toBe(1);
  expect(manager.writes()[0].revision).toBe(revision);
  const room = manager.state().data.rooms.find((room) => room.id === "204");
  expect(room.name).toBe("204 локально");
  expect(room.capacity).toBe(40);
});

test("quota denial keeps the earlier durable copy and the latest in-memory edits until an explicit retry", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.IDBDatabase.prototype.transaction;
    window.IDBDatabase.prototype.transaction = function (names, mode, ...rest) {
      if (
        this.name === "uniflow-owner-drafts-v1" &&
        mode === "readwrite" &&
        localStorage.getItem("qa.draftQuota") === "1"
      )
        throw Error("quota fixture");
      return original.call(this, names, mode, ...rest);
    };
  });
  const manager = await mockManager(page);
  await manager.login();
  await cancellation(page);
  const original = (await records(page))[0];
  await page.evaluate(() => localStorage.setItem("qa.draftQuota", "1"));
  await roomName(page, "204 не терять");
  await expect(page.locator("#draft-save-status")).toContainText(
    "Локальное сохранение недоступно",
  );
  expect((await records(page))[0]).toEqual(original);
  expect(manager.writes()).toEqual([]);
  await page.evaluate(() => localStorage.setItem("qa.draftQuota", "0"));
  await page
    .getByRole("button", { name: "Повторить сохранение", exact: true })
    .click();
  await saved(page);
  const current = (await records(page))[0];
  expect(current.generation).toBeGreaterThan(original.generation);
  expect(
    current.changes.some(
      (change) =>
        change.kind === "rooms" && change.after.name === "204 не терять",
    ),
  ).toBe(true);
});

test("two owner tabs preserve independent drafts when recovery archives another tab's generation", async ({
  page,
  context,
}) => {
  const first = await mockManager(page);
  await first.login();
  await cancellation(page);
  const secondPage = await context.newPage(),
    second = await mockManager(secondPage);
  await second.login();
  await inspectRecovery(secondPage);
  await secondPage
    .getByRole("dialog")
    .getByRole("button", { name: "Восстановить в черновик", exact: true })
    .click();
  await saved(secondPage);
  await roomName(secondPage, "204 из второй вкладки");
  await saved(secondPage);
  await roomName(page, "204 из первой вкладки");
  await saved(page);
  await expect(page.locator("#toast")).toContainText(
    "сохранены отдельной копией",
  );
  const active = (await records(page)).filter(
    (record) => record.status === "active",
  );
  expect(active).toHaveLength(2);
  const names = active.flatMap((record) =>
    record.changes
      .filter((change) => change.kind === "rooms")
      .map((change) => change.after.name),
  );
  expect(names.sort()).toEqual(
    ["204 из первой вкладки", "204 из второй вкладки"].sort(),
  );
  expect(first.writes()).toEqual([]);
  expect(second.writes()).toEqual([]);
  await secondPage.close();
});

test("a failed network publication keeps a durable draft and succeeds only after a later explicit publish", async ({
  page,
}) => {
  const manager = await mockManager(page);
  await manager.login();
  await cancellation(page);
  let deny = true;
  await page.route("**/functions/v1/uniflow-api", (route) => {
    if (deny && route.request().postDataJSON().action === "mutate")
      return route.abort("internetdisconnected");
    return route.fallback();
  });
  await page.getByRole("button", { name: "Опубликовать", exact: true }).click();
  await expect(page.locator("#toast")).toContainText(
    "Локальная копия сохранена; проверьте сеть",
  );
  expect(
    (await records(page)).some((record) => record.status === "active"),
  ).toBe(true);
  expect(manager.writes()).toEqual([]);
  deny = false;
  await page.getByRole("button", { name: "Опубликовать", exact: true }).click();
  await expect.poll(() => manager.writes().length).toBe(1);
  await expect
    .poll(async () =>
      (await records(page)).every((record) => record.status === "archived"),
    )
    .toBe(true);
});

test("discard and rollback archive local work without silently restoring it into a fresh draft", async ({
  page,
}) => {
  const manager = await mockManager(page);
  await manager.login();
  await cancellation(page, "Отменённый локальный план");
  await page
    .getByRole("button", { name: "Отменить черновик", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Создать черновик", exact: true }),
  ).toBeVisible();
  expect((await records(page))[0].reason).toBe("discarded");
  expect(manager.writes()).toEqual([]);
  await cancellation(page, "Опубликованный план");
  await page.getByRole("button", { name: "Опубликовать", exact: true }).click();
  await expect.poll(() => manager.writes().length).toBe(1);
  await cancellation(page, "Сохранить перед откатом");
  await page.locator('[data-page="history"]').click();
  await page.locator('[data-action="rollback"]').first().click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Восстановить", exact: true })
    .click();
  await expect(
    page.getByText("Версия восстановлена", { exact: true }),
  ).toBeVisible();
  const copies = await records(page);
  expect(copies.some((record) => record.reason === "rollback")).toBe(true);
  expect(copies.every((record) => record.status === "archived")).toBe(true);
});
