import { clone, isGroupActive, uid, validate } from "../core.mjs";
import { prepareTransferDestination } from "./transfer-destination.mjs";

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
function resolve(
  data,
  collection,
  value,
  line,
  optional = false,
  literal = false,
) {
  const clean = literal
    ? value.trim()
    : value.trim().replace(/^'(?=[=+\-@\t\r])/, "");
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

function facultyGroupScopes(rows, headers, data, facultyId) {
  if (!data.faculties?.some((faculty) => faculty.id === facultyId))
    error("Факультет не найден.");
  const groupColumn = headers.indexOf("group"),
    subgroupColumn = headers.indexOf("subgroup");
  const created = new Set();
  const scopes = rows.map((cells, i) => {
    const label = cells[groupColumn]?.trim();
    if (!label || label.length > 80)
      error(
        "Строка " +
          (i + 2) +
          ": укажите название группы длиной до 80 символов.",
      );
    const aliases = data.groups.filter((group) =>
      [group.id, group.code, group.name].some(
        (value) => value && normalized(value) === normalized(label),
      ),
    );
    if (aliases.length > 1)
      error(
        "Строка " + (i + 2) + ": группа «" + label + "» найдена неоднозначно.",
      );
    let group = aliases[0];
    if (
      group &&
      (!isGroupActive(group) ||
        (group.facultyId && group.facultyId !== facultyId))
    )
      error(
        "Строка " +
          (i + 2) +
          ": группа «" +
          label +
          "» в архиве или относится к другому факультету.",
      );
    if (!group) {
      group = {
        id: uid(),
        name: label,
        code: label,
        facultyId,
        subgroups: [],
      };
      data.groups.push(group);
      created.add(group.id);
    }
    group.facultyId = facultyId;
    const subgroup = cells[subgroupColumn]?.trim();
    if (
      created.has(group.id) &&
      subgroup &&
      subgroup !== "all" &&
      !group.subgroups.includes(subgroup)
    )
      group.subgroups.push(subgroup);
    return { groupId: group.id, subgroup: "all", group };
  });
  for (const { group } of scopes)
    if (created.has(group.id) && !group.subgroups.length)
      group.subgroups = ["А", "Б"];
  return scopes;
}

function planScheduleCsv(text, data, options) {
  if (
    typeof text !== "string" ||
    new TextEncoder().encode(text).length > 2_000_000
  )
    error("CSV должен быть текстом размером до 2 МБ.");
  const facultyId = options.facultyId,
    scope = facultyId ? null : scopeFor(data, options),
    mode = options.mode || "append";
  if (!["append", "replace-scope"].includes(mode))
    error("Режим импорта: append или replace-scope.");
  if (facultyId && mode !== "replace-scope")
    error("Для файла факультета выберите замену расписания групп из файла.");
  const rows = csvRows(text);
  if (rows.length < 2)
    error("CSV должен содержать заголовки и хотя бы одну пару.");
  const headers = rows.shift().map(normalized);
  if (rows.length > (options.maxRows || 5000))
    error(`В CSV допускается до ${options.maxRows || 5000} занятий.`);
  if (new Set(headers).size !== headers.length)
    error("Повторяются заголовки CSV.");
  const supported = new Set(columns.map(normalized));
  if (facultyId) supported.add("group");
  const unknown = headers.filter((header) => !supported.has(header));
  if (unknown.length) error(`Неизвестные столбцы CSV: ${unknown.join(", ")}.`);
  for (const required of [
    ...(facultyId ? ["group"] : []),
    "day",
    "start",
    "end",
    "subject",
  ])
    if (!headers.includes(required))
      error(`В CSV отсутствует столбец ${required}.`);
  const result = clone(data),
    facultyScopes = facultyId
      ? facultyGroupScopes(rows, headers, result, facultyId)
      : null,
    affectedGroups = new Set(facultyScopes?.map((item) => item.groupId)),
    affected = (lesson) =>
      facultyId ? affectedGroups.has(lesson.groupId) : inScope(lesson, scope),
    originals = new Map(),
    used = new Set();
  for (const lesson of data.lessons.filter(affected)) {
    const group = originals.get(lesson.groupId) || [];
    group.push(lesson);
    originals.set(lesson.groupId, group);
  }
  const imported = rows.map((cells, i) => {
    if (cells.length !== headers.length)
      error(`Строка ${i + 2}: число значений не совпадает с заголовками.`);
    const row = Object.fromEntries(
      headers.map((key, j) => [key, cells[j].trim()]),
    );
    const currentScope = facultyScopes?.[i] || scope;
    const existing = originals.get(currentScope.groupId) || [];
    if (!/^[0-6]$/.test(row.day))
      error(`Строка ${i + 2}: day должен быть от 0 (Пн) до 6 (Вс).`);
    const subgroup = row.subgroup || currentScope.subgroup;
    if (subgroup !== "all" && !currentScope.group.subgroups.includes(subgroup))
      error(`Строка ${i + 2}: подгруппа не найдена.`);
    if (currentScope.subgroup !== "all" && subgroup !== currentScope.subgroup)
      error("Для импорта общих пар или другой подгруппы выбери «обе».");
    const values = {
      groupId: currentScope.groupId,
      subgroup,
      day: Number(row.day),
      start: row.start,
      end: row.end,
      subjectId: resolve(
        data,
        "subjects",
        row.subject,
        i + 2,
        false,
        options.literalReferences,
      ),
      roomId: resolve(
        data,
        "rooms",
        row.room || "",
        i + 2,
        true,
        options.literalReferences,
      ),
      teacherId: resolve(
        data,
        "teachers",
        row.teacher || "",
        i + 2,
        true,
        options.literalReferences,
      ),
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
      previous = existing.find((lesson) => lesson.id === row.id);
      if (!previous)
        error(`Строка ${i + 2}: ID не относится к выбранной области.`);
      if (mode !== "replace-scope")
        error(
          "CSV содержит существующие ID. Для обновления выбери замену выбранной области.",
        );
    } else if (mode === "replace-scope")
      previous = existing.find(
        (lesson) =>
          !used.has(lesson.id) && lessonKey(lesson) === lessonKey(values),
      );
    const id = previous?.id || uid();
    if (used.has(id)) error(`Строка ${i + 2}: ID повторяется.`);
    used.add(id);
    // Carry provenance and all unknown source metadata through exact-ID replacements.
    return { ...previous, ...values, id };
  });
  const replacements = new Map(imported.map((row) => [row.id, row])),
    originalIds = new Set(data.lessons.map((row) => row.id));
  // Existing IDs retain their positions, regardless of CSV row order. This also
  // makes the reviewed result identical to recovery from the local delta journal.
  result.lessons = [
    ...result.lessons.flatMap((lesson) => {
      if (mode === "append" || !affected(lesson)) return [lesson];
      return replacements.has(lesson.id) ? [replacements.get(lesson.id)] : [];
    }),
    ...imported.filter((lesson) => !originalIds.has(lesson.id)),
  ];
  // No orphan removal: existing overrides/tasks/attendance/requests must still validate.
  validate(result);
  return { data: result, affected, affectedGroups };
}

/** Return a complete cloned model; mode = append | replace-scope. */
export function parseScheduleCsv(text, data, options = {}) {
  return planScheduleCsv(text, data, options).data;
}

/** A read-only review; exact-ID replacement retains source metadata. */
export function previewScheduleCsv(text, data, options = {}) {
  if (
    typeof text !== "string" ||
    new TextEncoder().encode(text).byteLength > 1_000_000
  )
    error("Размер CSV не должен превышать 1 МБ.");
  const {
    data: result,
    affected,
    affectedGroups,
  } = planScheduleCsv(text, data, {
    ...options,
    maxRows: 1000,
  });
  const before = new Map(data.lessons.map((lesson) => [lesson.id, lesson]));
  const after = new Map(result.lessons.map((lesson) => [lesson.id, lesson]));
  const changes = [];
  let unchanged = 0;
  for (const lesson of result.lessons.filter(affected)) {
    const original = before.get(lesson.id);
    if (!original) changes.push({ kind: "added", before: null, after: lesson });
    else if (lessonKey(original) !== lessonKey(lesson))
      changes.push({ kind: "updated", before: original, after: lesson });
    else unchanged++;
  }
  for (const lesson of data.lessons.filter(affected))
    if (!after.has(lesson.id))
      changes.push({ kind: "removed", before: lesson, after: null });
  return {
    data: result,
    changes,
    ...(options.facultyId
      ? {
          groupChanges: result.groups
            .filter((group) => affectedGroups.has(group.id))
            .flatMap((group) => {
              const previous = data.groups.find((item) => item.id === group.id);
              return previous?.facultyId === group.facultyId
                ? []
                : [{ name: group.name, created: !previous }];
            }),
        }
      : {}),
    counts: {
      added: changes.filter((row) => row.kind === "added").length,
      updated: changes.filter((row) => row.kind === "updated").length,
      removed: changes.filter((row) => row.kind === "removed").length,
      unchanged,
    },
  };
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
  const result = prepareTransferDestination(
    data,
    { ...scope, mode: options.mode },
    { day: toDay },
  );
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
  const result = prepareTransferDestination(
    data,
    { ...scope, mode: options.mode },
    { week: toWeek },
  );
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
