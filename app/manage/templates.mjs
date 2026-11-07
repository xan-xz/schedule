import { clone, uid, validate } from "../core.mjs";

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
  const result = clone(data);
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
        item.name.toLocaleLowerCase("ru") ===
          template.name.toLocaleLowerCase("ru"),
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
      (item) =>
        item.id !== id &&
        item.name.toLocaleLowerCase("ru") === nextName.toLocaleLowerCase("ru"),
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
