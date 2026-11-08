import { test, expect } from "@playwright/test";
import { mockManager } from "./manager-fixture.mjs";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const ack = "Подтверждаю замену назначений всех групп в локальном черновике";
const owner = "11111111-1111-4111-8111-111111111111",
  issues = new WeakMap();
test.beforeEach(({ page }) => {
  const found = [];
  issues.set(page, found);
  page.on("pageerror", (e) => found.push(e.message));
  page.on("console", (m) => {
    if (["error", "warning"].includes(m.type())) found.push(m.text());
  });
});
test.afterEach(({ page }) => expect(issues.get(page)).toEqual([]));
async function setup(page, prepare = () => {}) {
  const manager = await mockManager(page, {
    prepareData(d) {
      d.source = null;
      d.sourceWarnings = [];
      prepare(d);
    },
  });
  await manager.login();
  return manager;
}
async function open(page) {
  await page.locator('[data-page="schedule"]').click();
  await page.getByRole("button", { name: "Импорт JSON", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", {
      name: "Импорт JSON — все группы",
      exact: true,
    }),
  ).toBeVisible();
  return dialog;
}
const raw = (data) => JSON.stringify({ format: "uniflow-2", ...data });
const records = (page) =>
  page.evaluate(
    async (owner) =>
      (await import("/schedule/manage/drafts.mjs"))
        .createDraftJournal()
        .list(owner),
    owner,
  );
async function file(dialog, text, name = "schedule.json") {
  await dialog.getByLabel("Файл JSON", { exact: true }).setInputFiles({
    name,
    mimeType: "application/json",
    buffer: Buffer.isBuffer(text) ? text : Buffer.from(text),
  });
}
async function preview(dialog) {
  await dialog
    .getByRole("button", { name: "Предпросмотр JSON", exact: true })
    .click();
}
const ready = (dialog) =>
  expect(
    dialog.getByRole("heading", {
      name: "Предпросмотр изменений",
      exact: true,
    }),
  ).toBeVisible();
const apply = (dialog) =>
  dialog.getByRole("button", { name: "Добавить в черновик", exact: true });
const saved = (page) =>
  expect(page.locator("#draft-save-status")).toHaveText(
    "Черновик сохранён на этом устройстве. Не опубликован.",
  );
async function changeRoom(page, name) {
  await page.locator('[data-page="catalogs"]').click();
  await page.locator('[data-kind="rooms"]').click();
  await page
    .locator("tbody tr")
    .filter({ has: page.locator("strong", { hasText: /^204$/ }) })
    .getByRole("button", { name: "Изменить", exact: true })
    .click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Название / имя", { exact: true }).fill(name);
  await d.getByRole("button", { name: "Сохранить", exact: true }).click();
  await saved(page);
}

