import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const axePath = createRequire(import.meta.url).resolve("axe-core/axe.min.js");
const path = "/schedule/beta/admin/";
const password = "owner-test-password-unique";
const secret = "JBSWY3DPEHPK3PXP";
const enrollment = {
  factorId: "fixture-factor",
  secret,
  uri: `otpauth://totp/UniFlow:owner%40example.invalid?secret=${secret}&issuer=UniFlow`,
};
const challenge = () => ({
  challengeId: "fixture-challenge",
  expiresAt: new Date(Date.now() + 300000).toISOString(),
});
const session = (withCodes = false) => ({
  token: "ow1a." + "a".repeat(64),
  refreshToken: "ow1r." + "b".repeat(64),
  expiresAt: new Date(Date.now() + 900000).toISOString(),
  refreshExpiresAt: new Date(Date.now() + 3600000).toISOString(),
  owner: { id: "fixture-owner", email: "owner@example.invalid" },
  ...(withCodes
    ? {
        recoveryCodes: Array.from(
          { length: 10 },
          (_, i) => `recovery-${i}-fixture`,
        ),
      }
    : {}),
});

async function fixture(page, { setup = false, handler } = {}) {
  const calls = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Exercise the shipped UI/transport in isolation from management integration.
  await page.route("**/admin/app.mjs", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `import { consumeBootstrapFragment } from './api.mjs'; import { renderOwnerAccess } from './access.mjs'; let bootstrapToken=consumeBootstrapFragment(); const access=renderOwnerAccess(document.getElementById('owner-main'),{bootstrapToken}); bootstrapToken=''; window.addEventListener('pagehide',()=>access.dispose(),{once:true});`,
    }),
  );
  await page.route("**/functions/v1/owner-access", async (route) => {
    const request = route.request();
    const body = request.postDataJSON();
    calls.push({ ...body, url: request.url(), method: request.method() });
    let value;
    if (handler) value = await handler(body, calls);
    if (!value) {
      const responses = {
        status: {
          available: true,
          configured: !setup,
          setupRequired: setup,
          ownerHint: "o***@example.invalid",
        },
        "setup.request": { sent: true, retryAfterSeconds: 60 },
        "setup.start": { ...challenge(), step: "password" },
        "setup.password": { ...challenge(), step: "totp", enrollment },
        "setup.verify": session(true),
        "login.begin": { ...challenge(), emailHint: "o***@example.invalid" },
        "login.verify": session(),
        "recovery.verify": { ...challenge(), step: "totp", enrollment },
        "recovery.finish": session(true),
        "logout.all": { ok: true },
      };
      value = {
        status: 200,
        body: responses[body.action] || { code: "INVALID_REQUEST" },
      };
    }
    await route.fulfill({
      status: value.status,
      contentType: "application/json",
      headers: { "Cache-Control": "no-store" },
      body: JSON.stringify(value.body),
    });
  });
  return { calls, errors };
}

async function audit(page) {
  await page.evaluate(await readFile(axePath, "utf8"));
  const violations = await page.evaluate(async () =>
    (
      await globalThis.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      })
    ).violations.map(({ id, nodes }) => ({
      id,
      targets: nodes.map(({ target }) => target),
    })),
  );
  expect(violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

test("a complete fresh login can replace lost recovery codes after an interrupted setup response", async ({
  page,
}) => {
  const { calls } = await fixture(page, {
    handler: async (body) =>
      body.action === "login.verify" && body.renewRecoveryCodes === true
        ? { status: 200, body: session(true) }
        : undefined,
  });
  await page.goto(path);
  await beginLogin(page);
  await page.getByLabel("Код или ссылка из письма").fill("123456");
  await page.getByLabel("Код из приложения", { exact: true }).fill("654321");
  await page.getByLabel("Обновить резервные коды", { exact: true }).check();
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Сохраните резервные коды" }),
  ).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Резервные коды" }).locator("li"),
  ).toHaveCount(10);
  expect(
    calls.find((call) => call.action === "login.verify").renewRecoveryCodes,
  ).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value) => {
          globalThis.fixtureCopiedCodes = value;
        },
      },
    });
  });
  await page
    .getByRole("button", { name: "Скопировать коды", exact: true })
    .click();
  expect(
    await page.evaluate(() => globalThis.fixtureCopiedCodes.split("\n").length),
  ).toBe(10);
  await audit(page);
});

test("unavailable mail configuration explains SMTP without displaying provider errors or secrets", async ({
  page,
}) => {
  await fixture(page, {
    setup: true,
    handler: async (body) =>
      body.action === "setup.request"
        ? { status: 503, body: { code: "MAIL_UNAVAILABLE" } }
        : undefined,
  });
  await page.goto(path);
  await page
    .getByRole("button", { name: "Отправить приглашение владельцу" })
    .click();
  await expect(page.getByRole("alert")).toContainText("SMTP");
  await expect(page.getByRole("alert")).toContainText(
    "https://xan-xz.github.io/schedule/admin/",
  );
  await audit(page);
});

