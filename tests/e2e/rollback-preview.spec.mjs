import { test, expect } from "@playwright/test";
import { mockManager } from "./manager-fixture.mjs";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const ack = "Подтверждаю восстановление всей версии для всех групп";
const errors = new WeakMap();
test.beforeEach(({ page }) => {
  const found = [];
  errors.set(page, found);
  page.on("pageerror", (e) => found.push(e.message));
  page.on("console", (m) => {
    if (["error", "warning"].includes(m.type())) found.push(m.text());
  });
});
test.afterEach(({ page }, info) => {
  const expected = /changed target metadata|concurrent published revision/.test(
    info.title,
  )
    ? [
        "Failed to load resource: the server responded with a status of 409 (Conflict)",
      ]
    : [];
  expect(errors.get(page)).toEqual(expected);
});
async function seed(page, options = {}) {
  const manager = await mockManager(page, options);
  manager.checkpoint();
  manager.advance("lesson.batch", {
    ids: ["now-a"],
    change: { kind: "type", value: "<img src=x onerror=alert(1)>" },
  });
  await manager.login();
  return manager;
}
async function open(page) {
  await page.locator('[data-page="history"]').click();
  await page.locator('[data-action="rollback"]').first().click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", {
      name: "Проверка восстановления версии 7",
      exact: true,
    }),
  ).toBeVisible();
  return dialog;
}
const apply = (dialog) =>
  dialog.getByRole("button", { name: "Восстановить", exact: true });
const ready = (dialog) =>
  expect(
    dialog.getByText("Проверьте изменения перед подтверждением.", {
      exact: true,
    }),
  ).toBeVisible();
