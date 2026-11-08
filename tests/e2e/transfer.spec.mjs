import { test, expect } from "@playwright/test";
import { mockManager } from "./manager-fixture.mjs";
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
const owner = "11111111-1111-4111-8111-111111111111";
const issues = new WeakMap();
test.beforeEach(({ page }) => {
  const found = [];
  issues.set(page, found);
  page.on("pageerror", (e) => found.push(e.message));
  page.on("console", (m) => {
    if (["error", "warning"].includes(m.type())) found.push(m.text());
  });
});
test.afterEach(({ page }) => expect(issues.get(page)).toEqual([]));
const records = (page) =>
  page.evaluate(
    async (owner) =>
      (await import("/schedule/manage/drafts.mjs"))
        .createDraftJournal()
        .list(owner),
    owner,
  );
const saved = (page) =>
  expect(page.locator("#draft-save-status")).toHaveText(
    "Черновик сохранён на этом устройстве. Не опубликован.",
  );
async function setup(page, options = {}) {
  const manager = await mockManager(page, options);
  await manager.login();
  await page.locator('[data-page="schedule"]').click();
  return manager;
}
async function open(page, kind = "day") {
  await page
    .getByRole("button", {
      name: kind === "day" ? "Копировать день" : "Копировать неделю",
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", {
      name: kind === "day" ? "Копировать день" : "Копировать неделю",
      exact: true,
    }),
  ).toBeVisible();
  return dialog;
}
async function preview(dialog) {
  await dialog
    .getByRole("button", { name: "Предпросмотр копирования", exact: true })
    .click();
}
async function ready(dialog) {
  await expect(
    dialog.getByRole("heading", {
      name: "Предпросмотр новых занятий",
      exact: true,
    }),
  ).toBeVisible();
}
async function choose(dialog, from = "4", to = "1") {
  await dialog.getByLabel("Откуда", { exact: true }).selectOption(from);
  await dialog.getByLabel("Куда", { exact: true }).selectOption(to);
}
const apply = (dialog) =>
  dialog.getByRole("button", { name: "Добавить в черновик", exact: true });
