import { test, expect } from "@playwright/test";
import { mockManager } from "./manager-fixture.mjs";
import { exportScheduleCsv } from "../../app/manage/tools.mjs";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const owner = "11111111-1111-4111-8111-111111111111";
const scope = { groupId: "g-main", subgroup: "А" };
const header = "day,start,end,subject,room,teacher,type,subgroup,week,id\n";
const csv = (day = 1, start = "09:00", type = "Импорт") =>
  header + `${day},${start},09:50,math,204,teacher,${type},А,all,`;
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
async function open(page) {
  await page.locator('[data-page="schedule"]').click();
  await page.getByRole("button", { name: "Импорт CSV", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Импорт CSV", exact: true }),
  ).toBeVisible();
  return page.getByRole("dialog");
}
async function file(dialog, text, name = "schedule.csv") {
  await dialog
    .getByLabel("Файл CSV", { exact: true })
    .setInputFiles({ name, mimeType: "text/csv", buffer: Buffer.from(text) });
}
async function preview(dialog) {
  await dialog
    .getByRole("button", { name: "Предпросмотр CSV", exact: true })
    .click();
  await expect(
    dialog.getByRole("heading", {
      name: "Предпросмотр изменений",
      exact: true,
    }),
  ).toBeVisible();
}
async function apply(page, dialog) {
  await dialog
    .getByRole("button", { name: "Добавить в черновик", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await saved(page);
}
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
test("CSV preview is read-only, literal and accessible; explicit apply saves a draft and publication remains separate", async ({
  page,
}, info) => {
  const manager = await mockManager(page);
  await manager.login();
  const before = manager.state();
  const dialog = await open(page);
  await file(dialog, csv(1, "09:00", "<img src=x onerror=alert(1)>"));
  await preview(dialog);
  await expect(dialog.locator(".batch-count")).toHaveText(
    "Добавить: 1. Изменить: 0. Удалить: 0. Без изменений: 2.",
  );
  await expect(dialog.locator("[data-csv-change]")).toHaveCount(1);
  await expect(dialog.locator("[data-csv-change]").first()).toBeInViewport({
    ratio: 1,
  });
  await expect(dialog.locator("img,script")).toHaveCount(0);
  expect(await records(page)).toEqual([]);
  expect(manager.state()).toEqual(before);
  expect(manager.writes()).toEqual([]);
  await audit(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
  ).toBe(false);
  await mkdir(resolve("../../outputs/import-next"), { recursive: true });
  await page.screenshot({
    path: resolve(`../../outputs/import-next/preview-${info.project.name}.png`),
  });
  await apply(page, dialog);
  expect((await records(page))[0].changes).toHaveLength(1);
  expect(manager.writes()).toEqual([]);
  await page.getByRole("button", { name: "Опубликовать", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("Черновик опубликован");
  expect(manager.writes()).toHaveLength(1);
  expect(manager.state().revision).toBe(before.revision + 1);
  expect(manager.state().data.lessons).toHaveLength(
    before.data.lessons.length + 1,
  );
  expect(manager.state().data.tasks).toEqual(before.data.tasks);
});
test("replacement explicitly reviews edits and removals, preserves provenance and other subgroups, and survives fresh login recovery", async ({
  page,
}) => {
  const manager = await mockManager(page, {
    prepareData(data) {
      data.lessons[0].source = { sheet: "Kept", timeCell: "B2" };
      data.lessons[0].future = { retained: true };
    },
  });
  await manager.login();
  const before = manager.state();
  let dialog = await open(page);
  await dialog
    .getByRole("combobox", { name: "Режим импорта", exact: true })
    .selectOption("replace-scope");
  await file(
    dialog,
    header + "4,08:10,09:50,math,204,teacher,Обновлённый тип,А,all,now-a",
  );
  await preview(dialog);
  await expect(dialog.locator(".batch-count")).toHaveText(
    "Добавить: 0. Изменить: 1. Удалить: 1. Без изменений: 0.",
  );
  await expect(dialog.locator('[data-csv-change="removed"]')).toContainText(
    "Было:",
  );
  await apply(page, dialog);
  expect(manager.writes()).toEqual([]);
  const journal = JSON.stringify(await records(page));
  expect(journal).not.toContain("ow1a.");
  expect(journal).not.toContain("attendance");
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
  dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Восстановить в черновик", exact: true })
    .click();
  await saved(page);
  await page.getByRole("button", { name: "Опубликовать", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("Черновик опубликован");
  const after = manager.state().data;
  expect(after.lessons.find((row) => row.id === "now-a")).toMatchObject({
    start: "08:10",
    source: { sheet: "Kept", timeCell: "B2" },
    future: { retained: true },
  });
  expect(after.lessons.some((row) => row.id === "monday-lesson")).toBe(false);
  for (const id of ["next", "later-b"])
    expect(after.lessons.find((row) => row.id === id)).toEqual(
      before.data.lessons.find((row) => row.id === id),
    );
  expect(after.tasks).toEqual(before.data.tasks);
});
test("no-op exports and invalid files never create a draft; changing mode or file invalidates a reviewed plan", async ({
  page,
}) => {
  const manager = await mockManager(page);
  await manager.login();
  const dialog = await open(page);
  await dialog
    .getByRole("combobox", { name: "Режим импорта", exact: true })
    .selectOption("replace-scope");
  await file(dialog, exportScheduleCsv(manager.state().data, scope));
  await preview(dialog);
  await expect(
    dialog.getByRole("button", { name: "Добавить в черновик", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByText("Изменений нет. Черновик не изменён.", { exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("combobox", { name: "Режим импорта", exact: true })
    .selectOption("append");
  for (const text of [
    "wrong",
    csv().replace("math", "Unknown"),
    csv().replace("1,09:00", "4,08:00"),
    csv().replace("week,id", "week,id,unexpected"),
  ]) {
    await file(dialog, text);
    await dialog
      .getByRole("button", { name: "Предпросмотр CSV", exact: true })
      .click();
    await expect(dialog.locator("#form-error")).not.toBeEmpty();
    expect(await records(page)).toEqual([]);
  }
  await dialog.getByLabel("Файл CSV", { exact: true }).setInputFiles({
    name: "invalid.csv",
    mimeType: "text/csv",
    buffer: Buffer.from([255]),
  });
  await dialog
    .getByRole("button", { name: "Предпросмотр CSV", exact: true })
    .click();
  await expect(dialog.locator("#form-error")).toContainText("UTF-8");
  await dialog.getByLabel("Файл CSV", { exact: true }).setInputFiles({
    name: "large.csv",
    mimeType: "text/csv",
    buffer: Buffer.alloc(1_000_001, 120),
  });
  await dialog
    .getByRole("button", { name: "Предпросмотр CSV", exact: true })
    .click();
  await expect(dialog.locator("#form-error")).toContainText("1 МБ");
  expect(await records(page)).toEqual([]);
  await file(dialog, csv());
  await preview(dialog);
  await dialog
    .getByRole("combobox", { name: "Режим импорта", exact: true })
    .selectOption("replace-scope");
  await expect(dialog.locator("[data-csv-change]")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Добавить в черновик", exact: true }),
  ).toBeDisabled();
  await file(dialog, csv());
  await preview(dialog);
  await file(dialog, csv(2));
  await expect(
    dialog.getByRole("button", { name: "Добавить в черновик", exact: true }),
  ).toBeDisabled();
  expect(await records(page)).toEqual([]);
  expect(manager.writes()).toEqual([]);
});
test("unsupported source metadata is rejected during review before any draft mutation", async ({
  page,
}) => {
  const manager = await mockManager(page, {
    prepareData(data) {
      data.lessons[0].source = {
        sheet: "Kept",
        unknownPrivateMetadata: "Never copy to journal",
      };
    },
  });
  await manager.login();
  const before = manager.state();
  const dialog = await open(page);
  await dialog
    .getByRole("combobox", { name: "Режим импорта", exact: true })
    .selectOption("replace-scope");
  await file(
    dialog,
    header + "4,08:10,09:50,math,204,teacher,Обновлённый тип,А,all,now-a",
  );
  await dialog
    .getByRole("button", { name: "Предпросмотр CSV", exact: true })
    .click();
  await expect(dialog.locator("#form-error")).toContainText("Файл не применён");
  await expect(
    dialog.getByRole("button", { name: "Добавить в черновик", exact: true }),
  ).toBeDisabled();
  expect(await records(page)).toEqual([]);
  expect(manager.state()).toEqual(before);
  expect(manager.writes()).toEqual([]);
});
test("a newer server revision invalidates apply instead of creating a draft against the newer base", async ({
  page,
}) => {
  const manager = await mockManager(page);
  await manager.login();
  const dialog = await open(page);
  await file(dialog, csv());
  await preview(dialog);
  manager.advance("lesson.save", {
    ...manager.state().data.lessons[0],
    type: "Серверная правка",
  });
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/uniflow-api") &&
      r.request().postDataJSON().action === "state",
  );
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await response;
  await expect(dialog.locator("#form-error")).toContainText(
    "Данные изменились",
  );
  await dialog
    .getByRole("button", { name: "Добавить в черновик", exact: true })
    .click();
  await expect(dialog.locator("#form-error")).toContainText(
    "Откройте импорт заново",
  );
  await expect(
    dialog.getByRole("button", { name: "Добавить в черновик", exact: true }),
  ).toBeDisabled();
  expect(await records(page)).toEqual([]);
  expect(manager.writes()).toEqual([]);
});
async function gatedFile(page) {
  await page.addInitScript(() => {
    const original = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = async function () {
      if (this.name === "held.csv") {
        window.qaCsvReadStarted = true;
        await new Promise((resolve) => (window.qaReleaseCsvRead = resolve));
      }
      return original.call(this);
    };
  });
}
test("scope changes while a file is being read cannot import into either subgroup", async ({
  page,
}) => {
  await gatedFile(page);
  const manager = await mockManager(page);
  await manager.login();
  const dialog = await open(page);
  await file(dialog, csv(), "held.csv");
  await dialog
    .getByRole("button", { name: "Предпросмотр CSV", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.qaCsvReadStarted))
    .toBe(true);
  await page.evaluate(() => {
    const select = document.querySelector('[data-filter="subgroup"]');
    select.value = "Б";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    window.qaReleaseCsvRead();
  });
  await expect(dialog.locator("#form-error")).toContainText(
    "Группа или подгруппа изменились",
  );
  expect(await records(page)).toEqual([]);
  expect(manager.writes()).toEqual([]);
});
test("closing during file reading cannot populate a newly opened dialog or create a hidden draft", async ({
  page,
}) => {
  await gatedFile(page);
  const manager = await mockManager(page);
  await manager.login();
  let dialog = await open(page);
  await file(dialog, csv(), "held.csv");
  await dialog
    .getByRole("button", { name: "Предпросмотр CSV", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.qaCsvReadStarted))
    .toBe(true);
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  dialog = await open(page);
  await page.evaluate(() => window.qaReleaseCsvRead());
  await file(dialog, csv(2));
  await preview(dialog);
  await expect(dialog.locator("[data-csv-change]")).toHaveCount(1);
  await expect(dialog.locator("[data-csv-change]")).toContainText("Среда");
  expect(await records(page)).toEqual([]);
  expect(manager.writes()).toEqual([]);
});
test("quota failure retains the earlier durable draft and retry saves the exact latest import without reapplying", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.IDBDatabase.prototype.transaction;
    window.IDBDatabase.prototype.transaction = function (names, mode, ...rest) {
      if (
        this.name === "uniflow-owner-drafts-v1" &&
        mode === "readwrite" &&
        localStorage.getItem("qa.csvQuota") === "1"
      )
        throw Error("quota fixture");
      return original.call(this, names, mode, ...rest);
    };
  });
  const manager = await mockManager(page);
  await manager.login();
  let dialog = await open(page);
  await file(dialog, csv());
  await preview(dialog);
  await apply(page, dialog);
  const previous = (await records(page))[0];
  await page.evaluate(() => localStorage.setItem("qa.csvQuota", "1"));
  dialog = await open(page);
  await file(dialog, csv(2));
  await preview(dialog);
  await dialog
    .getByRole("button", { name: "Добавить в черновик", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Повторить сохранение", exact: true }),
  ).toBeEnabled();
  expect((await records(page))[0]).toEqual(previous);
  expect(manager.writes()).toEqual([]);
  await expect(dialog.getByLabel("Файл CSV", { exact: true })).toBeDisabled();
  await page.evaluate(() => localStorage.removeItem("qa.csvQuota"));
  await dialog
    .getByRole("button", { name: "Повторить сохранение", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await saved(page);
  const latest = (await records(page))[0];
  expect(latest.changes).toHaveLength(2);
  expect(new Set(latest.changes.map((row) => row.id)).size).toBe(2);
});
test("large previews render forty changes at a time and remain accessible in dark mode", async ({
  page,
}) => {
  const manager = await mockManager(page);
  await manager.login();
  await page.evaluate(() => document.body.classList.add("dark"));
  const dialog = await open(page);
  const rows = Array.from({ length: 42 }, (_, i) => {
    const min = 5 * i;
    const clock = (m) =>
      `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    return `2,${clock(min)},${clock(min + 4)},math,,,Пара,А,all,`;
  });
  await file(dialog, header + rows.join("\n"));
  await preview(dialog);
  await expect(dialog.locator("[data-csv-change]")).toHaveCount(40);
  await dialog
    .getByRole("button", { name: "Следующие изменения", exact: true })
    .click();
  await expect(dialog.locator("[data-csv-change]")).toHaveCount(2);
  await audit(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
  ).toBe(false);
  expect(manager.writes()).toEqual([]);
  expect(await records(page)).toEqual([]);
});