async function beginLogin(page) {
  await page.getByLabel("Пароль владельца", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Подтвердите вход" }),
  ).toBeVisible();
}

test("password + owner email proof + TOTP logs in, logout-all clears memory, nothing persists", async ({
  page,
}) => {
  const { calls, errors } = await fixture(page);
  await page.goto(path);
  await expect(page).toHaveTitle("Вход владельца · UniFlow");
  await expect(
    page.getByRole("heading", { name: "Вход владельца" }),
  ).toBeFocused();
  await audit(page);
  await beginLogin(page);
  await page.getByLabel("Код или ссылка из письма").fill("123456");
  await page.getByLabel("Код из приложения", { exact: true }).fill("654321");
  await audit(page);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Вход подтверждён" }),
  ).toBeVisible();
  expect(calls.find((call) => call.action === "login.begin").password).toBe(
    password,
  );
  expect(
    calls.every(
      (call) =>
        call.method === "POST" &&
        !new URL(call.url).search &&
        !("email" in call),
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => ({
      local: { ...localStorage },
      session: { ...sessionStorage },
    })),
  ).toEqual({ local: {}, session: {} });
  await page.getByRole("button", { name: "Выйти на всех устройствах" }).click();
  await expect(
    page.getByRole("heading", { name: "Вход владельца" }),
  ).toBeVisible();
  expect(calls.filter((call) => call.action === "logout.all")).toHaveLength(1);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Вход владельца" }),
  ).toBeVisible();
  expect(
    calls.filter((call) => call.action === "session.refresh"),
  ).toHaveLength(0);
  expect(errors).toEqual([]);
});

test("verified invite precedes password and local QR; recovery codes appear once", async ({
  page,
}) => {
  const { calls, errors } = await fixture(page, { setup: true });
  const urls = [];
  page.on("request", (request) => urls.push(request.url()));
  await page.goto(
    path +
      "#access_token=fixture-invite&refresh_token=must-discard&type=invite",
  );
  await expect(page).toHaveURL(new RegExp("/admin/$"));
  await expect(page.getByRole("img", { name: "QR-код" })).toHaveCount(0);
  await expect(page.getByLabel("Одноразовый код приглашения")).toHaveValue(
    "fixture-invite",
  );
  await audit(page);
  await page.getByRole("button", { name: "Подтвердить приглашение" }).click();
  for (const invalid of ["🔑".repeat(6), "я".repeat(37)]) {
    await page.getByLabel("Новый пароль", { exact: true }).fill(invalid);
    await page.getByLabel("Повторите пароль").fill(invalid);
    await page
      .getByRole("button", { name: "Подключить приложение", exact: true })
      .click();
    expect(calls.some((call) => call.action === "setup.password")).toBe(false);
    expect(
      await page
        .getByLabel("Новый пароль", { exact: true })
        .evaluate((input) => input.validity.valid),
    ).toBe(false);
  }
  await page.getByLabel("Новый пароль", { exact: true }).fill(password);
  await page.getByLabel("Повторите пароль").fill(password);
  await page
    .getByRole("button", { name: "Подключить приложение", exact: true })
    .click();
  await expect(
    page.getByRole("img", { name: "QR-код для приложения аутентификации" }),
  ).toBeVisible();
  if (process.env.OWNER_QA_DIR)
    await page.screenshot({
      path: join(
        process.env.OWNER_QA_DIR,
        `owner-totp-${test.info().project.name}.png`,
      ),
      fullPage: true,
    });
  await audit(page);
  await page.getByText("Ввести ключ вручную", { exact: true }).click();
  await expect(page.getByText(secret, { exact: true })).toBeVisible();
  await page.getByLabel("Код из нового приложения").fill("123456");
  await page.getByRole("button", { name: "Завершить настройку" }).click();
  await expect(
    page.getByRole("heading", { name: "Сохраните резервные коды" }),
  ).toBeVisible();
  expect(calls.map((call) => call.action)).toEqual([
    "status",
    "setup.start",
    "setup.password",
    "setup.verify",
  ]);
  await expect(
    page.getByRole("list", { name: "Резервные коды" }).getByRole("listitem"),
  ).toHaveCount(10);
  await audit(page);
  await page
    .getByRole("checkbox", { name: "Я сохранил(а) резервные коды" })
    .check();
  await page.getByRole("button", { name: "Продолжить в управление" }).click();
  await expect(page.getByText("recovery-0-fixture")).toHaveCount(0);
  await expect(page.getByText(secret, { exact: true })).toHaveCount(0);
  expect(
    urls.some(
      (url) =>
        url.includes("otpauth") ||
        url.includes(secret) ||
        url.includes("must-discard"),
    ),
  ).toBe(false);
  expect(
    await page.evaluate(() => ({
      local: { ...localStorage },
      session: { ...sessionStorage },
    })),
  ).toEqual({ local: {}, session: {} });
  expect(errors).toEqual([]);
});

