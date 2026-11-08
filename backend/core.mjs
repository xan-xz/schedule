import { validateAppearancePolicy } from "./appearance-policy.mjs";
import { isGroupActive } from "./group-state.mjs";
export { isGroupActive } from "./group-state.mjs";
export const DAYS = [
  "Понедельник",
  "Вторник",
  "Среда",
  "Четверг",
  "Пятница",
  "Суббота",
  "Воскресенье",
];
export const SHORT = ["ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ", "ВС"];
export const ROLES = {
  guest: "Посетитель",
  student: "Студент",
  teacher: "Преподаватель",
  admin: "Администратор",
};
export const uid = () => globalThis.crypto.randomUUID();
export const clone = (x) => JSON.parse(JSON.stringify(x));
export const time = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
export function fail(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  throw e;
}
export function localDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Almaty",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
export function addDays(date, n) {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function dayOf(date) {
  return (new Date(date + "T12:00:00Z").getUTCDay() + 6) % 7;
}
export function monday(date) {
  return addDays(date, -dayOf(date));
}
export function isoWeek(date) {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + 3 - dayOf(date));
  const first = new Date(Date.UTC(d.getUTCFullYear(), 0, 4, 12));
  return 1 + Math.round((d - first) / 86400000 / 7);
}
export function weeksOverlap(a, b) {
  return a === "all" || b === "all" || a === b;
}
export function groupsOverlap(a, b) {
  return (
    a.groupId === b.groupId &&
    (a.subgroup === "all" || b.subgroup === "all" || a.subgroup === b.subgroup)
  );
}
export const lessonFingerprint = (l) =>
  JSON.stringify([
    l.id,
    l.day,
    l.week,
    l.start,
    l.end,
    l.groupId,
    l.subgroup,
    l.subjectId,
    l.teacherId || "",
    l.roomId || "",
    ...(l.endDayOffset || l.validFrom || l.validUntil
      ? [l.endDayOffset || 0, l.validFrom || "", l.validUntil || ""]
      : []),
  ]);
export const conflictPairKey = (a, b) =>
  [lessonFingerprint(a), lessonFingerprint(b)].sort().join("|");
