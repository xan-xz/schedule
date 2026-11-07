import { clone, uid, validate } from "../core.mjs";

// These helpers produce local drafts only. They never perform network writes.
// CSV defaults to append. Destructive scope replacement must be explicitly requested.
const columns = [
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
const normalized = (value) =>
  String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("ru");
const error = (message) => {
  throw new Error(message);
};
function scopeFor(data, { groupId, subgroup = "all" } = {}) {
  const group = data.groups.find((g) => g.id === groupId);
  if (!group) error("Выбери существующую группу.");
  if (subgroup !== "all" && !group.subgroups.includes(subgroup))
    error("Подгруппа не найдена.");
  return { groupId, subgroup, group };
}
const inScope = (lesson, scope) =>
  lesson.groupId === scope.groupId &&
  (scope.subgroup === "all" || lesson.subgroup === scope.subgroup);
const visibleInScope = (lesson, scope) =>
  lesson.groupId === scope.groupId &&
  (scope.subgroup === "all" ||
    lesson.subgroup === "all" ||
    lesson.subgroup === scope.subgroup);
function delimiterOf(text) {
  let quoted = false,
    comma = 0,
    semicolon = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
    }
    if (!quoted && (c === "\r" || c === "\n")) break;
    if (!quoted && c === ",") comma++;
    if (!quoted && c === ";") semicolon++;
  }
  return semicolon > comma ? ";" : ",";
}
function csvRows(input) {
  const text = input.replace(/^\uFEFF/, ""),
    delimiter = delimiterOf(text);
  const rows = [];
  let row = [],
    field = "",
    quoted = false,
    closed = false;
  const endField = () => {
    row.push(field);
    field = "";
    closed = false;
  };
  const endRow = () => {
    endField();
    if (row.some((value) => value.trim())) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
    } else if (c === '"') {
      if (field || closed) error("Некорректные кавычки CSV.");
      quoted = true;
    } else if (c === delimiter) endField();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else if (closed && !/\s/.test(c))
      error("После закрывающей кавычки ожидается разделитель CSV.");
    else if (!closed) field += c;
  }
  if (quoted) error("В CSV не закрыта кавычка.");
  if (field || row.length) endRow();
  return rows;
}
function resolve(data, collection, value, line, optional = false) {
  const clean = value.trim().replace(/^'(?=[=+\-@\t\r])/, "");
  if (!clean && optional) return "";
  const matches = data[collection].filter(
    (item) => item.id === clean || normalized(item.name) === normalized(clean),
  );
  if (matches.length !== 1)
    error(
      `Строка ${line}: ${matches.length ? "неоднозначное" : "неизвестное"} значение «${clean}» в справочнике ${collection}.`,
    );
  return matches[0].id;
}
const lessonKey = (lesson) =>
  JSON.stringify(
    [
      "day",
      "start",
      "end",
      "subjectId",
      "roomId",
      "teacherId",
      "type",
      "subgroup",
      "week",
      "endDayOffset",
    ].map((k) => lesson[k] ?? (k === "endDayOffset" ? 0 : "")),
  );

/** Return a complete cloned model; mode = append | replace-scope. */
export function parseScheduleCsv(text, data, options = {}) {
  if (
    typeof text !== "string" ||
    new TextEncoder().encode(text).length > 2_000_000
  )
    error("CSV должен быть текстом размером до 2 МБ.");
  const scope = scopeFor(data, options),
    mode = options.mode || "append";
  if (!["append", "replace-scope"].includes(mode))
    error("Режим импорта: append или replace-scope.");
  const rows = csvRows(text);
  if (rows.length < 2)
    error("CSV должен содержать заголовки и хотя бы одну пару.");
  const headers = rows.shift().map(normalized);
  if (new Set(headers).size !== headers.length)
    error("Повторяются заголовки CSV.");
  for (const required of ["day", "start", "end", "subject"])
    if (!headers.includes(required))
      error(`В CSV отсутствует столбец ${required}.`);
  const originals = data.lessons.filter((lesson) => inScope(lesson, scope)),
    used = new Set();
  const imported = rows.map((cells, i) => {
    if (cells.length !== headers.length)
      error(`Строка ${i + 2}: число значений не совпадает с заголовками.`);
    const row = Object.fromEntries(
      headers.map((key, j) => [key, cells[j].trim()]),
    );
    if (!/^[0-6]$/.test(row.day))
      error(`Строка ${i + 2}: day должен быть от 0 (Пн) до 6 (Вс).`);
    const subgroup = row.subgroup || scope.subgroup;
    if (subgroup !== "all" && !scope.group.subgroups.includes(subgroup))
      error(`Строка ${i + 2}: подгруппа не найдена.`);
    if (scope.subgroup !== "all" && subgroup !== scope.subgroup)
      error("Для импорта общих пар или другой подгруппы выбери «обе».");
    const values = {
      groupId: scope.groupId,
      subgroup,
      day: Number(row.day),
      start: row.start,
      end: row.end,
      subjectId: resolve(data, "subjects", row.subject, i + 2),
      roomId: resolve(data, "rooms", row.room || "", i + 2, true),
      teacherId: resolve(data, "teachers", row.teacher || "", i + 2, true),
      type: row.type || "Пара",
      week: row.week || "all",
    };
    if (row.enddayoffset) {
      if (!/^[01]$/.test(row.enddayoffset))
        error(`Строка ${i + 2}: endDayOffset — 0 или 1.`);
      values.endDayOffset = Number(row.enddayoffset);
    }
    let previous = null;
    if (row.id) {
      previous = originals.find((lesson) => lesson.id === row.id);
      if (!previous)
        error(`Строка ${i + 2}: ID не относится к выбранной области.`);
      if (mode !== "replace-scope")
        error(
          "CSV содержит существующие ID. Для обновления выбери замену выбранной области.",
        );
    } else if (mode === "replace-scope")
      previous = originals.find(
        (lesson) =>
          !used.has(lesson.id) && lessonKey(lesson) === lessonKey(values),
      );
    const id = previous?.id || uid();
    if (used.has(id)) error(`Строка ${i + 2}: ID повторяется.`);
    used.add(id);
    // Carry provenance and all unknown source metadata through exact-ID replacements.
    return { ...previous, ...values, id };
  });
  const result = clone(data);
  result.lessons = [
    ...result.lessons.filter(
      (lesson) => mode === "append" || !inScope(lesson, scope),
    ),
    ...imported,
  ];
  // No orphan removal: existing overrides/tasks/attendance/requests must still validate.
  validate(result);
  return result;
}
function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text; // Prevent spreadsheet formula execution.
  return /[",;\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}
export function exportScheduleCsv(data, options = {}) {
  const scope = scopeFor(data, options);
  const name = (collection, id) =>
    data[collection].find((item) => item.id === id)?.name || "";
  const rows = data.lessons
    .filter((lesson) => inScope(lesson, scope))
    .sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));
  return (
    "\uFEFF" +
    [
      columns.join(","),
      ...rows.map((lesson) =>
        [
          lesson.day,
          lesson.start,
          lesson.end,
          name("subjects", lesson.subjectId),
          name("rooms", lesson.roomId),
          name("teachers", lesson.teacherId),
          lesson.type,
          lesson.subgroup,
          lesson.week,
          lesson.endDayOffset || 0,
          lesson.id,
        ]
          .map(csvCell)
          .join(","),
      ),
    ].join("\r\n")
  );
}
export function copyDay(data, options = {}) {
  const scope = scopeFor(data, options),
    { fromDay, toDay } = options;
  if (
    ![fromDay, toDay].every(
      (day) => Number.isInteger(day) && day >= 0 && day <= 6,
    ) ||
    fromDay === toDay
  )
    error("Выбери разные дни от 0 (Пн) до 6 (Вс).");
  // Copy common sessions into one subgroup as a separate scoped lesson; other groups stay untouched.
  const source = data.lessons.filter(
    (lesson) => visibleInScope(lesson, scope) && lesson.day === fromDay,
  );
  if (!source.length) error("В исходном дне нет пар.");
  const result = clone(data);
  result.lessons.push(
    ...source.map((lesson) => ({
      ...clone(lesson),
      id: uid(),
      day: toDay,
      subgroup: scope.subgroup === "all" ? lesson.subgroup : scope.subgroup,
      sharedSessionId: "",
    })),
  );
  validate(result);
  return result;
}
export function copyWeek(data, options = {}) {
  const scope = scopeFor(data, options),
    { fromWeek, toWeek } = options;
  if (
    !["odd", "even"].includes(fromWeek) ||
    !["odd", "even"].includes(toWeek) ||
    fromWeek === toWeek
  )
    error("Выбери разные типы недели: odd / even.");
  const source = data.lessons.filter(
    (lesson) => visibleInScope(lesson, scope) && lesson.week === fromWeek,
  );
  if (!source.length)
    error(
      "Нет пар только для выбранного типа недели. Общие пары уже действуют в обеих неделях.",
    );
  const result = clone(data);
  result.lessons.push(
    ...source.map((lesson) => ({
      ...clone(lesson),
      id: uid(),
      week: toWeek,
      subgroup: scope.subgroup === "all" ? lesson.subgroup : scope.subgroup,
      sharedSessionId: "",
    })),
  );
  validate(result);
  return result;
}
