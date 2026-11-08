import { test, expect } from "@playwright/test";
import { mockState, fixture } from "./fixtures.mjs";
import { readFile } from "node:fs/promises";
import { previewRollback } from "../../backend/rollback-preview.mjs";

const axePath = new URL(
  "../../node_modules/axe-core/axe.min.js",
  import.meta.url,
);

async function signedFixture(page) {
  await mockState(page);
  const calls = [];
  let revision = 7,
    logoutAttempts = 0;
  const admin = {
    id: "11111111-1111-4111-8111-111111111111",
    role: "admin",
    name: "Администратор",
    username: "arappayevv@gmail.com",
    email: "arappayevv@gmail.com",
  };
  const ownerToken = "ow1a." + "a".repeat(64);
  await page.route("**/functions/v1/owner-access", async (route) => {
    const body = route.request().postDataJSON();
    calls.push(body);
    if (body.action === "status")
      return route.fulfill({
        json: { available: true, configured: true, setupRequired: false },
      });
    if (body.action === "login.begin")
      return route.fulfill({
        json: {
          challengeId: "ow1c." + "c".repeat(64),
          expiresAt: "2026-11-06T04:05:00Z",
          emailHint: "a***@gmail.com",
        },
      });
    if (body.action === "login.verify")
      return route.fulfill({
        json: {
          token: ownerToken,
          refreshToken: "ow1r." + "b".repeat(64),
          expiresAt: "2026-11-06T04:15:00Z",
          refreshExpiresAt: "2026-11-06T05:00:00Z",
          owner: { id: admin.id, email: admin.email },
        },
      });
    if (body.action === "logout.all") {
      logoutAttempts++;
      return route.fulfill(
        logoutAttempts === 1
          ? { status: 503, json: { code: "UNAVAILABLE" } }
          : { json: { ok: true } },
      );
    }
    return route.fulfill({ status: 400, json: { code: "INVALID_REQUEST" } });
  });
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
    if (body.action === "state") {
      const user =
        body.token === ownerToken
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
          capabilities: { logoutAll: true, rollbackPreview: true },
        },
      });
      return;
    }
    if (body.action === "rollback.preview") {
      const previous = structuredClone(fixture);
      previous.lessons[0].type = "Прежний тип";
      return route.fulfill({
        json: await previewRollback(fixture, previous, {
          revision,
          target: 6,
          page: body.page ?? 0,
        }),
      });
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
  await page.goto("/schedule/admin/");
  await page
    .getByLabel("Пароль владельца", { exact: true })
    .fill("fixture-only-password");
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  await page.getByLabel("Код или ссылка из письма").fill("123456");
  await page.getByLabel("Код из приложения", { exact: true }).fill("654321");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "Разделы", exact: true }),
  ).toBeVisible();
  return {
    calls,
    setRevision(value) {
      revision = value;
    },
  };
}

test("logout all clears this device even when the server cannot confirm the other sessions", async ({
  page,
}) => {
  const { calls } = await signedFixture(page);
  await page.locator('[data-action="profile"]').first().click();
  const action = page
    .getByRole("dialog")
    .getByRole("button", { name: "Выйти на всех устройствах", exact: true });
  await action.click();
  await expect(
    page.getByRole("heading", { name: "Вход владельца", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/Сервер не подтвердил завершение остальных сессий/),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Разделы", exact: true }),
  ).toHaveCount(0);
  expect(calls.filter((call) => call.action === "logout.all")[0].token).toBe(
    "ow1a." + "a".repeat(64),
  );
  const stored = await page.evaluate(() =>
    Object.entries(localStorage).filter(([key]) => /token|session/i.test(key)),
  );
  expect(stored).toEqual([]);
});

test("rollback confirmation retains its original revision when a refresh arrives while open", async ({
  page,
}) => {
  const { calls, setRevision } = await signedFixture(page);
  await page.locator('[data-page="history"]').click();
  await page.locator('[data-action="rollback"]').first().click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Подтверждаю восстановление всей версии для всех групп", {
      exact: true,
    })
    .check();
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
  const preview = calls.find((call) => call.action === "rollback.preview");
  expect(preview).toMatchObject({ revision: 7, target: 6 });
  expect(calls.filter((call) => call.action === "rollback")).toEqual([]);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator("#toast")).not.toHaveText("Версия восстановлена");
});

test("the canonical owner hash route loads a network-only sign-in without exposing the workspace", async ({
  page,
}) => {
  await mockState(page);
  await page.goto("/schedule/#/admin");
  await expect(page).toHaveURL(/\/admin\/$/);
  await expect(
    page.getByRole("heading", { name: "Вход владельца", exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-page="schedule"]')).toHaveCount(0);
  const cachesContainAdmin = await page.evaluate(async () => {
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      if (
        (await cache.keys()).some((request) =>
          new URL(request.url).pathname.includes("/admin/"),
        )
      )
        return true;
    }
    return false;
  });
  expect(cachesContainAdmin).toBe(false);
});

test("the verified owner workspace manages schedules without account or role editors", async ({
  page,
}, testInfo) => {
  const consoleErrors = [];
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()))
      consoleErrors.push(message.text());
  });
  await page.addInitScript(() => {
    window.ownerCspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.ownerCspViolations.push({
        directive: event.violatedDirective,
        blocked: event.blockedURI,
      });
    });
  });
  const { calls } = await signedFixture(page);
  await expect(page.locator('[data-page="accounts"]')).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Создать аккаунт", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "Роль", exact: true }),
  ).toHaveCount(0);
  await page.locator('[data-page="schedule"]').click();
  expect(consoleErrors).toEqual([]);
  expect(await page.evaluate(() => window.ownerCspViolations)).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(await readFile(axePath, "utf8"));
  const violations = await page.evaluate(async () =>
    (
      await globalThis.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      })
    ).violations.map(({ id, nodes }) => ({
      id,
      targets: nodes.map((node) => node.target),
    })),
  );
  expect(violations).toEqual([]);
  expect(
    calls
      .filter((call) => call.action === "state" && call.token)
      .every((call) => /^ow1a\./.test(call.token)),
  ).toBe(true);
  if (testInfo.project.name === "mobile-390")
    await page.screenshot({
      path: "../../outputs/owner-access/owner-workspace-390.png",
      fullPage: true,
    });
});