async function audit(page) {
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

test("day preview is read-only and accessible; reviewed IDs survive local save, fresh login recovery and separate publication", async ({
  page,
}, info) => {
  const manager = await setup(page),
    before = manager.state(),
    dialog = await open(page);
  await expect(apply(dialog)).toBeDisabled();
  await choose(dialog);
  await preview(dialog);
  await ready(dialog);
  await expect(dialog.locator(".batch-count")).toHaveText(
    "Будет добавлено: 2. Существующие занятия сохраняются.",
  );
  const ids = await dialog
    .locator("[data-transfer-lesson]")
    .evaluateAll((rows) => rows.map((row) => row.dataset.transferLesson));
  expect(await records(page)).toEqual([]);
  expect(manager.state()).toEqual(before);
  expect(manager.writes()).toEqual([]);
  await audit(page);
  await page.evaluate(() => document.body.classList.add("dark"));
  await audit(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
  ).toBe(false);
  await expect(
    dialog.getByRole("button", { name: "Закрыть копирование", exact: true }),
  ).toBeInViewport();
  await mkdir(resolve("../../outputs/transfer-next"), { recursive: true });
  await page.screenshot({
    path: resolve(
      `../../outputs/transfer-next/preview-${info.project.name}-dark.png`,
    ),
  });
  await apply(dialog).evaluate((button) => {
    button.click();
    button.click();
  });
  await expect(dialog).not.toBeVisible();
  await saved(page);
  const journal = (await records(page))[0];
  expect(journal.changes.map((row) => row.id)).toEqual(ids);
  expect(manager.writes()).toEqual([]);
  await page.reload();
  await manager.login({ navigate: false });
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
    .getByRole("button", { name: "Восстановить в черновик", exact: true })
    .click();
  await saved(page);
  await page.getByRole("button", { name: "Опубликовать", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("Черновик опубликован");
  const after = manager.state();
  expect(after.revision).toBe(before.revision + 1);
  expect(manager.writes()).toHaveLength(1);
  expect(
    after.data.lessons
      .filter((row) => ids.includes(row.id))
      .map((row) => row.subgroup),
  ).toEqual(["А", "А"]);
  expect(
    after.data.lessons
      .filter((row) => ids.includes(row.id))
      .every((row) => row.day === 1),
  ).toBe(true);
  expect(after.data.tasks).toEqual(before.data.tasks);
});

test("same day, empty day and destination conflicts never create an empty draft", async ({
  page,
}) => {
  const manager = await setup(page),
    before = manager.state(),
    dialog = await open(page);
  for (const [from, to] of [
    ["4", "4"],
    ["6", "1"],
    ["4", "0"],
  ]) {
    await choose(dialog, from, to);
    await preview(dialog);
    await expect(dialog.getByRole("alert")).not.toBeEmpty();
    await expect(apply(dialog)).toBeDisabled();
    expect(await records(page)).toEqual([]);
    expect(manager.state()).toEqual(before);
  }
  await dialog
    .getByRole("button", { name: "Закрыть копирование", exact: true })
    .click();
  await expect(
    page.getByText("Черновик · не опубликован", { exact: true }),
  ).toHaveCount(0);
  expect(manager.writes()).toEqual([]);
});

test("parity preview keeps night endings and dates, and editing a selector invalidates the reviewed candidate", async ({
  page,
}) => {
  const manager = await setup(page, {
    prepareData(data) {
      data.lessons[0].week = "odd";
      data.lessons[0].start = "23:00";
      data.lessons[0].end = "00:30";
      data.lessons[0].endDayOffset = 1;
      data.lessons[0].validUntil = "2026-12-01";
    },
  });
  const dialog = await open(page, "week");
  await preview(dialog);
  await ready(dialog);
  await expect(dialog.locator("[data-transfer-lesson]")).toHaveCount(1);
  await expect(dialog.locator("[data-transfer-lesson]")).toContainText(
    "(+1 день)",
  );
  await expect(dialog.locator("[data-transfer-lesson]")).toContainText(
    "2026-12-01",
  );
  await dialog.getByLabel("Куда", { exact: true }).selectOption("odd");
  await expect(apply(dialog)).toBeDisabled();
  await expect(dialog.locator("[data-transfer-lesson]")).toHaveCount(0);
  await dialog.getByLabel("Куда", { exact: true }).selectOption("even");
  await preview(dialog);
  await ready(dialog);
  await apply(dialog).click();
  await saved(page);
  expect((await records(page))[0].changes[0].after).toMatchObject({
    week: "even",
    endDayOffset: 1,
    validUntil: "2026-12-01",
  });
  expect(manager.writes()).toEqual([]);
});

test("unsupported copied provenance is rejected during preview before any draft mutation", async ({
  page,
}) => {
  const manager = await setup(page, {
      prepareData(data) {
        data.lessons[0].source = {
          sheet: "Kept",
          privateFuture: "not journaled",
        };
      },
    }),
    before = manager.state();
  const dialog = await open(page);
  await choose(dialog);
  await preview(dialog);
  await expect(dialog.getByRole("alert")).toContainText("точно восстановить");
  await expect(apply(dialog)).toBeDisabled();
  expect(await records(page)).toEqual([]);
  expect(manager.state()).toEqual(before);
  expect(manager.writes()).toEqual([]);
});

test("a refreshed server revision invalidates a reviewed copy without a hidden draft", async ({
  page,
}) => {
  const manager = await setup(page),
    dialog = await open(page);
  await choose(dialog);
  await preview(dialog);
  await ready(dialog);
  manager.advance("lesson.save", {
    ...manager.state().data.lessons[0],
    type: "Server change",
  });
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/uniflow-api") &&
      r.request().postDataJSON().action === "state",
  );
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await response;
  await expect(dialog.getByRole("alert")).toContainText("Данные изменились");
  await apply(dialog).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Откройте копирование заново",
  );
  await expect(apply(dialog)).toBeDisabled();
  expect(await records(page)).toEqual([]);
  expect(manager.writes()).toEqual([]);
});

async function heldEditor(page) {
  let release, observed;
  const gate = new Promise((r) => {
      release = r;
    }),
    requested = new Promise((r) => {
      observed = r;
    });
  await page.route("**/transfer-editor.mjs", async (route) => {
    observed();
    await gate;
    return route.continue();
  });
  return {
    requested,
    async finish() {
      const response = page.waitForResponse((r) =>
        r.url().endsWith("/transfer-editor.mjs"),
      );
      release();
      await response;
      await page.waitForFunction(
        () =>
          !!Array.from(
            document.querySelectorAll('link[rel="stylesheet"]'),
          ).find((link) => link.href.endsWith("lesson-batch-editor.css"))
            ?.sheet,
      );
      await page.evaluate(() => new Promise(window.requestAnimationFrame));
    },
  };
}
test("late transfer loading cannot replace a profile opened after the copy click", async ({
  page,
}) => {
  const manager = await setup(page),
    gate = await heldEditor(page);
  await page
    .getByRole("button", { name: "Копировать день", exact: true })
    .click();
  await gate.requested;
  await page.locator('[data-action="profile"]').first().click();
  const dialog = page.getByRole("dialog"),
    title = await dialog.locator("h2").textContent();
  await gate.finish();
  await expect(dialog.locator("h2")).toHaveText(title);
  expect(await records(page)).toEqual([]);
  expect(manager.writes()).toEqual([]);
});
test("scope changes during lazy loading cancel opening instead of silently retargeting a copy", async ({
  page,
}) => {
  const manager = await setup(page),
    gate = await heldEditor(page);
  await page
    .getByRole("button", { name: "Копировать день", exact: true })
    .click();
  await gate.requested;
  await page
    .locator('.scope-filter [data-filter="subgroup"]')
    .selectOption("Б");
  await gate.finish();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(await records(page)).toEqual([]);
  expect(manager.writes()).toEqual([]);
});

test("quota failure retains the old durable generation, then retries the exact reviewed IDs without copying again", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.IDBDatabase.prototype.transaction;
    window.IDBDatabase.prototype.transaction = function (names, mode, ...rest) {
      if (
        this.name === "uniflow-owner-drafts-v1" &&
        mode === "readwrite" &&
        localStorage.getItem("qa.transferQuota") === "1"
      )
        throw Error("quota fixture");
      return original.call(this, names, mode, ...rest);
    };
  });
  const manager = await setup(page);
  let dialog = await open(page);
  await choose(dialog);
  await preview(dialog);
  await ready(dialog);
  await apply(dialog).click();
  await saved(page);
  const previous = (await records(page))[0];
  await page.evaluate(() => localStorage.setItem("qa.transferQuota", "1"));
  dialog = await open(page);
  await choose(dialog, "4", "6");
  await preview(dialog);
  await ready(dialog);
  const ids = await dialog
    .locator("[data-transfer-lesson]")
    .evaluateAll((rows) => rows.map((row) => row.dataset.transferLesson));
  await apply(dialog).click();
  await expect(
    dialog.getByRole("button", { name: "Повторить сохранение", exact: true }),
  ).toBeEnabled();
  expect((await records(page))[0]).toEqual(previous);
  await expect(dialog.getByLabel("Куда", { exact: true })).toBeDisabled();
  await page.evaluate(() => localStorage.removeItem("qa.transferQuota"));
  await dialog
    .getByRole("button", { name: "Повторить сохранение", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await saved(page);
  const latest = (await records(page))[0];
  expect(latest.changes).toHaveLength(4);
  expect(latest.changes.filter((row) => ids.includes(row.id))).toHaveLength(2);
  expect(new Set(latest.changes.map((row) => row.id)).size).toBe(4);
  expect(manager.writes()).toEqual([]);
});