export function sourceConflictAllowed(data, a, b) {
  return (
    (data.sourceConflictPairs || []).includes(conflictPairKey(a, b)) &&
    [a, b].every(
      (l) =>
        !l.exception?.targetDate || l.exception.targetDate === l.exception.date,
    )
  );
}
export function sharedSession(a, b) {
  return (
    a.groupId !== b.groupId &&
    !!a.sharedSessionId &&
    a.sharedSessionId === b.sharedSessionId &&
    [
      "day",
      "week",
      "start",
      "end",
      "subjectId",
      "teacherId",
      "roomId",
      "type",
    ].every((k) => a[k] === b[k])
  );
}
function interval(l) {
  const base = l.date ? Date.parse(l.date + "T00:00:00Z") / 60000 : 0;
  return [
    base + time(l.start),
    base + time(l.end) + (l.endDayOffset || 0) * 1440,
  ];
}
export function collision(a, b) {
  const [as, ae] = interval(a),
    [bs, be] = interval(b);
  if (as >= be || bs >= ae || sharedSession(a, b)) return "";
  if (groupsOverlap(a, b)) return "Группа уже занята";
  if (a.teacherId && a.teacherId === b.teacherId)
    return "Преподаватель уже занят";
  if (a.roomId && a.roomId === b.roomId) return "Аудитория уже занята";
  return "";
}
function scheduledOn(l, date) {
  return (
    l.day === dayOf(date) &&
    (l.week === "all" || l.week === (isoWeek(date) % 2 ? "odd" : "even")) &&
    (!l.validFrom || date >= l.validFrom) &&
    (!l.validUntil || date <= l.validUntil)
  );
}
export function occurrences(data, date, { activeOnly = false } = {}) {
  const result = [];
  if (
    (data.validFrom && date < data.validFrom) ||
    (data.validUntil && date > data.validUntil)
  )
    return result;
  for (const l of data.lessons) {
    if (
      activeOnly &&
      !isGroupActive(data.groups?.find((g) => g.id === l.groupId))
    )
      continue;
    const ex = data.exceptions.find(
      (e) => e.lessonId === l.id && e.date === date,
    );
    if (
      scheduledOn(l, date) &&
      !data.holidays?.some(
        (h) =>
          date >= h.start &&
          date <= h.end &&
          (!h.groupId || h.groupId === l.groupId),
      )
    ) {
      if (!ex) result.push({ ...l, date });
      else if (!ex.targetDate || ex.targetDate === date)
        result.push({
          ...l,
          ...(ex.status === "moved" ? overrideFields(ex) : {}),
          date,
          cancelled: ex.status === "cancelled",
          exception: ex,
        });
    }
    for (const moved of data.exceptions.filter(
      (e) =>
        e.lessonId === l.id &&
        e.status === "moved" &&
        e.targetDate === date &&
        e.date !== date,
    ))
      result.push({ ...l, ...overrideFields(moved), date, exception: moved });
  }
  return result.sort((a, b) => a.start.localeCompare(b.start));
}
function overrideFields(ex) {
  return Object.fromEntries(
    ["start", "end", "roomId", "subjectId", "teacherId", "endDayOffset", "type"]
      .filter((k) => ex[k] !== undefined)
      .map((k) => [k, ex[k]]),
  );
}
function validInterval(l) {
  return (
    timeValid(l.start) &&
    timeValid(l.end) &&
    [undefined, 0, 1].includes(l.endDayOffset) &&
    time(l.end) + (l.endDayOffset || 0) * 1440 > time(l.start) &&
    time(l.end) + (l.endDayOffset || 0) * 1440 - time(l.start) <= 1440
  );
}
function text(v, label, max = 160) {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    fail("Проверь поле «" + label + "»");
  return v.trim();
}
function dateValid(d) {
  return (
    typeof d === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(d) &&
    !Number.isNaN(Date.parse(d + "T12:00:00Z")) &&
    new Date(d + "T12:00:00Z").toISOString().slice(0, 10) === d
  );
}
function timeValid(t) {
  return typeof t === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
}
export function validate(data) {
  if (Object.hasOwn(data, "siteSettings")) {
    if (
      !data.siteSettings ||
      typeof data.siteSettings !== "object" ||
      Array.isArray(data.siteSettings)
    )
      fail("Неверный формат настроек сайта");
    if (Object.hasOwn(data.siteSettings, "appearance")) {
      try {
        validateAppearancePolicy(data.siteSettings.appearance);
      } catch (error) {
        fail(error.message);
      }
    }
  }
  for (const k of [
    "groups",
    "teachers",
    "subjects",
    "rooms",
    "lessons",
    "exceptions",
    "tasks",
    "announcements",
    "requests",
    "attendance",
    "history",
  ])
    if (!Array.isArray(data[k]) || data[k].length > 3000)
      fail("Неверный формат раздела " + k);
  for (const k of [
    "groups",
    "teachers",
    "subjects",
    "rooms",
    "lessons",
    "tasks",
    "announcements",
    "requests",
  ]) {
    const ids = new Set();
    for (const e of data[k]) {
      text(e.id, "ID", 100);
      if (ids.has(e.id)) fail("Повторяется идентификатор " + k);
      ids.add(e.id);
    }
  }
  const has = (k, id) => data[k].some((e) => e.id === id);
  for (const entity of CATALOG_ENTITIES)
    for (const item of data[entity]) validateCatalogItem(entity, item);
  for (const t of data.teachers)
    if (t.subjects.some((s) => !has("subjects", s)))
      fail("Предмет преподавателя не найден");
  // Optional reference fields have the same meaning on every operational row,
  // including cancelled overrides and rejected requests. Historical snapshots
  // remain immutable and are checked by catalogImpact before destructive edits.
  for (const collection of REFERENCE_COLLECTIONS)
    for (const row of data[collection] || [])
      for (const entity of CATALOG_ENTITIES) {
        const [single, multiple] = REFERENCE_FIELDS[entity];
        if (
          entity === "groups" &&
          row.groupId &&
          row.subgroup !== undefined &&
          row.subgroup !== "all" &&
          !data.groups
            .find((group) => group.id === row.groupId)
            ?.subgroups.includes(row.subgroup)
        )
          fail("Подгруппа связанной записи не найдена: " + collection);
        if (row[single] && !has(entity, row[single]))
          fail("Ссылка справочника не найдена: " + collection);
        if (
          row[multiple] !== undefined &&
          (!Array.isArray(row[multiple]) ||
            row[multiple].some((id) => !has(entity, id)))
        )
          fail("Ссылки справочника не найдены: " + collection);
      }
  for (const l of data.lessons) {
    if (
      !has("groups", l.groupId) ||
      !has("subjects", l.subjectId) ||
      (l.teacherId && !has("teachers", l.teacherId)) ||
      (l.roomId && !has("rooms", l.roomId))
    )
      fail("Проверь группу, предмет, преподавателя и аудиторию");
    if (
      l.subgroup !== "all" &&
      !data.groups
        .find((g) => g.id === l.groupId)
        .subgroups.includes(l.subgroup)
    )
      fail("Подгруппа не найдена");
    if (
      !Number.isInteger(l.day) ||
      l.day < 0 ||
      l.day > 6 ||
      !["all", "odd", "even"].includes(l.week) ||
      !validInterval(l) ||
      (l.validFrom && !dateValid(l.validFrom)) ||
      (l.validUntil && !dateValid(l.validUntil)) ||
      (l.validFrom && l.validUntil && l.validFrom > l.validUntil)
    )
      fail("Проверь день и время занятия");
    if (
      l.teacherId &&
      !data.teachers
        .find((t) => t.id === l.teacherId)
        .subjects.includes(l.subjectId)
    )
      fail("Преподавателю не назначен этот предмет");
    text(l.type || "Пара", "Тип занятия", 40);
  }
  const allowedSourcePairs = new Set(data.sourceConflictPairs || []);
  const activeLessons = data.lessons.filter((l) =>
    isGroupActive(data.groups.find((g) => g.id === l.groupId)),
  );
  for (let i = 0; i < activeLessons.length; i++)
    for (let j = i + 1; j < activeLessons.length; j++) {
      const a = activeLessons[i],
        b = activeLessons[j];
      if (a.day === b.day && weeksOverlap(a.week, b.week)) {
        const error = collision(a, b);
        if (error && !allowedSourcePairs.has(conflictPairKey(a, b)))
          fail(error + " · " + DAYS[a.day] + " " + a.start);
      }
    }
  // Check the following calendar day too. On Sunday ISO parity flips at midnight.
  for (const a of activeLessons.filter((l) => l.endDayOffset === 1))
    for (const b of activeLessons) {
      if (b.day !== (a.day + 1) % 7) continue;
      const parityOverlap =
        a.week === "all" ||
        b.week === "all" ||
        (a.day === 6 ? a.week !== b.week : a.week === b.week);
      if (
        !parityOverlap ||
        (a.validUntil &&
          b.validFrom &&
          addDays(a.validUntil, 1) < b.validFrom) ||
        (b.validUntil && a.validFrom && b.validUntil < a.validFrom)
      )
        continue;
      const error = collision(
        { ...a, date: "2026-01-05" },
        { ...b, date: "2026-01-06" },
      );
      if (error) fail(error + " · после полуночи");
    }
  const exKeys = new Set();
  if (
    (data.validFrom !== undefined && !dateValid(data.validFrom)) ||
    (data.validUntil !== undefined && !dateValid(data.validUntil)) ||
    (data.validFrom && data.validUntil && data.validFrom > data.validUntil)
  )
    fail("Проверь границы семестра");
  if (
    data.holidays !== undefined &&
    (!Array.isArray(data.holidays) || data.holidays.length > 3000)
  )
    fail("Проверь каникулы");
  for (const h of data.holidays || [])
    if (
      !dateValid(h.start) ||
      !dateValid(h.end) ||
      h.start > h.end ||
      (h.groupId && !has("groups", h.groupId))
    )
      fail("Проверь каникулы");
  for (const ex of data.exceptions) {
    if (
      !has("lessons", ex.lessonId) ||
      !dateValid(ex.date) ||
      !["moved", "cancelled"].includes(ex.status)
    )
      fail("Проверь исключение по дате");
    const l = data.lessons.find((l) => l.id === ex.lessonId);
    if (
      dayOf(ex.date) !== l.day ||
      !(l.week === "all" || l.week === (isoWeek(ex.date) % 2 ? "odd" : "even"))
    )
      fail("В выбранную дату этой пары нет");
    const key = ex.lessonId + ex.date;
    if (exKeys.has(key)) fail("На эту дату уже есть изменение");
    exKeys.add(key);
    if (
      ex.note !== undefined &&
      (typeof ex.note !== "string" || ex.note.length > 1000)
    )
      fail("Комментарий до 1000 символов");
    if (ex.type !== undefined) text(ex.type, "Тип занятия", 40);
    if (ex.targetDate && !dateValid(ex.targetDate))
      fail("Проверь дату переноса");
    if (
      ex.status === "moved" &&
      (!validInterval({ ...l, ...overrideFields(ex) }) ||
        (ex.roomId && !has("rooms", ex.roomId)) ||
        (ex.subjectId && !has("subjects", ex.subjectId)) ||
        (ex.teacherId && !has("teachers", ex.teacherId)))
    )
      fail("Проверь время и справочники переноса");
  }
  for (const d of new Set(
    data.exceptions
      .flatMap((e) => [e.date, e.targetDate || e.date])
      .flatMap((d) => [addDays(d, -1), d, addDays(d, 1)]),
  )) {
    const ls = [
      ...occurrences(data, addDays(d, -1), { activeOnly: true }),
      ...occurrences(data, d, { activeOnly: true }),
    ].filter((l) => !l.cancelled);
    for (let i = 0; i < ls.length; i++)
      for (let j = i + 1; j < ls.length; j++) {
        const error = collision(ls[i], ls[j]);
        if (error && !sourceConflictAllowed(data, ls[i], ls[j]))
          fail(error + " · " + d);
      }
  }
  for (const t of data.tasks) {
    text(t.title, "Задание");
    if (
      typeof t.description !== "string" ||
      t.description.length > 4000 ||
      !has("groups", t.groupId) ||
      !has("subjects", t.subjectId) ||
      !dateValid(t.due) ||
      (t.teacherId && !has("teachers", t.teacherId))
    )
      fail("Проверь задание");
    if (
      ![
        "all",
        ...data.groups.find((g) => g.id === t.groupId).subgroups,
      ].includes(t.subgroup)
    )
      fail("Подгруппа задания не найдена");
  }
  for (const a of data.attendance)
    if (
      !has("lessons", a.lessonId) ||
      !dateValid(a.date) ||
      typeof a.studentId !== "string" ||
      !["present", "absent", "late", "excused"].includes(a.status)
    )
      fail("Посещаемость ссылается на отсутствующую пару");
  for (const r of data.requests)
    if (
      !has("lessons", r.lessonId) ||
      !dateValid(r.date) ||
      !["pending", "approved", "rejected"].includes(r.status)
    )
      fail("Запрос ссылается на отсутствующую пару");
  for (const n of data.announcements) {
    text(n.title, "Заголовок");
    text(n.body, "Сообщение", 4000);
    if (
      !Array.isArray(n.roles) ||
      n.roles.some((r) => !["student", "teacher", "admin"].includes(r)) ||
      (n.groupId && !has("groups", n.groupId)) ||
      (n.teacherId && !has("teachers", n.teacherId))
    )
      fail("Проверь получателей объявления");
  }
  return true;
}
const CATALOG_ENTITIES = ["groups", "teachers", "subjects", "rooms"];
const CATALOG_FIELDS = {
  groups: ["name", "code", "specialty", "language", "subgroups"],
  teachers: ["name", "subjects"],
  subjects: ["name", "shortName", "color"],
  rooms: ["name", "capacity", "capacityEstimated", "building", "floor", "note"],
};
const REFERENCE_COLLECTIONS = [
  "lessons",
  "exceptions",
  "tasks",
  "announcements",
  "requests",
  "attendance",
  "holidays",
  "teachers",
];
const REFERENCE_FIELDS = {
  groups: ["groupId", "groupIds"],
  teachers: ["teacherId", "teacherIds"],
  subjects: ["subjectId", "subjectIds"],
  rooms: ["roomId", "roomIds"],
};
function catalogDefaults(entity) {
  return entity === "groups"
    ? { subgroups: ["А", "Б"], code: "" }
    : entity === "teachers"
      ? { subjects: [] }
      : entity === "rooms"
        ? { capacity: 30 }
        : {};
}
function optionalText(item, key, max) {
  if (
    item[key] !== undefined &&
    (typeof item[key] !== "string" || item[key].length > max)
  )
    fail("Проверь поле «" + key + "»");
}
function validateCatalogItem(entity, item, { authored = false } = {}) {
  text(item.id, "ID", 100);
  text(
    item.name,
    "Название",
    entity === "groups" ? 80 : entity === "rooms" ? 60 : 160,
  );
  if (entity === "groups") {
    optionalText(item, "code", 80);
    optionalText(item, "specialty", 160);
    if (
      item.language !== undefined &&
      !["", "ru", "kk", "en"].includes(item.language)
    )
      fail("Проверь язык группы");
    if (
      !Array.isArray(item.subgroups) ||
      !item.subgroups.length ||
      item.subgroups.length > 16 ||
      (authored &&
        (new Set(
          item.subgroups.map((value) =>
            typeof value === "string" ? value.trim() : value,
          ),
        ).size !== item.subgroups.length ||
          item.subgroups.some(
            (value) => typeof value === "string" && value !== value.trim(),
          ))) ||
      item.subgroups.some(
        (s) =>
          typeof s !== "string" || !s.trim() || s.length > 15 || s === "all",
      )
    )
      fail("Проверь подгруппы");
    if (
      Object.hasOwn(item, "archivedAt") &&
      item.archivedAt !== null &&
      (typeof item.archivedAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T/.test(item.archivedAt) ||
        !Number.isFinite(Date.parse(item.archivedAt)))
    )
      fail("Проверь дату архива");
  } else if (entity === "teachers") {
    if (
      !Array.isArray(item.subjects) ||
      item.subjects.some((id) => typeof id !== "string") ||
      new Set(item.subjects).size !== item.subjects.length
    )
      fail("Проверь предметы преподавателя");
  } else if (entity === "subjects") {
    optionalText(item, "shortName", 60);
    if (
      item.color !== undefined &&
      (typeof item.color !== "string" || !/^#[0-9a-f]{6}$/i.test(item.color))
    )
      fail("Проверь цвет предмета");
  } else {
    if (
      !Number.isInteger(item.capacity) ||
      item.capacity < 1 ||
      item.capacity > 500
    )
      fail("Вместимость от 1 до 500");
    if (
      item.capacityEstimated !== undefined &&
      typeof item.capacityEstimated !== "boolean"
    )
      fail("Проверь оценку вместимости");
    optionalText(item, "building", 120);
    optionalText(item, "floor", 40);
    optionalText(item, "note", 1000);
  }
}
function validateChangedGroupAliases(original, data) {
  for (const group of data.groups) {
    const old = original.groups.find((row) => row.id === group.id);
    if (
      !old ||
      JSON.stringify(old.subgroups) !== JSON.stringify(group.subgroups)
    )
      validateCatalogItem("groups", group, { authored: true });
    for (const field of ["id", "name", "code"]) {
      const value = group[field];
      if (!value || (old && old[field] === value)) continue;
      if (
        data.groups.some(
          (other) =>
            other.id !== group.id &&
            [other.id, other.name, other.code].includes(value),
        )
      )
        fail("Название или код группы совпадает со ссылкой другой группы");
    }
  }
}
function directReference(row, entity, id) {
  const [single, multiple] = REFERENCE_FIELDS[entity];
  return (
    row[single] === id ||
    (Array.isArray(row[multiple]) && row[multiple].includes(id)) ||
    (entity === "subjects" &&
      Array.isArray(row.subjects) &&
      row.subjects.includes(id))
  );
}
function snapshotReferences(row, entity, id) {
  const found = [];
  function walk(value, path) {
    if (!value || typeof value !== "object") return;
    if (directReference(value, entity, id)) found.push(path);
    for (const [key, child] of Object.entries(value))
      if (child && typeof child === "object") walk(child, path + "." + key);
  }
  for (const key of ["before", "after"]) walk(row[key], key);
  return found;
}
/** Counts unique operational rows; snapshots are immutable destructive-edit blockers. */
export function catalogImpact(data, entity, id) {
  if (!CATALOG_ENTITIES.includes(entity)) fail("Неизвестный справочник");
  const lessonIds = new Set(
    (data.lessons || [])
      .filter((row) => directReference(row, entity, id))
      .map((row) => row.id),
  );
  const counts = {},
    blockers = [];
  for (const collection of REFERENCE_COLLECTIONS) {
    counts[collection] = 0;
    for (const row of data[collection] || []) {
      const snapshots = snapshotReferences(row, entity, id);
      if (
        directReference(row, entity, id) ||
        lessonIds.has(row.lessonId) ||
        snapshots.length
      )
        counts[collection]++;
      for (const path of snapshots)
        blockers.push({
          collection,
          id: row.id || row.lessonId || "",
          path,
          reason: "historical_reference",
        });
    }
  }
  return {
    counts,
    total: Object.values(counts).reduce((sum, count) => sum + count, 0),
    blockers,
  };
}
function repointCatalogReferences(data, entity, id, replacementId) {
  const [single, multiple] = REFERENCE_FIELDS[entity];
  for (const collection of REFERENCE_COLLECTIONS)
    for (const row of data[collection] || []) {
      if (row[single] === id) row[single] = replacementId;
      if (Array.isArray(row[multiple]))
        row[multiple] = [
          ...new Set(
            row[multiple].map((value) =>
              value === id ? replacementId : value,
            ),
          ),
        ];
      if (collection === "teachers" && entity === "subjects")
        row.subjects = [
          ...new Set(
            row.subjects.map((value) => (value === id ? replacementId : value)),
          ),
        ];
    }
}
function applyCatalogReplacements(data, original, imported, intents = []) {
  if (!Array.isArray(intents) || intents.length > 100)
    fail("Проверь список замен справочника");
  // A full draft cannot bypass the immutable-snapshot deletion guard by omitting
  // the replacement intent. Unknown historical content is never rewritten.
  for (const entity of CATALOG_ENTITIES)
    for (const old of original[entity])
      if (
        Array.isArray(imported[entity]) &&
        !imported[entity].some((row) => row.id === old.id) &&
        catalogImpact(original, entity, old.id).blockers.length
      )
        fail("Исторический снимок блокирует удаление справочника");
  const sources = new Set();
  for (const intent of intents) {
    if (
      !intent ||
      typeof intent !== "object" ||
      Array.isArray(intent) ||
      Object.keys(intent).sort().join(",") !== "entity,id,replacementId" ||
      !CATALOG_ENTITIES.includes(intent.entity) ||
      typeof intent.id !== "string" ||
      typeof intent.replacementId !== "string" ||
      intent.id === intent.replacementId
    )
      fail("Проверь замену справочника");
    const key = intent.entity + ":" + intent.id;
    if (sources.has(key)) fail("Повторная замена справочника");
    sources.add(key);
  }
  for (const { entity, id, replacementId } of intents) {
    if (sources.has(entity + ":" + replacementId))
      fail("Цепочки и циклы замен не поддерживаются");
    if (
      !original[entity]?.some((row) => row.id === id) ||
      !Array.isArray(imported[entity]) ||
      imported[entity].some((row) => row.id === id) ||
      !imported[entity].some((row) => row.id === replacementId)
    )
      fail("Источник или цель замены изменились. Обнови черновик");
    if (catalogImpact(original, entity, id).blockers.length)
      fail("Исторический снимок блокирует замену справочника");
    repointCatalogReferences(data, entity, id, replacementId);
  }
}

export function ownGroups(data, user) {
  return new Set(
    data.lessons
      .filter((l) => l.teacherId === user.teacherId)
      .map((l) => l.groupId),
  );
}
export function canTeach(data, user, groupId, subjectId) {
  return (
    user.role === "admin" ||
    (user.role === "teacher" &&
      data.lessons.some(
        (l) =>
          l.teacherId === user.teacherId &&
          l.groupId === groupId &&
          (!subjectId || l.subjectId === subjectId),
      ))
  );
}
export function notice(data, title, body, groupId = "", teacherId = "") {
  data.announcements.unshift({
    id: uid(),
    title,
    body,
    groupId,
    teacherId,
    roles: ["student", "teacher"],
    createdAt: new Date().toISOString(),
    automatic: true,
  });
  data.announcements = data.announcements.slice(0, 200);
}
export function mutate(input, user, op, payload = {}) {
  const data = clone(input);
  const admin = user.role === "admin",
    teacher = user.role === "teacher";
  if (!admin && !teacher) fail("Недостаточно прав", 403);
  if (
    typeof op !== "string" ||
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  )
    fail("Некорректная операция");
  let summary = "Изменение";
  if (op === "appearance.save") {
    if (!admin) fail("Интерфейс сайта меняет только владелец", 403);
    let policy;
    try {
      policy = validateAppearancePolicy(payload.policy);
    } catch (error) {
      fail(error.message);
    }
    data.siteSettings = { ...(data.siteSettings || {}), appearance: policy };
    summary = "Обновлены настройки интерфейса";
  } else if (op === "lesson.save" || op === "lesson.delete") {
    if (!admin) fail("Расписание меняет только администратор", 403);
    const old = data.lessons.find((l) => l.id === payload.id);
    if (op === "lesson.delete") {
      if (!old) fail("Пара не найдена");
      data.lessons = data.lessons.filter((l) => l.id !== old.id);
      data.exceptions = data.exceptions.filter((e) => e.lessonId !== old.id);
      data.requests = data.requests.filter((e) => e.lessonId !== old.id);
      data.attendance = data.attendance.filter((e) => e.lessonId !== old.id);
      summary = "Удалена пара";
    } else {
      const item = { ...payload, id: old?.id || uid() };
      data.lessons = data.lessons.filter((l) => l.id !== item.id);
      data.lessons.push(item);
      summary = old ? "Изменена пара" : "Добавлена пара";
    }
    const l = op === "lesson.delete" ? old : data.lessons.at(-1);
    const subject =
      data.subjects.find((s) => s.id === l.subjectId)?.name || "Занятие";
    notice(
      data,
      summary,
      subject + " · " + DAYS[l.day] + " " + l.start + "–" + l.end,
      l.groupId,
      l.teacherId,
    );
    if (old && (old.groupId !== l.groupId || old.teacherId !== l.teacherId))
      notice(
        data,
        "Занятие переназначено",
        subject + " · проверь новое расписание",
        old.groupId,
        old.teacherId,
      );
  } else if (op.startsWith("catalog.")) {
    if (!admin) fail("Справочники меняет только владелец", 403);
    const entity = payload.entity;
    if (!CATALOG_ENTITIES.includes(entity)) fail("Неизвестный справочник");
    const items = data[entity];
    if (op === "catalog.save") {
      const patch = payload.item;
      if (!patch || typeof patch !== "object" || Array.isArray(patch))
        fail("Нужна запись справочника");
      if (
        Object.keys(patch).some(
          (key) => key !== "id" && !CATALOG_FIELDS[entity].includes(key),
        )
      )
        fail("Неизвестное поле справочника");
      const index = items.findIndex((row) => row.id === patch.id);
      const old = index < 0 ? null : items[index];
      const entry = {
        ...(old || catalogDefaults(entity)),
        ...clone(patch),
        id: old?.id || patch.id || uid(),
      };
      validateCatalogItem(entity, entry, {
        authored: !old || Object.hasOwn(patch, "subgroups"),
      });
      if (index < 0) items.push(entry);
      else items[index] = entry;
      summary = old
        ? "Изменена запись справочника"
        : "Добавлена запись справочника";
    } else if (
      ["catalog.delete", "catalog.replace", "catalog.duplicate"].includes(op)
    ) {
      const old = items.find((row) => row.id === payload.id);
      if (!old) fail("Запись не найдена");
      if (op === "catalog.duplicate") {
        const entry = {
          ...catalogDefaults(entity),
          ...Object.fromEntries(
            CATALOG_FIELDS[entity]
              .filter((key) => Object.hasOwn(old, key))
              .map((key) => [key, clone(old[key])]),
          ),
          id: uid(),
          name: payload.name,
        };
        if (entity === "groups") entry.code = payload.code ?? "";
        if (entity === "teachers") entry.subjects = [];
        validateCatalogItem(entity, entry, { authored: true });
        items.push(entry);
        summary = "Создана копия записи без расписания";
      } else {
        const impact = catalogImpact(data, entity, old.id);
        if (op === "catalog.delete" && impact.total)
          fail("Запись используется. Сначала выбери явную замену");
        if (op === "catalog.replace") {
          if (
            old.id === payload.replacementId ||
            !items.some((row) => row.id === payload.replacementId)
          )
            fail("Выбери другую существующую запись");
          if (impact.blockers.length)
            fail(
              "Исторический снимок ссылается на запись. Сохрани её в справочнике",
            );
          repointCatalogReferences(data, entity, old.id, payload.replacementId);
        }
        data[entity] = items.filter((row) => row.id !== old.id);
        summary =
          op === "catalog.replace"
            ? "Ссылки переназначены, старая запись удалена"
            : "Удалена неиспользуемая запись справочника";
      }
    } else fail("Неизвестное действие справочника");
  } else if (op === "group.archive") {
    if (!admin) fail("Группы архивирует только владелец", 403);
    const group = data.groups.find((row) => row.id === payload.id);
    if (!group || typeof payload.archived !== "boolean")
      fail("Проверь группу и состояние архива");
    if (!isGroupActive({ ...group, archivedAt: null }))
      fail("Удалённую группу нельзя восстановить архивированием");
    group.archivedAt = payload.archived
      ? group.archivedAt || new Date().toISOString()
      : null;
    summary = payload.archived
      ? "Группа перемещена в архив"
      : "Группа восстановлена из архива";
  } else if (op === "task.save" || op === "task.delete") {
    const old = data.tasks.find((t) => t.id === payload.id);
    if (old && !admin && old.teacherId !== user.teacherId)
      fail("Это задание другого преподавателя", 403);
    if (op.endsWith("delete")) {
      if (!old) fail("Задание не найдено");
      data.tasks = data.tasks.filter((t) => t.id !== old.id);
      summary = "Удалено задание";
    } else {
      if (!canTeach(data, user, payload.groupId, payload.subjectId))
        fail("Ты не ведёшь этот предмет у группы", 403);
      const item = {
        ...payload,
        id: old?.id || uid(),
        teacherId: admin ? payload.teacherId || "" : user.teacherId,
      };
      data.tasks = data.tasks.filter((t) => t.id !== item.id);
      data.tasks.unshift(item);
      summary = "Опубликовано задание";
      notice(data, summary, item.title, item.groupId, item.teacherId);
    }
  } else if (op === "announcement.save") {
    if (!admin && !canTeach(data, user, payload.groupId))
      fail("Выбери свою учебную группу", 403);
    const item = {
      ...payload,
      id: uid(),
      createdAt: new Date().toISOString(),
      roles: admin ? payload.roles : ["student"],
      teacherId: admin ? payload.teacherId || "" : "",
    };
    data.announcements.unshift(item);
    data.announcements = data.announcements.slice(0, 200);
    summary = "Опубликовано объявление";
  } else if (op === "exception.save" || op === "exception.delete") {
    const l = data.lessons.find((l) => l.id === payload.lessonId);
    if (!l) fail("Пара не найдена");
    if (!admin && l.teacherId !== user.teacherId)
      fail("Можно изменить только свою пару", 403);
    if (
      !admin &&
      ((payload.teacherId && payload.teacherId !== l.teacherId) ||
        (payload.subjectId && payload.subjectId !== l.subjectId))
    )
      fail("Назначения меняет администратор", 403);
    if (!dateValid(payload.date) || !scheduledOn(l, payload.date))
      fail("В выбранную дату этой пары нет");
    const previous = data.exceptions.find(
      (e) => e.lessonId === l.id && e.date === payload.date,
    );
    data.exceptions = data.exceptions.filter(
      (e) => !(e.lessonId === l.id && e.date === payload.date),
    );
    if (op.endsWith("save")) {
      const fields = Object.fromEntries(
        [
          "date",
          "targetDate",
          "status",
          "start",
          "end",
          "roomId",
          "subjectId",
          "teacherId",
          "endDayOffset",
          "type",
          "note",
        ]
          .filter((k) => payload[k] !== undefined)
          .map((k) => [k, payload[k]]),
      );
      const stamp = new Date().toISOString();
      data.exceptions.push({
        ...fields,
        id: previous?.id || uid(),
        lessonId: l.id,
        createdAt: previous?.createdAt || stamp,
        updatedAt: stamp,
        actor: user.name,
        before: previous?.before || { ...l, date: payload.date },
        after:
          payload.status === "cancelled"
            ? null
            : {
                ...l,
                ...overrideFields(fields),
                date: fields.targetDate || fields.date,
              },
      });
    }
    summary = op.endsWith("delete")
      ? "Восстановлена обычная пара"
      : payload.status === "cancelled"
        ? "Пара отменена"
        : "Пара перенесена";
    notice(
      data,
      summary,
      data.subjects.find((s) => s.id === l.subjectId).name +
        " · " +
        payload.date +
        (payload.start ? " · " + payload.start : ""),
      l.groupId,
      l.teacherId,
    );
  } else if (op === "request.create") {
    const l = data.lessons.find((l) => l.id === payload.lessonId);
    if (!l || (!admin && l.teacherId !== user.teacherId))
      fail("Можно запросить перенос только своей пары", 403);
    text(payload.reason, "Причина", 1000);
    if (
      !dateValid(payload.date) ||
      !occurrences(data, payload.date).some(
        (x) => x.id === l.id && !x.cancelled,
      )
    )
      fail("Выбери дату действующего занятия с учётом типа недели");
    if (
      !timeValid(payload.start) ||
      !timeValid(payload.end) ||
      payload.start >= payload.end
    )
      fail("Проверь время");
    data.requests.unshift({
      ...payload,
      id: uid(),
      teacherId: l.teacherId,
      status: "pending",
      createdAt: new Date().toISOString(),
    });
    summary = "Отправлен запрос на перенос";
    data.announcements.unshift({
      id: uid(),
      title: summary,
      body: payload.reason,
      roles: ["admin"],
      groupId: "",
      teacherId: "",
      createdAt: new Date().toISOString(),
    });
  } else if (op === "request.decide") {
    if (!admin) fail("Решение принимает администратор", 403);
    const req = data.requests.find((r) => r.id === payload.id);
    if (!req || req.status !== "pending") fail("Запрос уже обработан");
    if (!["approved", "rejected"].includes(payload.status))
      fail("Неверное решение");
    if (payload.status === "approved") {
      data.exceptions = data.exceptions.filter(
        (e) => !(e.lessonId === req.lessonId && e.date === req.date),
      );
      data.exceptions.push({
        id: uid(),
        lessonId: req.lessonId,
        date: req.date,
        start: req.start,
        end: req.end,
        roomId: req.roomId,
        status: "moved",
        note: req.reason,
      });
    }
    req.status = payload.status;
    req.response = String(payload.response || "").slice(0, 1000);
    summary =
      payload.status === "approved" ? "Перенос согласован" : "Перенос отклонён";
    const l = data.lessons.find((l) => l.id === req.lessonId);
    notice(
      data,
      summary,
      (l ? data.subjects.find((s) => s.id === l.subjectId)?.name : "Занятие") +
        " · " +
        req.date,
      payload.status === "approved" ? l?.groupId || "" : "",
      req.teacherId,
    );
  } else if (op === "attendance.save") {
    const l = data.lessons.find((l) => l.id === payload.lessonId);
    if (!l || (!admin && l.teacherId !== user.teacherId))
      fail("Это занятие другого преподавателя", 403);
    if (
      !dateValid(payload.date) ||
      !occurrences(data, payload.date).some(
        (x) => x.id === l.id && !x.cancelled,
      ) ||
      !["present", "absent", "late", "excused"].includes(payload.status) ||
      typeof payload.studentId !== "string"
    )
      fail("Проверь запись посещаемости");
    data.attendance = data.attendance.filter(
      (a) =>
        !(
          a.lessonId === l.id &&
          a.date === payload.date &&
          a.studentId === payload.studentId
        ),
    );
    data.attendance.push({ ...payload });
    summary = "Обновлена посещаемость";
  } else if (op === "import") {
    if (!admin) fail("Импорт доступен администратору", 403);
    const imported = payload.data;
    if (!imported || !Array.isArray(imported.lessons))
      fail("Нужен экспорт UniFlow");
    applyCatalogReplacements(
      data,
      input,
      imported,
      payload.catalogReplacements,
    );
    for (const k of [
      "groups",
      "subjects",
      "teachers",
      "rooms",
      "lessons",
      "exceptions",
    ])
      data[k] = clone(imported[k] || []);
    // Older exports omit these fields. Preserve them unless the administrator
    // explicitly supplies a replacement; null deliberately clears a term bound.
    for (const k of ["holidays", "validFrom", "validUntil"]) {
      if (!Object.hasOwn(imported, k)) continue;
      if (k !== "holidays" && imported[k] === null) delete data[k];
      else data[k] = clone(imported[k]);
    }
    // Only the authored public policy is imported; future/internal siblings survive.
    if (Object.hasOwn(imported.siteSettings || {}, "appearance")) {
      let policy;
      try {
        policy = validateAppearancePolicy(imported.siteSettings.appearance);
      } catch (error) {
        fail(error.message);
      }
      data.siteSettings = { ...(data.siteSettings || {}), appearance: policy };
    }
    // Only the existing database may grandfather conflicts; an uploaded file
    // cannot grant itself exceptions.
    data.sourceConflictPairs = clone(input.sourceConflictPairs || []);
    data.sourceWarnings = clone(imported.sourceWarnings || []);
    data.source = clone(imported.source || null);
    summary =
      Object.hasOwn(imported.siteSettings || {}, "appearance") &&
      JSON.stringify(input.siteSettings?.appearance) !==
        JSON.stringify(data.siteSettings?.appearance)
        ? "Опубликован черновик с настройками интерфейса"
        : "Импортировано расписание";
    notice(data, summary, "Администратор обновил расписание из файла");
  } else fail("Неизвестное действие");
  validateChangedGroupAliases(input, data);
  validate(data);
  data.history.unshift({
    id: uid(),
    at: new Date().toISOString(),
    actor: user.name,
    action: op,
    summary,
  });
  data.history = data.history.slice(0, 100);
  return { data, summary };
}
export function visible(data, user) {
  const d = clone(data),
    admin = user.role === "admin",
    teacher = user.role === "teacher";
  const role = user.role === "guest" ? "student" : user.role;
  if (!admin) {
    delete d.siteSettings;
    if (Object.hasOwn(data.siteSettings || {}, "appearance")) {
      try {
        d.siteSettings = {
          appearance: validateAppearancePolicy(data.siteSettings.appearance),
        };
      } catch {
        /* Invalid stored policy is not a public contract. */
      }
    }
    d.history = [];
    d.requests = teacher
      ? d.requests.filter((r) => r.teacherId === user.teacherId)
      : [];
    d.attendance = teacher
      ? d.attendance.filter((a) =>
          d.lessons.some(
            (l) => l.id === a.lessonId && l.teacherId === user.teacherId,
          ),
        )
      : d.attendance.filter((a) => a.studentId === user.id);
    d.tasks = d.tasks.filter((t) =>
      teacher
        ? t.teacherId === user.teacherId
        : t.groupId === user.groupId &&
          (user.subgroup === "all" ||
            t.subgroup === "all" ||
            t.subgroup === user.subgroup),
    );
    d.announcements = d.announcements.filter(
      (n) =>
        n.roles.includes(role) &&
        ((!n.groupId && !n.teacherId) ||
          (teacher
            ? n.teacherId === user.teacherId ||
              (!n.teacherId && ownGroups(data, user).has(n.groupId))
            : n.groupId === user.groupId)),
    );
  }
  return d;
}
