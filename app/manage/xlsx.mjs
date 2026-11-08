import { readZip, storeZip } from "./xlsx-zip.mjs";
import { DOMParser } from "../admin/vendor/xmldom-0.9.12.mjs";

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const DOC =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const TYPES = "http://schemas.openxmlformats.org/package/2006/content-types";
export const XLSX_COLUMNS = [
  "day",
  "start",
  "end",
  "subject",
  "room",
  "teacher",
  "type",
  "subgroup",
  "week",
  "endDayOffset",
  "id",
];
const fail = (message) => {
  throw Error(`XLSX: ${message}`);
};
const elements = (node) =>
  Array.from(node.childNodes).filter((c) => c.nodeType === 1);
const children = (node, name) =>
  elements(node).filter(
    (c) => c.localName === name && c.namespaceURI === node.namespaceURI,
  );
const first = (node, name) => children(node, name)[0];
const attr = (node, name) => node.getAttribute(name);
function xml(bytes, name, namespace, root) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(`${name}: требуется XML в UTF-8.`);
  }
  if (
    /<!DOCTYPE|<!ENTITY/i.test(text) ||
    /encoding\s*=\s*["'](?!utf-8["'])/i.test(text)
  )
    fail(`${name}: неподдерживаемое объявление XML.`);
  let document;
  try {
    document = new DOMParser({
      onError: () => {
        throw Error("Invalid XML");
      },
    }).parseFromString(text, "application/xml");
  } catch {
    fail(`${name}: некорректная структура XML.`);
  }
  if (
    !document?.documentElement ||
    document.getElementsByTagName("parsererror").length ||
    document.documentElement.localName !== root ||
    document.documentElement.namespaceURI !== namespace
  )
    fail(`${name}: некорректная структура XML.`);
  return document.documentElement;
}
function target(base, value) {
  if (
    !value ||
    /[\\:%?#]/.test(value) ||
    [...value].some((c) => c.charCodeAt(0) <= 32)
  )
    fail("недопустимая ссылка на часть книги.");
  const parts = value.startsWith("/") ? [] : base.split("/").slice(0, -1);
  for (const part of value.replace(/^\//, "").split("/")) {
    if (part === "..") {
      if (!parts.length) fail("ссылка выходит за пределы книги.");
      parts.pop();
    } else if (!part || part === ".") fail("неканоническая ссылка в книге.");
    else parts.push(part);
  }
  return parts.join("/");
}
function relationships(root, base) {
  const found = new Map();
  for (const row of children(root, "Relationship")) {
    const id = attr(row, "Id"),
      type = attr(row, "Type");
    if (!id || found.has(id) || attr(row, "TargetMode"))
      fail("внешние ссылки и повторные отношения не поддерживаются.");
    found.set(id, { type, path: target(base, attr(row, "Target")) });
  }
  return found;
}
const excelText = (text) =>
  text.replace(/_x([0-9a-f]{4})_/gi, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
function richText(node) {
  if (!node) return "";
  return elements(node)
    .map((c) =>
      c.namespaceURI !== NS
        ? ""
        : c.localName === "t"
          ? excelText(c.textContent)
          : c.localName === "r"
            ? children(c, "t")
                .map((t) => excelText(t.textContent))
                .join("")
            : "",
    )
    .join("");
}
const integer = (value, max) =>
  /^\d+$/.test(value || "") &&
  Number.isSafeInteger(Number(value)) &&
  Number(value) <= max;

/** Read one explicitly selected tabular sheet. Nothing is uploaded or executed. */
export async function readScheduleWorkbook(input) {
  const zip = readZip(input);
  if (
    zip.names.some(
      (name) =>
        /(?:vba|externalLinks|embeddings|activeX)/i.test(name) ||
        (!name.endsWith("/") && !/\.(?:xml|rels)$/.test(name)),
    )
  )
    fail(
      "допускается обычная табличная книга .xlsx без макросов, вложений и внешних ссылок.",
    );
  const part = async (name, ns, root) =>
    xml(await zip.read(name), name, ns, root);
  const types = await part("[Content_Types].xml", TYPES, "Types");
  if (
    elements(types).some((c) =>
      /macroEnabled|vba|activeX|oleObject/i.test(attr(c, "ContentType") || ""),
    )
  )
    fail("макросы и активное содержимое не поддерживаются.");
  const allRelations = new Map();
  for (const name of zip.names.filter((n) => n.endsWith(".rels"))) {
    const base =
      name === "_rels/.rels"
        ? ""
        : name
            .replace(/(?:^|\/)_rels\//, "/")
            .replace(/\.rels$/, "")
            .replace(/^\//, "");
    allRelations.set(
      name,
      relationships(await part(name, REL, "Relationships"), base),
    );
  }
  const rootRelations = allRelations.get("_rels/.rels");
  const books = [...(rootRelations?.values() || [])].filter(
    (r) => r.type === `${DOC}/officeDocument`,
  );
  if (books.length !== 1 || books[0].path !== "xl/workbook.xml")
    fail("ожидается обычная книга Excel с xl/workbook.xml.");
  const book = await part("xl/workbook.xml", NS, "workbook");
  const relations = allRelations.get("xl/_rels/workbook.xml.rels");
  if (!relations) fail("отсутствуют связи листов книги.");
  const sheets = children(first(book, "sheets") || book, "sheet").map(
    (sheet) => {
      const id = sheet.getAttributeNS(DOC, "id"),
        relation = relations.get(id),
        state = attr(sheet, "state") || "visible";
      if (
        !relation ||
        relation.type !== `${DOC}/worksheet` ||
        !zip.names.includes(relation.path) ||
        !["visible", "hidden", "veryHidden"].includes(state)
      )
        fail("некорректная связь листа.");
      return { id, name: attr(sheet, "name"), state, path: relation.path };
    },
  );
  if (
    !sheets.length ||
    sheets.length > 64 ||
    new Set(sheets.map((s) => s.id)).size !== sheets.length ||
    new Set(sheets.map((s) => s.name)).size !== sheets.length ||
    sheets.some((s) => !s.name || s.name.length > 100)
  )
    fail("некорректный список листов.");
  let strings = [],
    formats = [0];
  const shared = [...relations.values()].filter(
    (r) => r.type === `${DOC}/sharedStrings`,
  );
  const styles = [...relations.values()].filter(
    (r) => r.type === `${DOC}/styles`,
  );
  if (shared.length > 1 || styles.length > 1)
    fail("повторяются таблицы строк или стилей.");
  if (shared.length) {
    strings = children(await part(shared[0].path, NS, "sst"), "si").map(
      richText,
    );
    if (strings.length > 20000) fail("слишком много общих строк.");
  }
  const customFormats = new Map();
  if (styles.length) {
    const style = await part(styles[0].path, NS, "styleSheet");
    formats = children(first(style, "cellXfs") || style, "xf").map((s) =>
      Number(attr(s, "numFmtId") || 0),
    );
    for (const row of children(first(style, "numFmts") || style, "numFmt"))
      customFormats.set(
        Number(attr(row, "numFmtId")),
        attr(row, "formatCode") || "",
      );
  }
  return {
    sheets: sheets.map(({ id, name, state }) => ({ id, name, state })),
    async readSheet(id) {
      const sheet = sheets.find((s) => s.id === id);
      if (!sheet || sheet.state !== "visible") fail("выберите видимый лист.");
      const root = await part(sheet.path, NS, "worksheet");
      if (root.getElementsByTagNameNS(NS, "conditionalFormatting").length)
        fail(
          "условное форматирование может скрывать числовые значения. Удалите его перед импортом и явно задайте текст или HH:MM.",
        );
      if (root.getElementsByTagNameNS(NS, "mergeCell").length)
        fail(
          "объединённые ячейки не поддерживаются. Используйте табличный экспорт, одна строка — одно занятие.",
        );
      if (
        [
          ...root.getElementsByTagNameNS(NS, "row"),
          ...root.getElementsByTagNameNS(NS, "col"),
        ].some((r) => ["1", "true"].includes(attr(r, "hidden")))
      )
        fail(
          "лист содержит скрытые строки или столбцы. Покажите их перед импортом.",
        );
      if (root.getElementsByTagNameNS(NS, "f").length)
        fail(
          "лист содержит формулы. Замените их явными значениями перед импортом.",
        );
      const sheetData = first(root, "sheetData");
      if (!sheetData) fail("отсутствует таблица ячеек.");
      const rows = [],
        lineNumbers = [],
        used = new Set();
      let lastRow = 0,
        cellCount = 0,
        headers;
      for (const row of children(sheetData, "row")) {
        const number = attr(row, "r");
        if (!integer(number, 10000) || Number(number) <= lastRow)
          fail("строки должны иметь уникальные возрастающие номера до 10000.");
        lastRow = Number(number);
        const cells = [];
        for (const cell of children(row, "c")) {
          const ref = attr(cell, "r") || "",
            match = /^([A-Z]{1,2})([1-9]\d*)$/.exec(ref);
          if (
            !match ||
            Number(match[2]) !== lastRow ||
            used.has(ref) ||
            ++cellCount > 20000
          )
            fail(`недопустимая или повторная ячейка ${ref}.`);
          used.add(ref);
          const column =
            [...match[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) -
            1;
          if (column >= 64) fail(`ячейка ${ref}: допускается до 64 столбцов.`);
          const type = attr(cell, "t") || "n",
            value = first(cell, "v")?.textContent || "";
          let text;
          if (type === "inlineStr") text = richText(first(cell, "is"));
          else if (type === "s") {
            if (!integer(value, strings.length - 1))
              fail(`ячейка ${ref}: неверный индекс общей строки.`);
            text = strings[Number(value)];
          } else if (type === "str") text = excelText(value);
          else if (type === "n" && value !== "") {
            const n = Number(value),
              header = headers?.[column]?.normalize("NFKC").toLowerCase(),
              style =
                attr(cell, "s") ||
                (["1", "true"].includes(attr(row, "customFormat"))
                  ? attr(row, "s")
                  : "") ||
                "0";
            if (
              !integer(style, formats.length - 1) ||
              !Number.isFinite(n) ||
              !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)
            )
              fail(`ячейка ${ref}: некорректное число или стиль.`);
            const format = formats[Number(style)];
            if (["start", "end"].includes(header)) {
              const code = customFormats.get(format) || "";
              if (
                ![0, 18, 19, 20, 21, 46].includes(format) &&
                !(
                  format >= 164 &&
                  /^(?:h{1,2}|\[h\]):m{1,2}(?::s{1,2})?(?:\s*AM\/PM)?(?:;@)?$/i.test(
                    code.replaceAll("\\:", ":"),
                  )
                )
              )
                fail(
                  `ячейка ${ref}: требуется время без даты в формате HH:MM.`,
                );
              const minutes = Math.round(n * 1440);
              if (
                n < 0 ||
                n >= 1 ||
                Math.abs(n * 1440 - minutes) > 0.00001 ||
                minutes >= 1440
              )
                fail(
                  `ячейка ${ref}: время должно быть в пределах суток с точностью до минуты.`,
                );
              text = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
            } else {
              if (
                header === "id" ||
                ![0, 1].includes(format) ||
                !Number.isSafeInteger(n)
              )
                fail(
                  `ячейка ${ref}: сохраните ID и форматированные значения как текст, чтобы не потерять ведущие нули.`,
                );
              text = String(n);
            }
          } else if (type === "n" && value === "") text = "";
          else
            fail(
              `ячейка ${ref}: ошибки, логические значения и даты не поддерживаются; используйте текст или целое число.`,
            );
          if (text.length > 4000)
            fail(`ячейка ${ref}: слишком длинное значение.`);
          if (
            !text.isWellFormed() ||
            [...text].some(
              (c) =>
                c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0)),
            )
          )
            fail(
              `ячейка ${ref}: недопустимые управляющие символы или неполный Unicode.`,
            );
          cells[column] = text;
        }
        if (!cells.some((c) => c?.trim())) continue;
        if (!headers) {
          if (lastRow !== 1) fail("заголовки должны находиться в строке 1.");
          headers = Array.from({ length: cells.length }, (_, i) =>
            (cells[i] || "").trim(),
          );
        } else if (cells.length > headers.length)
          fail(`строка ${lastRow}: значения выходят за столбцы заголовков.`);
        rows.push(
          Array.from({ length: headers.length }, (_, i) => cells[i] || ""),
        );
        lineNumbers.push(lastRow);
        if (rows.length > 1001)
          fail("допускается до 1000 занятий на выбранном листе.");
      }
      return {
        text: rows
          .map((r) => r.map((v) => `"${v.replaceAll('"', '""')}"`).join(","))
          .join("\r\n"),
        lineNumbers,
        sheet: sheet.name,
      };
    },
  };
}

const escape = (value) => {
  const text = String(value ?? "");
  if (
    !text.isWellFormed() ||
    [...text].some(
      (c) => c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0)),
    )
  )
    fail("в экспорте обнаружен недопустимый управляющий символ.");
  return text
    .replace(/_x[0-9a-f]{4}_/gi, (v) => "_x005F_" + v.slice(1))
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("\r", "&#13;");
};
export function referenceRows(data) {
  return ["subjects", "rooms", "teachers"].flatMap((kind) =>
    data[kind].map((r) => [kind, r.id, r.name]),
  );
}
export function scheduleWorkbook(rows, references = []) {
  if (
    rows.length > 1000 ||
    rows.some(
      (r) =>
        r.length > XLSX_COLUMNS.length ||
        r.some((v) => String(v ?? "").length > 4000),
    )
  )
    fail(
      "экспорт допускает до 1000 занятий и до 4000 символов в ячейке. Выберите меньшую область.",
    );
  const renderRows = (allRows) =>
    allRows
      .map(
        (row, i) =>
          `<row r="${i + 1}">${row.map((v, j) => `<c r="${String.fromCharCode(65 + j)}${i + 1}" t="inlineStr"><is><t xml:space="preserve">${escape(v)}</t></is></c>`).join("")}</row>`,
      )
      .join("");
  const bytes = storeZip({
    "[Content_Types].xml": `<Types xmlns="${TYPES}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>${references.length ? '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' : ""}</Types>`,
    "_rels/.rels": `<Relationships xmlns="${REL}"><Relationship Id="book" Type="${DOC}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<workbook xmlns="${NS}" xmlns:r="${DOC}"><bookViews><workbookView/></bookViews><sheets><sheet name="Расписание" sheetId="1" r:id="sheet"/>${references.length ? '<sheet name="Справочники" sheetId="2" r:id="references"/>' : ""}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="${REL}"><Relationship Id="sheet" Type="${DOC}/worksheet" Target="worksheets/sheet1.xml"/>${references.length ? `<Relationship Id="references" Type="${DOC}/worksheet" Target="worksheets/sheet2.xml"/>` : ""}</Relationships>`,
    "xl/worksheets/sheet1.xml": `<worksheet xmlns="${NS}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${[6, 12, 12, 24, 18, 24, 24, 12, 12, 16, 40].map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`).join("")}</cols><sheetData>${renderRows([XLSX_COLUMNS, ...rows])}</sheetData></worksheet>`,
    ...(references.length
      ? {
          "xl/worksheets/sheet2.xml": `<worksheet xmlns="${NS}"><cols><col min="1" max="2" width="26" customWidth="1"/><col min="3" max="3" width="48" customWidth="1"/></cols><sheetData>${renderRows([["kind", "id", "name"], ...references])}</sheetData></worksheet>`,
        }
      : {}),
  });
  if (bytes.length > 1_000_000)
    fail("экспорт превышает 1 МБ. Выберите меньшую область.");
  return bytes;
}
export function exportScheduleXlsx(data, { groupId, subgroup = "all" }) {
  const group = data.groups.find((g) => g.id === groupId);
  if (!group || (subgroup !== "all" && !group.subgroups.includes(subgroup)))
    fail("выберите существующую группу и подгруппу.");
  return scheduleWorkbook(
    data.lessons
      .filter(
        (l) =>
          l.groupId === groupId &&
          (subgroup === "all" || l.subgroup === subgroup),
      )
      .sort((a, b) => a.day - b.day || a.start.localeCompare(b.start))
      .map((l) => [
        l.day,
        l.start,
        l.end,
        l.subjectId,
        l.roomId,
        l.teacherId,
        l.type,
        l.subgroup,
        l.week,
        l.endDayOffset || 0,
        l.id,
      ]),
    referenceRows(data),
  );
}