test("a changed local template cannot be applied from a stale preview, and a deleted template cannot be reviewed", async ({
  page,
}) => {
  const manager = await setup(page);
  await page.evaluate(async (data) => {
    const t = await import("/schedule/manage/templates.mjs");
    await t.withTemplateLock(() =>
      t.saveTemplate(
        t.createTemplate(data, {
          name: "Test template",
          kind: "day",
          day: 4,
          groupId: "g-main",
          subgroup: "А",
        }),
      ),
    );
  }, manager.state().data);
  await page.getByRole("button", { name: "Шаблоны", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", {
      name: "Применить шаблон Test template",
      exact: true,
    })
    .click();
  await dialog.getByLabel("День назначения", { exact: true }).selectOption("6");
  await preview(dialog);
  await ready(dialog);
  await page.evaluate(() => {
    const key = "uf.schedule.templates.v1.live",
      rows = JSON.parse(localStorage.getItem(key));
    rows[0].name = "Changed template";
    localStorage.setItem(key, JSON.stringify(rows));
  });
  await apply(dialog).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Шаблон изменён или удалён",
  );
  expect(await records(page)).toEqual([]);
  await dialog
    .getByRole("button", { name: "Назад к шаблонам", exact: true })
    .click();
  await dialog
    .getByRole("button", {
      name: "Применить шаблон Changed template",
      exact: true,
    })
    .click();
  await page.evaluate(() =>
    localStorage.setItem("uf.schedule.templates.v1.live", "[]"),
  );
  await preview(dialog);
  await expect(dialog.getByRole("alert")).toContainText(
    "Шаблон изменён или удалён",
  );
  expect(await records(page)).toEqual([]);
  expect(manager.writes()).toEqual([]);
});

