import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readScheduleWorkbook, scheduleWorkbook } from "../app/manage/xlsx.mjs";
import { previewScheduleCsv } from "../app/manage/tools.mjs";
import { workbook, xlsxRow } from "./xlsx-fixtures.mjs";
import { fixture } from "./e2e/fixtures.mjs";

const path = "xl/worksheets/sheet1.xml";
const cell = (p, ref, xml) =>
  (p[path] = p[path].replace(new RegExp(`<c r="${ref}"[^>]*>.*?</c>`), xml));
const read = async (bytes) => {
  const book = await readScheduleWorkbook(bytes);
  return book.readSheet(book.sheets[0].id);
};
test("XLSX round trip is literal, handles Excel escape sequences and keeps leading zero IDs", async () => {
  const rows = [xlsxRow(1, "'=literal_x000D_\r\n<text>&", "00123")];
  const parsed = await read(scheduleWorkbook(rows));
  assert.match(parsed.text, /'=literal_x000D_/);
  assert.match(parsed.text, /00123/);
  assert.deepEqual(parsed.lineNumbers, [1, 2]);
});
test("XLSX uses the common preview validator and preserves literal catalog names", async () => {
  const data = structuredClone(fixture);
  data.subjects[0].name = "'=literal";
  const row = xlsxRow();
  row[3] = "'=literal";
  const parsed = await read(await workbook([row]));
  const result = previewScheduleCsv(parsed.text, data, {
    groupId: "g-main",
    subgroup: "А",
    literalReferences: true,
  });
  assert.equal(result.changes[0].after.subjectId, "math");
  assert.equal(data.lessons.length, 3);
});
for (const [name, edit, message] of [
  [
    "date type",
    (p) => cell(p, "B2", '<c r="B2" t="d"><v>2026-11-08</v></c>'),
    /даты/,
  ],
  [
    "boolean type",
    (p) => cell(p, "D2", '<c r="D2" t="b"><v>1</v></c>'),
    /логические/,
  ],
  [
    "cell error",
    (p) => cell(p, "D2", '<c r="D2" t="e"><v>#REF!</v></c>'),
    /ошибки/,
  ],
  [
    "negative time",
    (p) => cell(p, "B2", '<c r="B2"><v>-0.1</v></c>'),
    /в пределах суток/,
  ],
  [
    "24 hour time",
    (p) => cell(p, "B2", '<c r="B2"><v>1</v></c>'),
    /в пределах суток/,
  ],
  ["invalid number", (p) => cell(p, "B2", '<c r="B2"><v>NaN</v></c>'), /число/],
  [
    "duplicate row",
    (p) => (p[path] = p[path].replace('r="2"', 'r="1"')),
    /уникальные/,
  ],
  [
    "row overflow",
    (p) => (p[path] = p[path].replace('r="2"', 'r="10001"')),
    /10000/,
  ],
  [
    "header starts late",
    (p) =>
      (p[path] = p[path]
        .replace(/r="([A-K]?)1"/g, 'r="$13"')
        .replace(/r="([A-K]?)2"/g, 'r="$14"')),
    /строке 1/,
  ],
  [
    "undeclared namespace",
    (p) => (p[path] = p[path].replace("<sheetData>", "<bad:sheetData>")),
    /структура XML/,
  ],
  [
    "duplicate attribute",
    (p) => (p[path] = p[path].replace('<row r="2">', '<row r="2" r="2">')),
    /структура XML/,
  ],
  [
    "invalid entity",
    (p) => (p[path] = p[path].replace("Импорт XLSX", "&unknown;")),
    /структура XML/,
  ],
  [
    "wrong namespace",
    (p) =>
      (p[path] = p[path].replace(
        "spreadsheetml/2006/main",
        "spreadsheetml/wrong",
      )),
    /структура XML/,
  ],
  [
    "UTF-16 declaration",
    (p) => (p[path] = '<?xml version="1.0" encoding="UTF-16"?>' + p[path]),
    /объявление XML/,
  ],
  [
    "no visible sheets",
    (p) =>
      (p["xl/workbook.xml"] = p["xl/workbook.xml"].replace(
        'sheetId="1"',
        'sheetId="1" state="hidden"',
      )),
    /видимый лист/,
  ],
  [
    "path traversal",
    (p) =>
      (p["xl/_rels/workbook.xml.rels"] = p[
        "xl/_rels/workbook.xml.rels"
      ].replace("worksheets/sheet1.xml", "../../escape.xml")),
    /за пределы/,
  ],
  [
    "macro content type",
    (p) =>
      (p["[Content_Types].xml"] = p["[Content_Types].xml"].replace(
        "spreadsheetml.sheet.main+xml",
        "macroEnabled.main+xml",
      )),
    /макросы/,
  ],
])
  test(`XLSX refuses ${name}`, async () =>
    assert.rejects(read(await workbook([xlsxRow()], edit)), message));

function style(p, code, numFmtId) {
  p["xl/styles.xml"] =
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts><numFmt numFmtId="${numFmtId}" formatCode="${code}"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="${numFmtId}"/></cellXfs></styleSheet>`;
  p["xl/_rels/workbook.xml.rels"] = p["xl/_rels/workbook.xml.rels"].replace(
    "</Relationships>",
    '<Relationship Id="style" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
  );
}
test("XLSX accepts custom minute time styles, including numeric Excel values", async () => {
  const result = await read(
    await workbook([xlsxRow()], (p) => {
      style(p, "hh:mm", 164);
      cell(p, "B2", '<c r="B2" s="1"><v>0.375</v></c>');
    }),
  );
  assert.match(result.text, /09:00/);
});
test("XLSX refuses formatted numeric references instead of losing displayed leading zeros", async () => {
  await assert.rejects(
    read(
      await workbook([xlsxRow()], (p) => {
        style(p, "000", 164);
        cell(p, "E2", '<c r="E2" s="1"><v>1</v></c>');
      }),
    ),
    /как текст/,
  );
});
test("XLSX refuses numeric dates even when their serial is less than one", async () => {
  await assert.rejects(
    read(
      await workbook([xlsxRow()], (p) => {
        style(p, "mm-dd-yy", 14);
        cell(p, "B2", '<c r="B2" s="1"><v>0.375</v></c>');
      }),
    ),
    /без даты/,
  );
});
test("XLSX refuses minute-only and literal time formats that conceal the hour", async () => {
  for (const [code, format] of [
    ["mm:ss", 45],
    ["mm:ss.0", 47],
    ["mm:ss", 164],
    ["&quot;h&quot;", 164],
  ]) {
    await assert.rejects(
      read(
        await workbook([xlsxRow()], (p) => {
          style(p, code, format);
          cell(p, "B2", '<c r="B2" s="1"><v>0.375</v></c>');
        }),
      ),
      /HH:MM/,
    );
  }
});
test("XLSX decodes Excel escapes per rich text fragment without joining a new escape sequence", async () => {
  const result = await read(
    await workbook([xlsxRow()], (p) =>
      cell(
        p,
        "G2",
        '<c r="G2" t="inlineStr"><is><r><t>_x00</t></r><r><t>41_</t></r><r><t>_x0042_</t></r></is></c>',
      ),
    ),
  );
  assert.match(result.text, /_x0041_B/);
});
test("XLSX respects row number formats and explicit cell overrides", async () => {
  const make = (code, cellXml) =>
    workbook([xlsxRow()], (p) => {
      style(p, code, 164);
      p[path] = p[path].replace(
        '<row r="2">',
        '<row r="2" s="1" customFormat="1">',
      );
      cell(p, code === "000" ? "E2" : "B2", cellXml);
    });
  await assert.rejects(
    read(await make("000", '<c r="E2"><v>1</v></c>')),
    /как текст/,
  );
  const explicit = await read(
    await make("000", '<c r="E2" s="0"><v>1</v></c>'),
  );
  assert.match(explicit.text, /"math","1","teacher"/);
  const time = await read(await make("hh:mm", '<c r="B2"><v>0.375</v></c>'));
  assert.match(time.text, /"09:00"/);
});
test("XLSX refuses conditional formatting that can override visible numeric meaning", async () => {
  await assert.rejects(
    read(
      await workbook(
        [xlsxRow()],
        (p) =>
          (p[path] = p[path].replace(
            "</worksheet>",
            '<conditionalFormatting sqref="E2"><cfRule type="expression" dxfId="1" priority="1"><formula>TRUE</formula></cfRule></conditionalFormatting></worksheet>',
          )),
      ),
    ),
    /условное форматирование/,
  );
});
test("XLSX rejects escaped controls and unpaired Unicode instead of silently replacing them", async () => {
  for (const value of ["_x0000_", "_xD800_"])
    await assert.rejects(
      read(
        await workbook([xlsxRow()], (p) =>
          cell(p, "G2", `<c r="G2" t="inlineStr"><is><t>${value}</t></is></c>`),
        ),
      ),
      /управляющие символы|Unicode/,
    );
  assert.throws(
    () => scheduleWorkbook([[String.fromCharCode(0xd800)]]),
    /управляющий символ/,
  );
});
test("XLSX caps data rows before common validation and ignores forged dimension allocations", async () => {
  const result = await read(
    await workbook(
      [xlsxRow()],
      (p) =>
        (p[path] = p[path].replace(
          "<sheetData>",
          '<dimension ref="A1:XFD1048576"/><sheetData>',
        )),
    ),
  );
  assert.deepEqual(result.lineNumbers, [1, 2]);
  const bytes = await workbook([xlsxRow()], (p) => {
    const row = /<row r="2">.*?<\/row>/.exec(p[path])[0];
    p[path] = p[path].replace(
      "</sheetData>",
      Array.from({ length: 1000 }, (_, i) =>
        row.replace(/r="([A-K]?)2"/g, (_, c) => `r="${c}${i + 3}"`),
      ).join("") + "</sheetData>",
    );
  });
  await assert.rejects(read(bytes), /1000 занятий/);
});
test("original merged source workbook is preserved and rejected as a tabular import", async () => {
  const bytes = await readFile(
    new URL("../2 курс КСиПО БАК 1 сем.xlsx", import.meta.url),
  );
  const book = await readScheduleWorkbook(bytes);
  assert.equal(book.sheets.length, 8);
  await assert.rejects(book.readSheet(book.sheets[0].id), /объединённые/);
});
