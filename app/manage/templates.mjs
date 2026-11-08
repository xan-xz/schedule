import { uid, validate } from "../core.mjs";
import { validDate } from "../lib/time.mjs";
import { prepareTransferDestination } from "./transfer-destination.mjs";

// Local conveniences, not authority: every application goes through the draft
// validator and publication still uses the existing authenticated server API.
const VERSION = 1;
const MAX_TEMPLATES = 20;
const MAX_LESSONS = 100;
const MAX_BYTES = 250_000;
const fields = [
  "day",
  "week",
  "start",
  "end",
  "subjectId",
  "teacherId",
  "roomId",
  "type",
  "subgroup",
  "endDayOffset",
  "validFrom",
  "validUntil",
];
const fail = (message) => {
  throw new Error(message);
};
const title = (value) => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80)
    fail("Название шаблона — от 1 до 80 символов.");
  return value.trim();
};
const text = (value, max = 160) =>
  typeof value === "string" && value.length <= max;
const validDay = (value) => Number.isInteger(value) && value >= 0 && value <= 6;
const isTime = (value) =>
  typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const pickLesson = (lesson) =>
  Object.fromEntries(
    fields
      .filter((key) => lesson[key] !== undefined)
      .map((key) => [key, lesson[key]]),
  );
function scope(data, options) {
  const group = data.groups.find((item) => item.id === options.groupId);
  if (!group) fail("Выбери существующую группу.");
  const subgroup = options.subgroup || "all";
  if (subgroup !== "all" && !group.subgroups.includes(subgroup))
    fail("Подгруппа не найдена.");
  return { group, subgroup };
}
export const TEMPLATE_STORAGE_KEY = "uf.schedule.templates.v1.live";
function cleanTemplate(input) {
  if (
    !input ||
    input.version !== VERSION ||
    !text(input.id, 100) ||
    !input.id ||
    !["day", "week"].includes(input.kind) ||
    !text(input.sourceGroupId, 100) ||
    !text(input.sourceGroupName, 100) ||
    !text(input.sourceSubgroup, 15) ||
    !input.sourceSubgroup ||
    !Array.isArray(input.lessons) ||
    !input.lessons.length ||
    input.lessons.length > MAX_LESSONS
  )
    fail("Шаблон повреждён или имеет неподдерживаемую версию.");
  const name = title(input.name);
  if (
    ![input.createdAt, input.updatedAt].every(
      (value) => text(value, 40) && Number.isFinite(Date.parse(value)),
    )
  )
    fail("Шаблон повреждён: неверная дата.");
  const lessons = input.lessons.map((lesson) => {
    if (
      !lesson ||
      !validDay(lesson.day) ||
      !["all", "odd", "even"].includes(lesson.week) ||
      !isTime(lesson.start) ||
      !isTime(lesson.end) ||
      !text(lesson.subjectId, 100) ||
      !lesson.subjectId ||
      !text(lesson.teacherId ?? "", 100) ||
      !text(lesson.roomId ?? "", 100) ||
      !text(lesson.type, 40) ||
      !lesson.type ||
      !text(lesson.subgroup, 15) ||
      !lesson.subgroup ||
      (lesson.endDayOffset !== undefined &&
        ![0, 1].includes(lesson.endDayOffset)) ||
      ["validFrom", "validUntil"].some(
        (key) =>
          lesson[key] !== undefined &&
          (!text(lesson[key], 10) || !/^\d{4}-\d{2}-\d{2}$/.test(lesson[key])),
      )
    )
      fail("Шаблон повреждён: проверь поля занятий.");
    return pickLesson(lesson);
  });
  if (
    input.kind === "day" &&
    new Set(lessons.map((lesson) => lesson.day)).size !== 1
  )
    fail("Шаблон дня содержит несколько дней.");
  if (
    input.sourceSubgroup !== "all" &&
    lessons.some((lesson) => lesson.subgroup !== input.sourceSubgroup)
  )
    fail("Шаблон повреждён: подгруппы не соответствуют области.");
  const refs = {};
  for (const collection of ["subjects", "teachers", "rooms"]) {
    const entries = input.refs?.[collection];
    if (
      !Array.isArray(entries) ||
      entries.length > MAX_LESSONS ||
      entries.some(
        (item) => !item || !text(item.id, 100) || !item.id || !text(item.name),
      )
    )
      fail("Шаблон повреждён: справочники недоступны.");
    refs[collection] = entries.map((item) => ({
      id: item.id,
      name: item.name,
    }));
  }
  return {
    version: VERSION,
    id: input.id,
    name,
    kind: input.kind,
    sourceGroupId: input.sourceGroupId,
    sourceGroupName: input.sourceGroupName,
    sourceSubgroup: input.sourceSubgroup,
    lessons,
    refs,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

export function createTemplate(data, options) {
  const { group, subgroup } = scope(data, options);
  if (
    !["day", "week"].includes(options.kind) ||
    (options.kind === "day" && !validDay(options.day))
  )
    fail("Выбери шаблон дня или недели.");
  const lessons = data.lessons
    .filter(
      (lesson) =>
        lesson.groupId === group.id &&
        (subgroup === "all" ||
          lesson.subgroup === "all" ||
          lesson.subgroup === subgroup) &&
        (options.kind === "week" || lesson.day === options.day),
    )
    .map((lesson) => ({
      ...pickLesson(lesson),
      subgroup: subgroup === "all" ? lesson.subgroup : subgroup,
    }));
  if (!lessons.length) fail("В выбранной области нет пар для шаблона.");
  if (lessons.length > MAX_LESSONS)
    fail("В шаблоне может быть не больше 100 занятий.");
  const refs = {};
  for (const [collection, field] of [
    ["subjects", "subjectId"],
    ["teachers", "teacherId"],
    ["rooms", "roomId"],
  ]) {
    const ids = new Set(lessons.map((lesson) => lesson[field]).filter(Boolean));
    refs[collection] = data[collection]
      .filter((item) => ids.has(item.id))
      .map((item) => ({ id: item.id, name: item.name }));
  }
  const now = new Date().toISOString();
  return cleanTemplate({
    version: VERSION,
    id: uid(),
    name: title(options.name),
    kind: options.kind,
    sourceGroupId: group.id,
    sourceGroupName: group.name,
    sourceSubgroup: subgroup,
    lessons,
    refs,
    createdAt: now,
    updatedAt: now,
  });
}

export function applyTemplate(data, input, options) {
  const template = cleanTemplate(input),
    { group, subgroup } = scope(data, options);
  if (template.kind === "day" && !validDay(options.toDay))
    fail("Выбери день назначения.");
  if (
    template.sourceSubgroup === "all" &&
    subgroup !== "all" &&
    template.lessons.some((lesson) => lesson.subgroup !== "all")
  )
    fail(
      "Шаблон обеих подгрупп применяй к области «обе», чтобы не менять получателей скрыто.",
    );
  for (const [collection, field] of [
    ["subjects", "subjectId"],
    ["teachers", "teacherId"],
    ["rooms", "roomId"],
  ]) {
    for (const lesson of template.lessons) {
      const id = lesson[field];
      if (id && !data[collection].some((item) => item.id === id)) {
        const label =
          template.refs[collection].find((item) => item.id === id)?.name || id;
        fail(
          `В текущем справочнике ${collection} нет «${label}». Исправь справочник или создай новый шаблон.`,
        );
      }
    }
  }
  const result = prepareTransferDestination(
    data,
    { groupId: group.id, subgroup, mode: options.mode },
    template.kind === "day" ? { day: options.toDay } : {},
  );
  result.lessons.push(
    ...template.lessons.map((lesson) => ({
      ...lesson,
      id: uid(),
      groupId: group.id,
      day: template.kind === "day" ? options.toDay : lesson.day,
      subgroup: subgroup === "all" ? lesson.subgroup : subgroup,
    })),
  );
  // No sourceConflictPairs/shared-session exceptions are copied. A template may
  // never turn an inherited source warning into permission for a new conflict.
  validate(result);
  return result;
}

export function loadTemplates(store = globalThis.localStorage, strict = false) {
  const key = TEMPLATE_STORAGE_KEY;
  try {
    const raw = store?.getItem(key);
    if (!raw) return [];
    if (new TextEncoder().encode(raw).length > MAX_BYTES) throw Error("size");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > MAX_TEMPLATES)
      throw Error("format");
    const found = parsed.map(cleanTemplate);
    if (new Set(found.map((item) => item.id)).size !== found.length)
      throw Error("ids");
    return found;
  } catch {
    if (strict)
      fail(
        "Хранилище шаблонов недоступно или повреждено. Старые данные не перезаписаны.",
      );
    return [];
  }
}
function persist(templates, store) {
  if (!store?.setItem)
    fail("Браузер запретил сохранение шаблонов на устройстве.");
  const json = JSON.stringify(templates);
  if (
    templates.length > MAX_TEMPLATES ||
    new TextEncoder().encode(json).length > MAX_BYTES
  )
    fail("Хранилище шаблонов заполнено. Удали лишние шаблоны (не больше 20). ");
  try {
    store.setItem(TEMPLATE_STORAGE_KEY, json);
  } catch {
    fail("Не удалось сохранить шаблоны. Проверь доступное место в браузере.");
  }
  return templates;
}
export function saveTemplate(input, store = globalThis.localStorage) {
  const template = cleanTemplate(input),
    templates = loadTemplates(store, true);
  if (
    templates.some(
      (item) =>
        item.id === template.id ||
        nameKey(item.name) === nameKey(template.name),
    )
  )
    fail(
      "Шаблон с таким названием уже есть. Выбери другое имя; существующий шаблон не заменён.",
    );
  return persist([...templates, template], store);
}
export function renameTemplate(id, name, store = globalThis.localStorage) {
  const templates = loadTemplates(store, true),
    nextName = title(name);
  if (!templates.some((item) => item.id === id))
    fail("Шаблон больше не найден.");
  if (
    templates.some(
      (item) => item.id !== id && nameKey(item.name) === nameKey(nextName),
    )
  )
    fail("Шаблон с таким названием уже есть.");
  return persist(
    templates.map((item) =>
      item.id === id
        ? { ...item, name: nextName, updatedAt: new Date().toISOString() }
        : item,
    ),
    store,
  );
}
export function deleteTemplate(id, store = globalThis.localStorage) {
  const templates = loadTemplates(store, true);
  if (!templates.some((item) => item.id === id))
    fail("Шаблон больше не найден.");
  return persist(
    templates.filter((item) => item.id !== id),
    store,
  );
}

export const TEMPLATE_BACKUP_BYTES = 300_000;
const BACKUP_FORMAT = "uniflow-template-library-v1";
const templateFields =
  "version id name kind sourceGroupId sourceGroupName sourceSubgroup lessons refs createdAt updatedAt".split(
    " ",
  );
const plain = (value) =>
  value && Object.getPrototypeOf(value) === Object.prototype;
const only = (value, allowed) =>
  plain(value) && Object.keys(value).every((key) => allowed.includes(key));
const secret =
  /\b(?:ow1[arc]\.[a-f0-9]{64}|sb_secret_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/u;
const nameKey = (value) =>
  value.normalize("NFKC").trim().toLocaleLowerCase("ru");
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    plain(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b, "en")),
        )
      : item,
  );