test("JSON preview is read-only, closed and accessible; confirmation saves a durable draft and only separate publication changes the server", async ({
  page,
}, info) => {
  const manager = await setup(page),
    before = manager.state(),
    input = structuredClone(before.data);
  input.rooms[0].name = "Аудитория из JSON";
  input.rooms[0].note = "PRIVATE_OWNER_NOTE";
  input.tasks = [];
  input.announcements = [{ body: "SECRET_ANNOUNCEMENT" }];
  input.accounts = [{ token: "IGNORED_TOKEN" }];
  const dialog = await open(page);
  await file(dialog, raw(input));
  await preview(dialog);
  await ready(dialog);
  await expect(dialog.locator("[data-json-change]")).toHaveCount(1);
  await expect(dialog).not.toContainText("PRIVATE_OWNER_NOTE");
  await expect(dialog).not.toContainText("SECRET_ANNOUNCEMENT");
  await expect(dialog).not.toContainText("IGNORED_TOKEN");
  await expect(apply(dialog)).toBeDisabled();
  expect(manager.state()).toEqual(before);
  expect(await records(page)).toEqual([]);
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
      dialog.getByRole("button", { name: "Предпросмотр JSON", exact: true }),
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
          `json-${info.project.name}-${theme}.png`,
        ),
      });
    }
  }
  await dialog.getByLabel(ack, { exact: true }).check();
  await apply(dialog).click();
  await expect(dialog).not.toBeVisible();
  await saved(page);
  expect(manager.state()).toEqual(before);
  expect(JSON.stringify(await records(page))).not.toMatch(
    /IGNORED_TOKEN|SECRET_ANNOUNCEMENT|ow1a\./,
  );
  await page.getByRole("button", { name: "Опубликовать", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("Черновик опубликован");
  expect(manager.writes()).toHaveLength(1);
  expect(manager.state().revision).toBe(before.revision + 1);
  expect(manager.state().data.rooms[0].name).toBe(input.rooms[0].name);
  expect(manager.state().data.tasks).toEqual(before.data.tasks);
  expect(manager.state().data.announcements).toHaveLength(1);
});
test("preview compares the current unpublished draft and survives fresh login recovery without publishing it", async ({
  page,
}) => {
  const manager = await setup(page);
  await changeRoom(page, "Моя локальная правка");
  const before = manager.state();
  const input = structuredClone(before.data);
  input.rooms[1].name = "Из файла";
  const dialog = await open(page);
  await file(dialog, raw(input));
  await preview(dialog);
  await ready(dialog);
  await expect(dialog.locator("[data-json-change]")).toHaveCount(2);
  await expect(dialog).toContainText("Моя локальная правка");
  await dialog.getByLabel(ack).check();
  await apply(dialog).click();
  await expect(dialog).not.toBeVisible();
  await saved(page);
  expect(manager.state()).toEqual(before);
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
  await page.locator('[data-page="catalogs"]').click();
  await page.locator('[data-kind="rooms"]').click();
  await expect(page.locator("tbody")).toContainText("Из файла");
  expect(manager.writes()).toEqual([]);
});
test("global changes are paged forty at a time and changing pages or files removes confirmation", async ({
  page,
}) => {
  const manager = await setup(page, (d) => {
    d.groups.push({ id: "other", name: "Другая группа", subgroups: ["А"] });
    d.rooms.push(
      ...Array.from({ length: 81 }, (_, i) => ({
        id: "r-" + i,
        name: "Аудитория " + i,
        capacity: 20,
      })),
    );
  });
  const input = manager.state().data;
  input.rooms.forEach((r) => {
    r.name += " новая";
  });
  const dialog = await open(page);
  await file(dialog, raw(input));
  await preview(dialog);
  await ready(dialog);
  await expect(dialog.locator("[data-json-change]")).toHaveCount(40);
  await expect(dialog.locator(".batch-count")).toContainText("Групп: 2 → 2");
  await dialog.getByLabel(ack).check();
  await dialog
    .getByRole("button", { name: "Следующие изменения", exact: true })
    .click();
  await expect(dialog.getByLabel(ack)).not.toBeChecked();
  await expect(apply(dialog)).toBeDisabled();
  await dialog
    .getByRole("button", { name: "Следующие изменения", exact: true })
    .click();
  await expect(dialog.locator("[data-json-change]")).toHaveCount(3);
  await file(dialog, raw(manager.state().data));
  await expect(
    dialog.getByRole("heading", {
      name: "Предпросмотр изменений",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(manager.writes()).toEqual([]);
});
test("malformed JSON, invalid UTF-8, too-large files, conflicts and nonrecoverable metadata never create a draft", async ({
  page,
}) => {
  const manager = await setup(page),
    before = manager.state(),
    dialog = await open(page),
    bad = structuredClone(before.data),
    unknown = structuredClone(before.data),
    reordered = structuredClone(before.data);
  bad.lessons[1].start = "08:10";
  unknown.lessons[0].unrecoverable = "never save";
  reordered.subjects.reverse();
  for (const text of [
    "{",
    raw({ ...before.data, format: "other" }),
    Buffer.from([255, 254, 253]),
    "я".repeat(500001),
    raw(bad),
    raw(unknown),
    raw(reordered),
  ]) {
    await file(dialog, text);
    await preview(dialog);
    await expect(dialog.getByRole("alert")).not.toBeEmpty();
    await expect(apply(dialog)).toBeDisabled();
    expect(await records(page)).toEqual([]);
    expect(manager.state()).toEqual(before);
  }
  expect(manager.writes()).toEqual([]);
});
test("a server refresh invalidates checked JSON before it can overwrite a newer published revision", async ({
  page,
}) => {
  const manager = await setup(page),
    input = manager.state().data;
  input.rooms[0].name = "Из старого файла";
  const dialog = await open(page);
  await file(dialog, raw(input));
  await preview(dialog);
  await ready(dialog);
  await dialog.getByLabel(ack).check();
  manager.advance("catalog.save", {
    entity: "rooms",
    item: { id: "204", name: "Новая публикация" },
  });
  const before = manager.state();
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(dialog.getByRole("alert")).toContainText("Данные изменились");
  await apply(dialog).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Данные или версия изменились",
  );
  expect(await records(page)).toEqual([]);
  expect(manager.state()).toEqual(before);
  expect(manager.writes()).toEqual([]);
});
test("closing during delayed file reading cannot reopen the importer or repopulate another dialog", async ({
  page,
}) => {
  const manager = await setup(page),
    input = manager.state().data;
  input.rooms[0].name = "Поздний файл";
  const dialog = await open(page);
  await file(dialog, raw(input));
  await page.evaluate(() => {
    const original = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      const selected = this;
      return new Promise((resolve) => {
        window.qaReleaseJson = async () =>
          resolve(await original.call(selected));
      });
    };
  });
  await preview(dialog);
  await expect
    .poll(() => page.evaluate(() => typeof window.qaReleaseJson))
    .toBe("function");
  await dialog
    .getByRole("button", { name: "Закрыть импорт", exact: true })
    .click();
  await page.locator('[data-action="profile"]').first().click();
  const title = await dialog.locator("h2").textContent();
  await page.evaluate(() => window.qaReleaseJson());
  await expect(dialog.locator("h2")).toHaveText(title);
  await expect(dialog.locator("[data-json-change]")).toHaveCount(0);
  expect(await records(page)).toEqual([]);
  expect(manager.writes()).toEqual([]);
});
test("quota failure retains the prior durable copy and the exact reviewed draft until explicit save retry", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.IDBDatabase.prototype.transaction;
    window.IDBDatabase.prototype.transaction = function (names, mode, ...rest) {
      if (
        this.name === "uniflow-owner-drafts-v1" &&
        mode === "readwrite" &&
        window.qaJsonQuota
      )
        throw Error("quota");
      return original.call(this, names, mode, ...rest);
    };
  });
  const manager = await setup(page);
  await changeRoom(page, "Предыдущая локальная копия");
  const old = (await records(page))[0],
    input = manager.state().data;
  input.rooms[1].name = "Проверенный импорт";
  const dialog = await open(page);
  await file(dialog, raw(input));
  await preview(dialog);
  await ready(dialog);
  await dialog.getByLabel(ack).check();
  await page.evaluate(() => {
    window.qaJsonQuota = true;
  });
  await apply(dialog).click();
  await expect(
    dialog.getByRole("button", { name: "Повторить сохранение", exact: true }),
  ).toBeVisible();
  expect((await records(page))[0]).toEqual(old);
  await page.evaluate(() => {
    window.qaJsonQuota = false;
  });
  await dialog
    .getByRole("button", { name: "Повторить сохранение", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await saved(page);
  const next = (await records(page)).find((r) => r.id === old.id);
  expect(next.generation).toBe(old.generation + 1);
  expect(
    next.changes.some(
      (c) => c.kind === "rooms" && c.after.name === "Проверенный импорт",
    ),
  ).toBe(true);
  expect(manager.writes()).toEqual([]);
});
test("identical effective data blocks no-op import, and HTML-like labels remain text", async ({
  page,
}) => {
  const manager = await setup(page),
    dialog = await open(page);
  await file(dialog, raw(manager.state().data));
  await preview(dialog);
  await ready(dialog);
  await expect(dialog).toContainText("Изменений нет. Черновик не изменён.");
  await expect(dialog.getByLabel(ack)).toBeDisabled();
  await expect(apply(dialog)).toBeDisabled();
  const input = manager.state().data;
  input.rooms[0].name = '<img src=x onerror="window.jsonXss=1">';
  await file(dialog, raw(input));
  await preview(dialog);
  await ready(dialog);
  await expect(dialog.locator("[data-json-change]")).toContainText(
    "<img src=x",
  );
  await expect(dialog.locator("img,script")).toHaveCount(0);
  expect(await page.evaluate(() => window.jsonXss)).toBeUndefined();
  expect(manager.writes()).toEqual([]);
});
test("late lazy editor loading cannot replace a profile opened after the import click", async ({
  page,
}) => {
  const manager = await setup(page);
  let release, observed;
  const gate = new Promise((r) => {
      release = r;
    }),
    requested = new Promise((r) => {
      observed = r;
    });
  await page.route("**/json-import-editor.mjs", async (route) => {
    observed();
    await gate;
    return route.continue();
  });
  await page.locator('[data-page="schedule"]').click();
  await page.getByRole("button", { name: "Импорт JSON", exact: true }).click();
  await requested;
  await page.locator('[data-action="profile"]').first().click();
  const dialog = page.getByRole("dialog"),
    title = await dialog.locator("h2").textContent(),
    response = page.waitForResponse((r) =>
      r.url().endsWith("/json-import-editor.mjs"),
    );
  release();
  await response;
  await page.waitForFunction(
    () =>
      !!Array.from(document.querySelectorAll('link[rel="stylesheet"]')).find(
        (link) => link.href.endsWith("lesson-batch-editor.css"),
      )?.sheet,
  );
  await page.evaluate(() => new Promise(window.requestAnimationFrame));
  await expect(dialog.locator("h2")).toHaveText(title);
  expect(await records(page)).toEqual([]);
  expect(manager.writes()).toEqual([]);
});
test("closing during durable save keeps the applied visible draft without closing the next dialog", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.IDBDatabase.prototype.transaction;
    window.IDBDatabase.prototype.transaction = function (names, mode, ...rest) {
      const tx = original.call(this, names, mode, ...rest);
      if (
        this.name === "uniflow-owner-drafts-v1" &&
        mode === "readwrite" &&
        window.qaCloseJsonOnSave
      ) {
        window.qaCloseJsonOnSave = false;
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
    input = manager.state().data;
  input.rooms[0].name = "Сохранено после закрытия";
  const dialog = await open(page);
  await file(dialog, raw(input));
  await preview(dialog);
  await ready(dialog);
  await dialog.getByLabel(ack).check();
  await page.evaluate(() => {
    window.qaCloseJsonOnSave = true;
  });
  await apply(dialog).click();
  await expect(
    dialog.getByRole("heading", {
      name: "Импорт JSON — все группы",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await saved(page);
  await page.locator('[data-page="catalogs"]').click();
  await page.locator('[data-kind="rooms"]').click();
  await expect(page.locator("tbody")).toContainText("Сохранено после закрытия");
  expect((await records(page)).some((r) => r.status === "active")).toBe(true);
  expect(manager.writes()).toEqual([]);
});

test("removing the viewed group through an explicit global import selects a remaining valid group", async ({
  page,
}) => {
  const manager = await setup(page, (d) => {
    d.tasks = [];
    d.groups.push({ id: "other", name: "Новая группа", subgroups: ["А", "Б"] });
  });
  const input = manager.state().data;
  input.groups = input.groups.filter((group) => group.id === "other");
  input.lessons.forEach((lesson) => {
    lesson.groupId = "other";
  });
  const before = manager.state(),
    dialog = await open(page);
  await file(dialog, raw(input));
  await preview(dialog);
  await ready(dialog);
  await expect(dialog.locator(".batch-count")).toContainText("Групп: 2 → 1");
  await dialog.getByLabel(ack).check();
  await apply(dialog).click();
  await expect(dialog).not.toBeVisible();
  await saved(page);
  await expect(
    page.locator('select[data-filter="groupId"]').first(),
  ).toHaveValue("other");
  await expect(page.locator(".schedule-table")).toContainText("Алгоритмы");
  expect(manager.state()).toEqual(before);
  expect(manager.writes()).toEqual([]);
});