test("closing during durable save updates the visible draft without closing a subsequent dialog", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.IDBDatabase.prototype.transaction;
    window.IDBDatabase.prototype.transaction = function (names, mode, ...rest) {
      const tx = original.call(this, names, mode, ...rest);
      if (
        this.name === "uniflow-owner-drafts-v1" &&
        mode === "readwrite" &&
        window.qaCloseTransferOnSave
      ) {
        window.qaCloseTransferOnSave = false;
        const prop = Object.getOwnPropertyDescriptor(
          window.IDBTransaction.prototype,
          "oncomplete",
        );
        Object.defineProperty(tx, "oncomplete", {
          set(handler) {
            prop.set.call(tx, function (event) {
              document.querySelector("#modal .dialog-head button")?.click();
              document.querySelector('[data-action="profile"]')?.click();
              handler.call(this, event);
            });
          },
        });
      }
      return tx;
    };
  });
  const manager = await setup(page),
    dialog = await open(page);
  await choose(dialog);
  await preview(dialog);
  await ready(dialog);
  await page.evaluate(() => {
    window.qaCloseTransferOnSave = true;
  });
  await apply(dialog).click();
  await expect(
    dialog.getByRole("heading", { name: "Копировать день", exact: true }),
  ).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await saved(page);
  expect((await records(page))[0].changes).toHaveLength(2);
  expect(manager.writes()).toEqual([]);
});

test("large copies render forty closed cards per page and keep literal labels safe", async ({
  page,
}) => {
  const manager = await setup(page, {
      prepareData(data) {
        const seed = data.lessons[0];
        data.lessons = Array.from({ length: 41 }, (_, i) => ({
          ...seed,
          id: "source-" + i,
          day: 4,
          start: `${String(Math.floor(i / 12)).padStart(2, "0")}:${String((i % 12) * 5).padStart(2, "0")}`,
          end: `${String(Math.floor(i / 12)).padStart(2, "0")}:${String((i % 12) * 5 + 4).padStart(2, "0")}`,
          teacherId: "",
          roomId: "",
        }));
        data.subjects[0].name = '<img src=x onerror="window.transferXss=1">';
        data.subjects[0].privateNote = "NEVER_DISPLAY";
      },
    }),
    dialog = await open(page);
  await choose(dialog);
  await preview(dialog);
  await ready(dialog);
  await expect(dialog.locator("[data-transfer-lesson]")).toHaveCount(40);
  await expect(dialog.locator("[data-transfer-lesson]").first()).toContainText(
    "<img",
  );
  await expect(dialog.locator("img,script")).toHaveCount(0);
  expect(await page.evaluate(() => window.transferXss)).toBeUndefined();
  await expect(dialog).not.toContainText("NEVER_DISPLAY");
  await dialog
    .getByRole("button", { name: "Следующие занятия", exact: true })
    .click();
  await expect(dialog.locator("[data-transfer-lesson]")).toHaveCount(1);
  await audit(page);
  expect(await records(page)).toEqual([]);
  expect(manager.writes()).toEqual([]);
});

test("closing during deferred preview cannot repopulate another dialog or create a hidden draft", async ({
  page,
}) => {
  const manager = await setup(page);
  await page.evaluate(() => {
    const original = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = function (callback) {
      if (window.qaHoldTransferPreview) {
        window.qaHoldTransferPreview = false;
        window.qaTransferPreviewStarted = true;
        window.qaReleaseTransferPreview = () =>
          callback(window.performance.now());
        return 1;
      }
      return original(callback);
    };
  });
  const dialog = await open(page);
  await choose(dialog);
  await page.evaluate(() => {
    window.qaHoldTransferPreview = true;
    Array.from(document.querySelectorAll("#modal button"))
      .find((button) => button.textContent === "Предпросмотр копирования")
      .click();
  });
  await expect
    .poll(() => page.evaluate(() => window.qaTransferPreviewStarted))
    .toBe(true);
  await dialog
    .getByRole("button", { name: "Закрыть копирование", exact: true })
    .click();
  await page.locator('[data-action="profile"]').first().click();
  const title = await dialog.locator("h2").textContent();
  await page.evaluate(() => {
    window.qaReleaseTransferPreview();
  });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        window.requestAnimationFrame(() =>
          window.requestAnimationFrame(resolve),
        ),
      ),
  );
  await expect(dialog.locator("h2")).toHaveText(title);
  expect(await records(page)).toEqual([]);
  expect(manager.writes()).toEqual([]);
});