function backupTemplate(input, strict = false) {
  if (
    strict &&
    (!only(input, templateFields) ||
      !Array.isArray(input.lessons) ||
      input.lessons.some((row) => !only(row, fields)) ||
      !only(input.refs, ["subjects", "teachers", "rooms"]) ||
      Object.values(input.refs).some(
        (rows) =>
          !Array.isArray(rows) ||
          rows.some((row) => !only(row, ["id", "name"])),
      ))
  )
    fail(
      "Файл содержит неизвестные поля шаблона. Используйте копию библиотеки UniFlow.",
    );
  const clean = cleanTemplate(input);
  if (secret.test(JSON.stringify(clean)))
    fail(
      "В шаблоне обнаружены данные доступа. Удалите их из названий перед созданием копии.",
    );
  for (const row of clean.lessons) {
    const minutes = (time) =>
      Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    const duration =
      minutes(row.end) + (row.endDayOffset || 0) * 1440 - minutes(row.start);
    if (
      duration <= 0 ||
      duration > 1440 ||
      ["validFrom", "validUntil"].some(
        (key) => row[key] !== undefined && !validDate(row[key]),
      ) ||
      (row.validFrom && row.validUntil && row.validFrom > row.validUntil)
    )
      fail("Шаблон повреждён: неверный интервал или срок действия.");
  }
  for (const [collection, field] of [
    ["subjects", "subjectId"],
    ["teachers", "teacherId"],
    ["rooms", "roomId"],
  ]) {
    const refs = clean.refs[collection];
    if (
      new Set(refs.map((row) => row.id)).size !== refs.length ||
      clean.lessons.some(
        (row) => row[field] && !refs.some((ref) => ref.id === row[field]),
      )
    )
      fail("Шаблон повреждён: неоднозначные или неполные справочники.");
  }
  return clean;
}
const contentKey = (row) =>
  canonical({
    ...row,
    name: nameKey(row.name),
    id: null,
    createdAt: null,
    updatedAt: null,
    refs: Object.fromEntries(
      Object.entries(row.refs).map(([key, rows]) => [
        key,
        [...rows].sort((a, b) => a.id.localeCompare(b.id, "en")),
      ]),
    ),
  });
