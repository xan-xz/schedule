import { test, expect } from "@playwright/test";
import { mockState, fixture } from "./fixtures.mjs";

async function signedFixture(page) {
  await mockState(page);
  const calls = [];
  let revision = 7,
    logoutAttempts = 0;
  const admin = {
    id: "admin",
    role: "admin",
    name: "Администратор",
    username: "admin",
  };
  await page.route("**/functions/v1/uniflow-api", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
        },
      });
      return;
    }
    const body = route.request().postDataJSON();
    calls.push(body);
    if (body.action === "login") {
      await route.fulfill({ json: { token: "a".repeat(64), user: admin } });
      return;
    }
    if (body.action === "state") {
      const user = body.token
        ? admin
        : {
            id: "guest",
            role: "guest",
            name: "Посетитель",
            groupId: "g-main",
            subgroup: "А",
          };
      await route.fulfill({
        json: {
          data: fixture,
          revision,
          user,
          users: [],
          versions: body.token
            ? [
                {
                  revision: 6,
                  actor: "Администратор",
                  reason: "Предыдущая версия",
                  created_at: "2026-11-06T03:00:00Z",
                },
              ]
            : [],
          capabilities: { logoutAll: true },
        },
      });
      return;
    }
    if (body.action === "logout.all") {
      logoutAttempts++;
      await route.fulfill(
        logoutAttempts === 1
          ? { status: 503, json: { error: "Не удалось завершить сессии" } }
          : { json: { ok: true } },
      );
      return;
    }
    if (body.action === "rollback") {
      await route.fulfill({
        status: 409,
        json: {
          error: "Данные уже изменились. Обнови страницу и повтори действие.",
        },
      });
      return;
    }
    await route.fulfill({
      status: 400,
      json: { error: "Unsupported fixture action" },
    });
  });
  await page.goto("/schedule/beta/manage/");
  await page.locator('[data-action="login"]').click();
  await page.getByLabel("Логин", { exact: true }).fill("admin");
  await page
    .getByLabel("Пароль", { exact: true })
    .fill("fixture-only-password");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Войти", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  return {
    calls,
    setRevision(value) {
      revision = value;
    },
  };
}

test("logout all reports failure without clearing the session, then clears it after server success", async ({
  page,
}) => {
  const { calls } = await signedFixture(page);
  await page.locator('[data-action="profile"]').first().click();
  const action = page
    .getByRole("dialog")
    .getByRole("button", { name: "Выйти на всех устройствах", exact: true });
  await action.click();
  await expect(page.locator("#toast")).toHaveText(
    "Не удалось завершить сессии",
  );
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(calls.filter((call) => call.action === "logout.all")[0].token).toBe(
    "a".repeat(64),
  );
  await action.click();
  await expect(page.locator("#toast")).toHaveText(
    "Выход выполнен на всех устройствах",
  );
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const logouts = calls.filter((call) => call.action === "logout.all");
  expect(logouts).toHaveLength(2);
  expect(logouts[1].token).toBe("a".repeat(64));
  expect(calls.filter((call) => call.action === "state").at(-1).token).toBe("");
});

test("rollback confirmation retains its original revision when a refresh arrives while open", async ({
  page,
}) => {
  const { calls, setRevision } = await signedFixture(page);
  await page.locator('[data-page="history"]').click();
  await page.locator('[data-action="rollback"]').first().click();
  setRevision(8);
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Данные изменились",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Восстановить", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Данные уже изменились",
  );
  const request = calls.find((call) => call.action === "rollback");
  expect(request).toMatchObject({ revision: 7, target: 6 });
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator("#toast")).not.toHaveText("Версия восстановлена");
});