test("rollback preview is read-only, literal, accessible and requires confirmation before one global restore", async ({
  page,
}, info) => {
  const manager = await seed(page),
    before = manager.state(),
    dialog = await open(page);
  await ready(dialog);
  await expect(dialog.locator("[data-rollback-change]")).toHaveCount(1);
  await expect(dialog.locator("[data-rollback-change]")).toContainText(
    "<img src=x onerror=alert(1)>",
  );
  await expect(dialog.locator("img,script")).toHaveCount(0);
  await expect(apply(dialog)).toBeDisabled();
  expect(manager.state()).toEqual(before);
  expect(manager.writes()).toEqual([]);
  await page.evaluate(
    await readFile(
      createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
      "utf8",
    ),
  );
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (theme) => document.body.classList.toggle("dark", theme === "dark"),
      theme,
    );
    await expect(
      dialog.getByRole("button", { name: "Обновить сравнение", exact: true }),
    ).toHaveCSS(
      "background-color",
      theme === "dark" ? "rgb(39, 33, 50)" : "rgb(255, 255, 255)",
    );
    expect(
      await page.evaluate(
        async () =>
          (
            await window.axe.run(document.querySelector("#modal"), {
              runOnly: {
                type: "tag",
                values: ["wcag2a", "wcag2aa", "wcag21aa"],
              },
            })
          ).violations,
      ),
    ).toEqual([]);
    expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(
      true,
    );
    if (process.env.QA_EVIDENCE_DIR) {
      await mkdir(resolve(process.env.QA_EVIDENCE_DIR), { recursive: true });
      await page.screenshot({
        path: resolve(
          process.env.QA_EVIDENCE_DIR,
          `rollback-${info.project.name}-${theme}.png`,
        ),
      });
    }
  }
  await dialog.getByLabel(ack, { exact: true }).check();
  await expect(apply(dialog)).toBeEnabled();
  await apply(dialog).click();
  await expect(dialog).not.toBeVisible();
  expect(manager.writes()).toHaveLength(1);
  expect(manager.writes()[0].previewFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(manager.state().data.lessons[0].type).toBe(
    before.versions[0].data.lessons[0].type,
  );
  expect(manager.state().revision).toBe(9);
});
test("identical versions disable restoration and show an explicit no-op", async ({
  page,
}) => {
  const manager = await mockManager(page);
  manager.checkpoint();
  await manager.login();
  const before = manager.state(),
    dialog = await open(page);
  await expect(
    dialog.getByText(
      "Опубликованные данные совпадают. Восстановление не требуется.",
    ),
  ).toBeVisible();
  await expect(dialog.getByLabel(ack)).toBeDisabled();
  await expect(apply(dialog)).toBeDisabled();
  expect(manager.state()).toEqual(before);
  expect(manager.writes()).toEqual([]);
});
test("forty-card pages reset confirmation, preserve the fingerprint and never send writes", async ({
  page,
}) => {
  const manager = await mockManager(page, {
    prepareData(data) {
      data.rooms.push(
        ...Array.from({ length: 81 }, (_, i) => ({
          id: `room-${i}`,
          name: `Аудитория ${i}`,
          capacity: 30,
        })),
      );
    },
  });
  manager.checkpoint();
  manager.editVersion((data) =>
    data.rooms.forEach((r) => {
      r.name += " раньше";
    }),
  );
  await manager.login();
  const dialog = await open(page);
  await ready(dialog);
  await expect(dialog.locator("[data-rollback-change]")).toHaveCount(40);
  await dialog.getByLabel(ack).check();
  await dialog.getByRole("button", { name: "Далее", exact: true }).click();
  await ready(dialog);
  await expect(dialog.getByLabel(ack)).not.toBeChecked();
  await expect(dialog.getByText("Страница 2 из 3")).toBeVisible();
  await dialog.getByRole("button", { name: "Далее", exact: true }).click();
  await ready(dialog);
  await expect(dialog.locator("[data-rollback-change]")).toHaveCount(3);
  expect(manager.writes()).toEqual([]);
});
test("changed target metadata invalidates a checked preview before any rollback write", async ({
  page,
}) => {
  const manager = await seed(page),
    dialog = await open(page);
  await ready(dialog);
  await dialog.getByLabel(ack).check();
  manager.editVersion((data) => {
    data.lessons[0].privateFuture = "changed";
  });
  await apply(dialog).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Просмотр версии устарел",
  );
  await expect(apply(dialog)).toBeDisabled();
  expect(manager.state().revision).toBe(8);
  await dialog
    .getByRole("button", { name: "Обновить сравнение", exact: true })
    .click();
  await ready(dialog);
  await expect(dialog.getByLabel(ack)).not.toBeChecked();
  await expect(dialog).toContainText("Дополнительные сведения также изменятся");
  expect(manager.state().revision).toBe(8);
});
test("a concurrent published revision rejects restoration without overwriting it", async ({
  page,
}) => {
  const manager = await seed(page),
    dialog = await open(page);
  await ready(dialog);
  await dialog.getByLabel(ack).check();
  manager.advance("lesson.batch", {
    ids: ["next"],
    change: { kind: "type", value: "Новое опубликованное" },
  });
  const before = manager.state();
  await apply(dialog).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Данные уже изменились",
  );
  expect(manager.state()).toEqual(before);
  await expect(apply(dialog)).toBeDisabled();
});
test("late preview response after closing cannot reopen or populate another dialog", async ({
  page,
}) => {
  const manager = await seed(page);
  let release, observed;
  const gate = new Promise((r) => {
      release = r;
    }),
    sent = new Promise((r) => {
      observed = r;
    });
  await page.route("**/functions/v1/uniflow-api", async (route) => {
    if (route.request().postDataJSON().action === "rollback.preview") {
      observed();
      await gate;
    }
    return route.fallback();
  });
  const dialog = await open(page);
  await sent;
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await page.locator('[data-action="profile"]').first().click();
  const title = await dialog.locator("h2").textContent();
  release();
  await expect
    .poll(
      () => manager.calls.filter((c) => c.action === "rollback.preview").length,
    )
    .toBe(1);
  await expect(dialog.locator("h2")).toHaveText(title);
  await expect(dialog.locator("[data-rollback-change]")).toHaveCount(0);
  expect(manager.writes()).toEqual([]);
});
test("malformed server preview fails closed and retry requires a fresh confirmation", async ({
  page,
}) => {
  const manager = await seed(page);
  let invalid = true;
  await page.route("**/functions/v1/uniflow-api", async (route) => {
    if (invalid && route.request().postDataJSON().action === "rollback.preview")
      return route.fulfill({
        json: { format: "wrong", fingerprint: "a".repeat(64) },
      });
    return route.fallback();
  });
  const dialog = await open(page);
  await expect(dialog.getByRole("alert")).toContainText(
    "Не удалось проверить ответ сервера",
  );
  await expect(apply(dialog)).toBeDisabled();
  invalid = false;
  await dialog
    .getByRole("button", { name: "Обновить сравнение", exact: true })
    .click();
  await ready(dialog);
  await expect(dialog.getByLabel(ack)).not.toBeChecked();
  expect(manager.writes()).toEqual([]);
});