test("recovery requires email, saved recovery code, password again and fresh TOTP", async ({
  page,
}) => {
  const { calls } = await fixture(page);
  await page.goto(path);
  await beginLogin(page);
  await page.getByRole("button", { name: "Нет доступа к приложению" }).click();
  await page
    .getByLabel("Код или ссылка из письма")
    .fill(
      "https://anfwdrcazwbkkayczkxg.supabase.co/auth/v1/verify?token=fixture&type=email",
    );
  await page
    .getByLabel("Резервный код", { exact: true })
    .fill("recovery-fixture");
  await page.getByLabel("Пароль владельца ещё раз").fill(password);
  await audit(page);
  await page
    .getByRole("button", { name: "Подключить новое приложение" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Новое приложение аутентификации" }),
  ).toBeVisible();
  await page.getByLabel("Код из нового приложения").fill("123456");
  await page.getByRole("button", { name: "Завершить восстановление" }).click();
  await expect(
    page.getByRole("heading", { name: "Сохраните резервные коды" }),
  ).toBeVisible();
  expect(calls.find((call) => call.action === "recovery.verify").password).toBe(
    password,
  );
  expect(
    calls.filter((call) => call.action === "recovery.finish"),
  ).toHaveLength(1);
});

test("unavailable and rate limits fail closed; invite send needs an explicit click", async ({
  page,
}) => {
  let available = false;
  const { calls } = await fixture(page, {
    setup: true,
    handler: async (body) => {
      if (body.action === "status" && !available)
        return {
          status: 503,
          body: { code: "UNAVAILABLE", error: "private-server-details" },
        };
      if (body.action === "setup.start")
        return {
          status: 429,
          body: { code: "RATE_LIMITED", retryAfterSeconds: 60 },
        };
    },
  });
  await page.goto(path);
  await expect(
    page.getByRole("heading", { name: "Вход временно недоступен" }),
  ).toBeVisible();
  await expect(page.getByText("private-server-details")).toHaveCount(0);
  await audit(page);
  available = true;
  await page.getByRole("button", { name: "Повторить проверку" }).click();
  await expect(
    page.getByRole("heading", { name: "Настройка владельца" }),
  ).toBeVisible();
  expect(calls.filter((call) => call.action === "setup.request")).toHaveLength(
    0,
  );
  await page
    .getByRole("button", { name: "Отправить приглашение владельцу" })
    .click();
  await expect(
    page.getByRole("button", { name: "Отправить приглашение владельцу" }),
  ).toBeDisabled();
  await page
    .getByLabel("Одноразовый код приглашения")
    .fill("fixture-invalid-proof");
  await page.getByRole("button", { name: "Подтвердить приглашение" }).click();
  await expect(page.getByRole("alert")).toContainText("Повторите через 60 с.");
  await expect(
    page.getByRole("button", { name: "Подтвердить приглашение" }),
  ).toBeDisabled();
  await expect(page.getByLabel("Одноразовый код приглашения")).toHaveValue("");
  await expect(page.getByRole("img", { name: "QR-код" })).toHaveCount(0);
  expect(calls.filter((call) => call.action === "setup.request")).toHaveLength(
    1,
  );
});

test("cancelled enrollment cannot reappear from a late server response", async ({
  page,
}) => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  await fixture(page, {
    setup: true,
    handler: async (body) => {
      if (body.action === "setup.password") {
        await pending;
        return {
          status: 200,
          body: { ...challenge(), step: "totp", enrollment },
        };
      }
    },
  });
  await page.goto(path);
  await page.getByLabel("Одноразовый код приглашения").fill("fixture-invite");
  await page.getByRole("button", { name: "Подтвердить приглашение" }).click();
  await page.getByLabel("Новый пароль", { exact: true }).fill(password);
  await page.getByLabel("Повторите пароль").fill(password);
  await page
    .getByRole("button", { name: "Подключить приложение", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Подключить приложение", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Начать заново" }).click();
  await expect(
    page.getByRole("heading", { name: "Настройка владельца" }),
  ).toBeVisible();
  const completed = page.waitForResponse(
    (response) =>
      response.url().includes("/owner-access") &&
      response.request().postDataJSON().action === "setup.password",
  );
  finish();
  await completed;
  await page.evaluate(
    () => new Promise((resolve) => window.requestAnimationFrame(resolve)),
  );
  await expect(
    page.getByRole("heading", { name: "Настройка владельца" }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "QR-код для приложения аутентификации" }),
  ).toHaveCount(0);
});

test("failed global logout still removes local access and reports unconfirmed revocation", async ({
  page,
}) => {
  await fixture(page, {
    handler: async (body) => {
      if (body.action === "logout.all")
        return { status: 503, body: { code: "UNAVAILABLE" } };
    },
  });
  await page.goto(path);
  await beginLogin(page);
  await page.getByLabel("Код или ссылка из письма").fill("123456");
  await page.getByLabel("Код из приложения", { exact: true }).fill("654321");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page.getByRole("button", { name: "Выйти на всех устройствах" }).click();
  await expect(
    page.getByRole("heading", { name: "Вход владельца" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "Сервер не подтвердил выход на остальных устройствах",
  );
});
