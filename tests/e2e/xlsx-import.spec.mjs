import { test, expect } from "@playwright/test";
import { mockManager } from "./manager-fixture.mjs";
import { workbook, xlsxRow } from "../xlsx-fixtures.mjs";
import { exportScheduleXlsx } from "../../app/manage/xlsx.mjs";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const issues = new WeakMap(),
  owner = "11111111-1111-4111-8111-111111111111";
const sheetPath = "xl/worksheets/sheet1.xml";
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
async function open(page) {
  await page.locator('[data-page="schedule"]').click();
  await page.getByRole("button", { name: "Импорт XLSX", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Импорт XLSX", exact: true }),
  ).toBeVisible();
  return dialog;
}
async function load(dialog, bytes, name = "schedule.xlsx") {
  await dialog.getByLabel("Файл XLSX", { exact: true }).setInputFiles({
    name,
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(bytes),
  });
  await dialog
    .getByRole("button", { name: "Прочитать XLSX", exact: true })
    .click();
  await expect(
    dialog.getByRole("combobox", { name: "Лист XLSX", exact: true }),
  ).toBeVisible();
}
async function preview(dialog, sheet = "sheet") {
  await dialog
    .getByRole("combobox", { name: "Лист XLSX", exact: true })
    .selectOption(sheet);
  await dialog
    .getByRole("button", { name: "Предпросмотр XLSX", exact: true })
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
  await expect(page.locator("#draft-save-status")).toHaveText(
    "Черновик сохранён на этом устройстве. Не опубликован.",
  );
}
const patchCell = (parts, ref, xml) =>
  (parts[sheetPath] = parts[sheetPath].replace(
    new RegExp(`<c r="${ref}"[^>]*>.*?</c>`),
    xml,
  ));
async function parse(page, bytes) {
  return page.evaluate(
    async (bytes) => {
      try {
        const w = await (
          await import("/schedule/manage/xlsx.mjs")
        ).readScheduleWorkbook(new Uint8Array(bytes));
        return await w.readSheet(
          w.sheets.find((s) => s.state === "visible").id,
        );
      } catch (e) {
        return { error: e.message };
      }
    },
    [...bytes],
  );
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

test("XLSX requires explicit sheet choice; literal preview is accessible and publication is separate", async ({
  page,
}, info) => {
  const manager = await mockManager(page);
  await manager.login();
  const before = manager.state(),
    dialog = await open(page);
  await load(
    dialog,
    await workbook(
      [xlsxRow(1, "<img src=x onerror=alert(1)>_x0041_")],
      () => {},
      true,
    ),
  );
  await expect(
    dialog.getByRole("combobox", { name: "Лист XLSX", exact: true }),
  ).toHaveValue("");
  await dialog
    .getByRole("button", { name: "Предпросмотр XLSX", exact: true })
    .click();
  await expect(dialog.locator("#form-error")).toContainText(
    "выберите видимый лист",
  );
  await preview(dialog);
  await expect(dialog.locator(".batch-count")).toHaveText(
    "Добавить: 1. Изменить: 0. Удалить: 0. Без изменений: 2.",
  );
  await expect(dialog.locator("[data-xlsx-change]")).toContainText(
    "<img src=x onerror=alert(1)>_x0041_",
  );
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
  await mkdir(resolve("../../outputs/xlsx-next"), { recursive: true });
  await page.screenshot({
    path: resolve(
      `../../outputs/xlsx-next/xlsx-preview-${info.project.name}.png`,
    ),
  });
  await apply(page, dialog);
  expect((await records(page))[0].changes).toHaveLength(1);
  expect(manager.writes()).toEqual([]);
  await page.getByRole("button", { name: "Опубликовать", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("Черновик опубликован");
  expect(manager.writes()).toHaveLength(1);
  expect(manager.state().data.lessons.at(-1).type).toBe(
    "<img src=x onerror=alert(1)>_x0041_",
  );
  expect(manager.state().data.tasks).toEqual(before.data.tasks);
});

test("XLSX replacement reviews removals and preserves source metadata, existing order and other subgroups", async ({
  page,
}) => {
  const manager = await mockManager(page, {
    prepareData(d) {
      d.lessons[0].source = { sheet: "Kept", timeCell: "B2" };
      d.lessons[0].future = { retained: true };
    },
  });
  await manager.login();
  const before = manager.state(),
    dialog = await open(page);
  await dialog
    .getByRole("combobox", { name: "Режим импорта", exact: true })
    .selectOption("replace-scope");
  const row = xlsxRow(4, "Обновлено", "now-a");
  row[1] = "08:10";
  await load(dialog, await workbook([row]));
  await preview(dialog);
  await expect(dialog.locator("[data-xlsx-change=updated]")).toHaveCount(1);
  await expect(dialog.locator("[data-xlsx-change=removed]")).toHaveCount(1);
  await apply(page, dialog);
  const record = (await records(page))[0];
  expect(record.changes).toHaveLength(2);
  await page.getByRole("button", { name: "Опубликовать", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("Черновик опубликован");
  const after = manager.state().data;
  expect(after.lessons.map((l) => l.id)).toEqual(["now-a", "next", "later-b"]);
  expect(after.lessons[0]).toMatchObject({
    start: "08:10",
    source: { sheet: "Kept", timeCell: "B2" },
    future: { retained: true },
  });
  expect(after.lessons.slice(1)).toEqual(before.data.lessons.slice(1, 3));
  expect(after.tasks).toEqual(before.data.tasks);
});

test("export/download and reimport preserve IDs and create no draft for unchanged data", async ({
  page,
}) => {
  const manager = await mockManager(page);
  await manager.login();
  await page.locator('[data-page="schedule"]').click();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Экспорт XLSX", exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("uniflow-schedule.xlsx");
  const bytes = await readFile(await download.path());
  expect(bytes).toEqual(
    Buffer.from(
      exportScheduleXlsx(manager.state().data, {
        groupId: "g-main",
        subgroup: "А",
      }),
    ),
  );
  const dialog = await open(page);
  await dialog
    .getByRole("combobox", { name: "Режим импорта", exact: true })
    .selectOption("replace-scope");
  await load(dialog, bytes);
  await preview(dialog);
  await expect(
    dialog.getByText("Изменений нет. Черновик не изменён.", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Добавить в черновик", exact: true }),
  ).toBeDisabled();
  expect(await records(page)).toEqual([]);
  expect(manager.writes()).toEqual([]);
});

test("shared strings, rich text, literal leading apostrophes and numeric Excel times keep their meaning", async ({
  page,
}) => {
  const manager = await mockManager(page, {
    prepareData(d) {
      d.subjects[0].name = "'=literal";
      d.rooms[0].name = "001";
    },
  });
  await manager.login();
  const dialog = await open(page);
  const bytes = await workbook([xlsxRow()], (p) => {
    patchCell(p, "A2", '<c r="A2"><v>1</v></c>');
    patchCell(p, "B2", '<c r="B2"><v>0.375</v></c>');
    patchCell(p, "C2", '<c r="C2"><v>0.4097222222222222</v></c>');
    patchCell(p, "D2", '<c r="D2" t="s"><v>0</v></c>');
    patchCell(p, "E2", '<c r="E2" t="s"><v>1</v></c>');
    p["xl/sharedStrings.xml"] =
      '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><r><t>\'=</t></r><r><t>literal</t></r><rPh sb="0" eb="2"><t>IGNORE</t></rPh></si><si><t>001</t></si></sst>';
    p["xl/_rels/workbook.xml.rels"] = p["xl/_rels/workbook.xml.rels"].replace(
      "</Relationships>",
      '<Relationship Id="strings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
    );
  });
  await load(dialog, bytes);
  await preview(dialog);
  await expect(dialog.locator("[data-xlsx-change]")).toContainText(
    "09:00–09:50",
  );
  await expect(dialog.locator("[data-xlsx-change]")).toContainText("'=literal");
  await expect(dialog.locator("[data-xlsx-change]")).toContainText("001");
  await apply(page, dialog);
  expect((await records(page))[0].changes[0].after).toMatchObject({
    subjectId: "math",
    roomId: "204",
    start: "09:00",
    end: "09:50",
  });
});

test("multi-sheet selection, hidden sheet labels and mode/file changes cannot silently reuse a plan", async ({
  page,
}) => {
  const manager = await mockManager(page);
  await manager.login();
  const dialog = await open(page);
  const bytes = await workbook([xlsxRow()], (p) => {
    p["xl/workbook.xml"] = p["xl/workbook.xml"].replace(
      "</sheets>",
      '<sheet name="Другой" sheetId="2" r:id="second"/><sheet name="Скрытый" sheetId="3" state="hidden" r:id="hidden"/></sheets>',
    );
    p["xl/_rels/workbook.xml.rels"] = p["xl/_rels/workbook.xml.rels"].replace(
      "</Relationships>",
      '<Relationship Id="second" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="hidden" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/></Relationships>',
    );
    p["xl/worksheets/sheet2.xml"] = p[sheetPath].replace(
      "Импорт XLSX",
      "Второй лист",
    );
    p["xl/worksheets/sheet3.xml"] = p[sheetPath];
  });
  await load(dialog, bytes);
  await expect(dialog.locator('option[value="hidden"]')).toBeDisabled();
  await preview(dialog, "second");
  await expect(dialog.locator("[data-xlsx-change]")).toContainText(
    "Второй лист",
  );
  await dialog
    .getByRole("combobox", { name: "Лист XLSX", exact: true })
    .selectOption("sheet");
  await expect(dialog.locator("[data-xlsx-change]")).toHaveCount(0);
  await preview(dialog);
  await dialog
    .getByRole("combobox", { name: "Режим импорта", exact: true })
    .selectOption("replace-scope");
  await expect(
    dialog.getByRole("button", { name: "Добавить в черновик", exact: true }),
  ).toBeDisabled();
  await load(dialog, await workbook([xlsxRow(2)]));
  await expect(
    dialog.getByRole("combobox", { name: "Лист XLSX", exact: true }),
  ).toHaveValue("");
  expect(await records(page)).toEqual([]);
  expect(manager.writes()).toEqual([]);
});

test("invalid OOXML is rejected with a specific error before any draft is created", async ({
  page,
}) => {
  const manager = await mockManager(page);
  await manager.login();
  const cases = [
    [
      "formula",
      (p) => patchCell(p, "B2", '<c r="B2"><f>1/0</f><v>0.375</v></c>'),
      /формулы/,
    ],
    [
      "merge",
      (p) =>
        (p[sheetPath] = p[sheetPath].replace(
          "</worksheet>",
          '<mergeCells><mergeCell ref="A2:B2"/></mergeCells></worksheet>',
        )),
      /объединённые/,
    ],
    [
      "hidden",
      (p) =>
        (p[sheetPath] = p[sheetPath].replace(
          '<row r="2">',
          '<row r="2" hidden="1">',
        )),
      /скрытые/,
    ],
    [
      "entity",
      (p) =>
        (p[sheetPath] =
          '<!DOCTYPE worksheet [<!ENTITY x "attack">]>' + p[sheetPath]),
      /объявление XML/,
    ],
    [
      "broken XML",
      (p) => (p[sheetPath] = p[sheetPath].replace("</sheetData>", "")),
      /структура XML/,
    ],
    [
      "external",
      (p) =>
        (p["xl/_rels/workbook.xml.rels"] = p[
          "xl/_rels/workbook.xml.rels"
        ].replace(
          'Target="worksheets/sheet1.xml"',
          'Target="https://example.invalid/" TargetMode="External"',
        )),
      /внешние/,
    ],
    ["macro", (p) => (p["xl/vbaProject.bin"] = "untrusted"), /макросов/],
    [
      "bad shared string",
      (p) => patchCell(p, "D2", '<c r="D2" t="s"><v>999</v></c>'),
      /индекс/,
    ],
    [
      "duplicate cell",
      (p) =>
        (p[sheetPath] = p[sheetPath].replace(
          "</sheetData>",
          '<row r="3"><c r="A2"><v>1</v></c></row></sheetData>',
        )),
      /ячейка A2/,
    ],
    [
      "date serial",
      (p) => patchCell(p, "B2", '<c r="B2"><v>45000.375</v></c>'),
      /в пределах суток/,
    ],
    [
      "seconds",
      (p) => patchCell(p, "B2", '<c r="B2"><v>0.37501</v></c>'),
      /точностью до минуты/,
    ],
    [
      "numeric ID",
      (p) => patchCell(p, "K2", '<c r="K2"><v>123</v></c>'),
      /как текст/,
    ],
    [
      "bad style",
      (p) => patchCell(p, "E2", '<c r="E2" s="99"><v>1</v></c>'),
      /стиль/,
    ],
    [
      "oversized grid",
      (p) => (p[sheetPath] = p[sheetPath].replace('r="K2"', 'r="ZZ2"')),
      /64 столбцов/,
    ],
  ];
  for (const [name, change, expected] of cases) {
    const result = await parse(page, await workbook([xlsxRow()], change));
    expect(result.error, name).toMatch(expected);
  }
  expect(await records(page)).toEqual([]);
  expect(manager.writes()).toEqual([]);
});

test("errors identify physical Excel rows after blank rows; invalid containers and source grid do not create drafts", async ({
  page,
}) => {
  const manager = await mockManager(page);
  await manager.login();
  const dialog = await open(page);
  const bytes = await workbook([xlsxRow()], (p) => {
    p[sheetPath] = p[sheetPath]
      .replace(/r="([A-K]?)2"/g, 'r="$120"')
      .replace(
        '<t xml:space="preserve">math</t>',
        '<t xml:space="preserve">Unknown</t>',
      );
  });
  await load(dialog, bytes);
  await dialog
    .getByRole("combobox", { name: "Лист XLSX", exact: true })
    .selectOption("sheet");
  await dialog
    .getByRole("button", { name: "Предпросмотр XLSX", exact: true })
    .click();
  await expect(dialog.locator("#form-error")).toContainText("Строка 20");
  await expect(dialog.locator("#form-error")).toContainText("Расписание");
  for (const bad of [Buffer.from("not xlsx"), Buffer.alloc(1_000_001, 1)]) {
    await dialog.getByLabel("Файл XLSX", { exact: true }).setInputFiles({
      name: "bad.xlsx",
      mimeType: "application/octet-stream",
      buffer: bad,
    });
    await dialog
      .getByRole("button", { name: "Прочитать XLSX", exact: true })
      .click();
    await expect(dialog.locator("#form-error")).not.toBeEmpty();
    await expect(
      dialog.getByRole("button", { name: "Добавить в черновик", exact: true }),
    ).toBeDisabled();
  }
  expect(await records(page)).toEqual([]);
  expect(manager.writes()).toEqual([]);
});

test("new server revision invalidates the XLSX apply", async ({ page }) => {
  const manager = await mockManager(page);
  await manager.login();
  const dialog = await open(page);
  await load(dialog, await workbook([xlsxRow()]));
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
  expect(await records(page)).toEqual([]);
  expect(manager.writes()).toEqual([]);
});

test("closing during XLSX read discards the late result and keeps the next dialog", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = async function () {
      if (this.name === "held.xlsx") {
        window.qaXlsxReading = true;
        await new Promise((r) => (window.qaReleaseXlsx = r));
      }
      return original.call(this);
    };
  });
  const manager = await mockManager(page);
  await manager.login();
  const dialog = await open(page);
  await dialog.getByLabel("Файл XLSX", { exact: true }).setInputFiles({
    name: "held.xlsx",
    mimeType: "application/octet-stream",
    buffer: await workbook([xlsxRow()]),
  });
  await dialog
    .getByRole("button", { name: "Прочитать XLSX", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => !!window.qaXlsxReading))
    .toBe(true);
  await dialog
    .getByRole("button", { name: "Закрыть импорт", exact: true })
    .click();
  await page.locator('[data-action="profile"]').first().click();
  const title = await dialog.locator("h2").textContent();
  await page.evaluate(() => window.qaReleaseXlsx());
  await expect(dialog.locator("h2")).toHaveText(title);
  expect(await records(page)).toEqual([]);
  expect(manager.writes()).toEqual([]);
});

test("XLSX quota retry preserves the previous durable copy and never applies the file twice", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.IDBDatabase.prototype.transaction;
    window.IDBDatabase.prototype.transaction = function (names, mode, ...rest) {
      if (
        this.name === "uniflow-owner-drafts-v1" &&
        mode === "readwrite" &&
        localStorage.getItem("qa.xlsxQuota") === "1"
      )
        throw Error("quota fixture");
      return original.call(this, names, mode, ...rest);
    };
  });
  const manager = await mockManager(page);
  await manager.login();
  let dialog = await open(page);
  await load(dialog, await workbook([xlsxRow()]));
  await preview(dialog);
  await apply(page, dialog);
  const previous = (await records(page))[0];
  await page.evaluate(() => localStorage.setItem("qa.xlsxQuota", "1"));
  dialog = await open(page);
  await load(dialog, await workbook([xlsxRow(2)]));
  await preview(dialog);
  await dialog
    .getByRole("button", { name: "Добавить в черновик", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Повторить сохранение", exact: true }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole("combobox", { name: "Лист XLSX", exact: true }),
  ).toBeDisabled();
  expect((await records(page))[0]).toEqual(previous);
  expect(manager.writes()).toEqual([]);
  await page.evaluate(() => localStorage.removeItem("qa.xlsxQuota"));
  await dialog
    .getByRole("button", { name: "Повторить сохранение", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const changes = (await records(page))[0].changes;
  expect(changes).toHaveLength(2);
  expect(new Set(changes.map((c) => c.id)).size).toBe(2);
});

test("XLSX template download and forty-row review work in dark mode without overflow", async ({
  page,
}) => {
  const manager = await mockManager(page);
  await manager.login();
  await page.evaluate(() => document.body.classList.add("dark"));
  const dialog = await open(page),
    downloaded = page.waitForEvent("download");
  await dialog
    .getByRole("button", { name: "Скачать шаблон XLSX", exact: true })
    .click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("uniflow-template.xlsx");
  const parsed = await parse(page, await readFile(await download.path()));
  expect(parsed.lineNumbers).toEqual([1]);
  const rows = Array.from({ length: 42 }, (_, i) => {
    const clock = (n) =>
      `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
    const row = xlsxRow(2);
    row[1] = clock(i * 5);
    row[2] = clock(i * 5 + 4);
    row[4] = row[5] = "";
    return row;
  });
  await load(dialog, await workbook(rows));
  await preview(dialog);
  await expect(dialog.locator("[data-xlsx-change]")).toHaveCount(40);
  await dialog
    .getByRole("button", { name: "Следующие изменения", exact: true })
    .click();
  await expect(dialog.locator("[data-xlsx-change]")).toHaveCount(2);
  await audit(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
  ).toBe(false);
  expect(await records(page)).toEqual([]);
  expect(manager.writes()).toEqual([]);
});