test("quota failure blocks rollback; closing during durable-save completion aborts before HTTP and preserves the draft", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.IDBDatabase.prototype.transaction;
    window.IDBDatabase.prototype.transaction = function (names, mode, ...rest) {
      if (
        this.name === "uniflow-owner-drafts-v1" &&
        mode === "readwrite" &&
        window.qaDenyDraft
      )
        throw Error("quota fixture");
      const tx = original.call(this, names, mode, ...rest);
      if (
        this.name === "uniflow-owner-drafts-v1" &&
        mode === "readwrite" &&
        window.qaCloseOnSave
      ) {
        window.qaCloseOnSave = false;
        const property = Object.getOwnPropertyDescriptor(
          window.IDBTransaction.prototype,
          "oncomplete",
        );
        Object.defineProperty(tx, "oncomplete", {
          set(handler) {
            property.set.call(tx, function (event) {
              document.querySelector("#modal .dialog-head button")?.click();
              handler.call(this, event);
            });
          },
        });
      }
      return tx;
    };
  });
  const manager = await seed(page);
  await page
    .getByRole("button", { name: "Создать черновик", exact: true })
    .click();
  await expect(page.locator("#draft-save-status")).toContainText(
    "Пока нет правок для сохранения.",
  );
  await page.evaluate(() => {
    window.qaDenyDraft = true;
  });
  await page.locator('[data-page="catalogs"]').click();
  await page.locator('[data-kind="rooms"]').click();
  await page
    .locator("tbody tr")
    .filter({ has: page.locator("strong", { hasText: /^204$/ }) })
    .getByRole("button", { name: "Изменить", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Название / имя", { exact: true })
    .fill("Моя локальная аудитория");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Сохранить", exact: true })
    .click();
  await expect(page.locator("#draft-save-status")).toContainText(
    "Локальное сохранение недоступно",
  );
  let dialog = await open(page);
  await ready(dialog);
  await dialog.getByLabel(ack).check();
  await apply(dialog).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Сначала сохраните локальную копию",
  );
  expect(manager.writes()).toEqual([]);
  await dialog
    .getByRole("button", { name: "Обновить сравнение", exact: true })
    .click();
  await ready(dialog);
  await page.evaluate(() => {
    window.qaDenyDraft = false;
    window.qaCloseOnSave = true;
  });
  await dialog.getByLabel(ack).check();
  await apply(dialog).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator("#draft-save-status")).toContainText(
    "Черновик сохранён",
  );
  expect(manager.writes()).toEqual([]);
  const records = () =>
    page.evaluate(async () =>
      (await import("/schedule/manage/drafts.mjs"))
        .createDraftJournal()
        .list("11111111-1111-4111-8111-111111111111"),
    );
  const retained = (await records()).find((r) => r.status === "active");
  expect(
    retained.changes.some(
      (c) => c.kind === "rooms" && c.after.name === "Моя локальная аудитория",
    ),
  ).toBe(true);
  dialog = await open(page);
  await ready(dialog);
  await dialog.getByLabel(ack).check();
  await apply(dialog).click();
  await expect(dialog).not.toBeVisible();
  expect(manager.writes()).toHaveLength(1);
  const archived = (await records()).find((r) => r.id === retained.id);
  expect(archived.status).toBe("archived");
  expect(archived.reason).toBe("rollback");
  expect(archived.changes).toEqual(retained.changes);
});