function library(store) {
  let raw;
  try {
    raw = store.getItem(TEMPLATE_STORAGE_KEY);
  } catch {
    fail("Хранилище шаблонов недоступно. Старые данные не перезаписаны.");
  }
  const templates = loadTemplates({ getItem: () => raw }, true).map((row) =>
    backupTemplate(row),
  );
  if (
    new Set(templates.map((row) => nameKey(row.name))).size !== templates.length
  )
    fail(
      "В библиотеке есть одинаковые названия. Переименуйте шаблоны перед импортом.",
    );
  return { raw, templates, originals: raw ? JSON.parse(raw) : [] };
}
export function exportTemplateBackup(store = globalThis.localStorage) {
  const { templates } = library(store);
  if (!templates.length) fail("Сначала сохраните хотя бы один шаблон.");
  return JSON.stringify({
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    templates,
  });
}
export function previewTemplateBackup(
  raw,
  data,
  store = globalThis.localStorage,
) {
  if (
    typeof raw !== "string" ||
    raw.length > TEMPLATE_BACKUP_BYTES ||
    new TextEncoder().encode(raw).length > TEMPLATE_BACKUP_BYTES
  )
    fail("Размер файла копии — не больше 300 КБ.");
  let input;
  try {
    input = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    fail("Не удалось прочитать JSON копии библиотеки.");
  }
  if (
    !only(input, ["format", "version", "exportedAt", "templates"]) ||
    input.format !== BACKUP_FORMAT ||
    input.version !== 1 ||
    !text(input.exportedAt, 40) ||
    !Number.isFinite(Date.parse(input.exportedAt)) ||
    !Array.isArray(input.templates) ||
    !input.templates.length ||
    input.templates.length > MAX_TEMPLATES
  )
    fail("Неверный формат копии библиотеки шаблонов.");
  const incoming = input.templates.map((row) => backupTemplate(row, true));
  if (
    new Set(incoming.map((row) => row.id)).size !== incoming.length ||
    new Set(incoming.map((row) => nameKey(row.name))).size !== incoming.length
  )
    fail("В файле повторяются ID или названия шаблонов.");
  const current = library(store);
  const rows = incoming.map((template) => {
    const found = current.templates.find(
      (row) => nameKey(row.name) === nameKey(template.name),
    );
    const status = !found
      ? "added"
      : contentKey(found) === contentKey(template)
        ? "skipped"
        : "conflict";
    const missing = [];
    for (const [collection, field, label] of [
      ["subjects", "subjectId", "Предмет"],
      ["teachers", "teacherId", "Преподаватель"],
      ["rooms", "roomId", "Аудитория"],
    ])
      for (const id of new Set(
        template.lessons.map((row) => row[field]).filter(Boolean),
      )) {
        if (!data[collection].some((row) => row.id === id))
          missing.push(
            `${label}: ${template.refs[collection].find((row) => row.id === id)?.name || id}`,
          );
      }
    return { template, status, missing };
  });
  const additions = rows
    .filter((row) => row.status === "added")
    .map((row) => row.template);
  const counts = Object.fromEntries(
    ["added", "skipped", "conflict"].map((status) => [
      status,
      rows.filter((row) => row.status === status).length,
    ]),
  );
  const size = new TextEncoder().encode(
    JSON.stringify([
      ...current.originals,
      ...additions.map((row) => ({ ...row, id: "0".repeat(36) })),
    ]),
  ).length;
  const capacity =
    current.templates.length + additions.length <= MAX_TEMPLATES &&
    size <= MAX_BYTES;
  return {
    raw,
    libraryBefore: current.raw,
    catalogBefore: canonical([data.subjects, data.teachers, data.rooms]),
    rows,
    counts,
    capacity,
    valid: capacity && !counts.conflict && !!counts.added,
  };
}
/** Called inside the shared library lock; one atomic localStorage write, never a schedule write. */
export function applyTemplateBackup(
  plan,
  data,
  store = globalThis.localStorage,
) {
  const fresh = previewTemplateBackup(plan.raw, data, store);
  if (
    fresh.libraryBefore !== plan.libraryBefore ||
    fresh.catalogBefore !== plan.catalogBefore
  )
    fail("Библиотека или справочники изменились. Повторите предпросмотр.");
  if (!fresh.valid)
    fail(
      "Импорт заблокирован. Проверьте названия и свободное место библиотеки.",
    );
  const current = library(store).originals;
  const additions = fresh.rows
    .filter((row) => row.status === "added")
    .map((row) => ({ ...row.template, id: uid() }));
  persist([...current, ...additions], store);
  return { added: additions.length, skipped: fresh.counts.skipped };
}
/** Every current owner UI writer cooperates; an older open tab must be refreshed. */
export async function withTemplateLock(
  action,
  locks = globalThis.navigator?.locks,
) {
  if (!locks?.request)
    fail(
      "Браузер не поддерживает безопасную запись шаблонов между вкладками. Используйте современный браузер; экспорт доступен.",
    );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    return await locks.request(
      "uniflow-template-library-v1",
      { mode: "exclusive", signal: controller.signal },
      action,
    );
  } catch (error) {
    if (error.name === "AbortError")
      fail("Другая вкладка занята шаблонами. Повторите действие.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
