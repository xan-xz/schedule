import { clone, uid, validate, DAYS, fail } from "./core.mjs";
import { canonicalJson } from "./normalized.mjs";
import { sha } from "./security.mjs";

export const ROLLBACK_PAGE = 40;
const specs = [
  [
    "groups",
    "Группы",
    "name subgroups specialty language code archivedAt deletedAt",
  ],
  ["subjects", "Предметы", "name shortName color"],
  ["teachers", "Преподаватели", "name subjects"],
  ["rooms", "Аудитории", "name capacity building floor"],
  [
    "lessons",
    "Постоянные занятия",
    "groupId subgroup day week start end endDayOffset subjectId teacherId roomId type validFrom validUntil sharedSessionId",
  ],
  [
    "exceptions",
    "Разовые изменения",
    "lessonId date targetDate status start end endDayOffset subjectId teacherId roomId type",
  ],
  ["tasks", "Задания групп", "title due subjectId teacherId groupId subgroup"],
  ["announcements", "Объявления", "title groupId subgroup createdAt"],
  ["requests", "Обращения", "lessonId date status"],
  ["attendance", "Посещаемость", "lessonId date status"],
];
const opaque = [
  ["holidays", "Нерабочие дни"],
  ["siteSettings", "Настройки сайта"],
  ["source", "Сведения источника"],
  ["sourceWarnings", "Замечания источника"],
  ["sourceConflictPairs", "Исходные исключения конфликтов"],
];
const titles = {
  name: "Название",
  subgroups: "Подгруппы",
  specialty: "Специальность",
  language: "Язык",
  code: "Код",
  archivedAt: "Архив",
  deletedAt: "Удалено",
  shortName: "Короткое название",
  color: "Цвет",
  subjects: "Предметы",
  capacity: "Мест",
  building: "Корпус",
  floor: "Этаж",
  groupId: "Группа",
  subgroup: "Подгруппа",
  day: "День",
  week: "Неделя",
  start: "Начало",
  end: "Окончание",
  endDayOffset: "Следующие сутки",
  subjectId: "Предмет",
  teacherId: "Преподаватель",
  roomId: "Аудитория",
  type: "Тип",
  validFrom: "Действует с",
  validUntil: "Действует до",
  sharedSessionId: "Совместное занятие",
  lessonId: "Занятие",
  date: "Дата",
  targetDate: "Новая дата",
  status: "Статус",
  title: "Название",
  due: "Срок",
  createdAt: "Создано",
};
const equal = (a, b) =>
  a === undefined || b === undefined
    ? a === b
    : canonicalJson(a) === canonicalJson(b);
const clip = (value, limit = 700) =>
  Array.from(String(value)).slice(0, limit).join("");
const collection = (data, key) => (Array.isArray(data[key]) ? data[key] : []);
const withoutHistory = (data) =>
  Object.fromEntries(Object.entries(data).filter(([key]) => key !== "history"));
export function buildRollbackData(
  current,
  previous,
  target,
  actor,
  options = {},
) {
  const data = clone(previous),
    summary = "Восстановлена версия " + target;
  data.history = clone(current.history);
  data.history.unshift({
    id: options.id || uid(),
    at: options.at || new Date().toISOString(),
    actor,
    action: "rollback",
    summary,
  });
  validate(data);
  return { data, summary };
}
export async function rollbackFingerprint(current, restored, revision, target) {
  return sha(
    canonicalJson({
      revision,
      target,
      before: withoutHistory(current),
      after: withoutHistory(restored),
    }),
  );
}
function identity(section, row) {
  if (typeof row?.id === "string" && row.id) return "id:" + row.id;
  const keys =
    section === "exceptions"
      ? ["lessonId", "date"]
      : section === "attendance"
        ? ["lessonId", "studentId", "date"]
        : [];
  return keys.length &&
    keys.every((key) => typeof row?.[key] === "string" && row[key])
    ? canonicalJson(keys.map((key) => row[key]))
    : null;
}
function indexed(section, rows) {
  const entries = rows.map((row) => [identity(section, row), row]);
  const result = new Map(entries);
  return entries.every(([key]) => key !== null) &&
    result.size === entries.length
    ? result
    : null;
}
const catalogs = (data) =>
  Object.fromEntries(
    ["groups", "subjects", "teachers", "rooms"].map((key) => [
      key,
      new Map(collection(data, key).map((row) => [row.id, row.name])),
    ]),
  );
function describe(names, row, fields) {
  if (!row) return "Запись отсутствует";
  const labels = {
    groupId: "groups",
    teacherId: "teachers",
    roomId: "rooms",
    subjectId: "subjects",
  };
  return (
    clip(
      fields
        .filter((key) => Object.hasOwn(row, key))
        .map((key) => {
          let value = row[key];
          if (labels[key])
            value = names[labels[key]].get(value) || value || "Не назначено";
          else if (key === "day") value = DAYS[value] || value;
          else if (key === "week")
            value =
              { all: "Каждую неделю", odd: "Нечётная", even: "Чётная" }[
                value
              ] || value;
          else if (Array.isArray(value))
            value = value
              .map((item) =>
                typeof item === "string"
                  ? key === "subjects"
                    ? names.subjects.get(item) || item
                    : item
                  : "",
              )
              .join(", ");
          if (!["string", "number", "boolean"].includes(typeof value))
            value = "Не задано";
          return `${titles[key]}: ${value === "" ? "Не задано" : value}`;
        })
        .join(" · "),
    ) || "Учебная запись"
  );
}

/** Closed, paged owner-only projection. Unknown fields contribute to counts/hash, never text. */
export async function previewRollback(
  current,
  restored,
  { revision, target, page = 0 } = {},
) {
  if (
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !Number.isSafeInteger(target) ||
    target < 1 ||
    !Number.isSafeInteger(page) ||
    page < 0 ||
    page > 10000
  )
    fail("Неверные параметры просмотра версии");
  const summary = [],
    changes = [];
  for (const [section, label, visible] of specs) {
    const fields = visible.split(" "),
      before = collection(current, section),
      after = collection(restored, section);
    const old = indexed(section, before),
      next = indexed(section, after);
    const counts = {
      section,
      label,
      beforeCount: before.length,
      afterCount: after.length,
      added: 0,
      removed: 0,
      changed: 0,
      orderChanged: false,
      detailed: Boolean(old && next),
    };
    if (!equal(before, after)) {
      if (!old || !next) {
        counts.changed = 1;
        changes.push({
          section,
          label,
          kind: "changed",
          beforeText: `Записей: ${before.length}`,
          afterText: `Записей: ${after.length}`,
          hiddenChanged: true,
        });
      } else {
        for (const key of new Set([...old.keys(), ...next.keys()])) {
          const a = old.get(key),
            b = next.get(key);
          if (equal(a, b)) continue;
          const kind = !a ? "added" : !b ? "removed" : "changed";
          counts[kind]++;
          const extra = (row) =>
            Object.fromEntries(
              Object.entries(row || {}).filter(
                ([field]) => field !== "id" && !fields.includes(field),
              ),
            );
          changes.push({
            section,
            label,
            kind,
            a,
            b,
            fields,
            hiddenChanged: !equal(extra(a), extra(b)),
          });
        }
        const sharedOld = [...old.keys()].filter((key) => next.has(key)),
          sharedNext = [...next.keys()].filter((key) => old.has(key));
        counts.orderChanged = !equal(sharedOld, sharedNext);
        if (counts.orderChanged)
          changes.push({
            section,
            label,
            kind: "order",
            beforeText: "Текущий порядок записей",
            afterText: "Порядок из выбранной версии",
            hiddenChanged: false,
          });
      }
    }
    summary.push(counts);
  }
  for (const [section, label] of opaque) {
    const a = current[section],
      b = restored[section];
    const size = (value) =>
      Array.isArray(value) ? value.length : value == null ? 0 : 1;
    const changed = !equal(a, b);
    summary.push({
      section,
      label,
      beforeCount: size(a),
      afterCount: size(b),
      added: 0,
      removed: 0,
      changed: changed ? 1 : 0,
      orderChanged: false,
      detailed: false,
    });
    if (changed)
      changes.push({
        section,
        label,
        kind: "changed",
        beforeText: `Записей: ${size(a)}`,
        afterText: `Записей: ${size(b)}`,
        hiddenChanged: true,
      });
  }
  const known = new Set([
    ...specs.map(([key]) => key),
    ...opaque.map(([key]) => key),
    "history",
  ]);
  const rest = (data) =>
    Object.fromEntries(Object.entries(data).filter(([key]) => !known.has(key)));
  const otherChanged = !equal(rest(current), rest(restored));
  summary.push({
    section: "other",
    label: "Период и дополнительные сведения",
    beforeCount: Object.keys(rest(current)).length,
    afterCount: Object.keys(rest(restored)).length,
    added: 0,
    removed: 0,
    changed: otherChanged ? 1 : 0,
    orderChanged: false,
    detailed: false,
  });
  if (otherChanged)
    changes.push({
      section: "other",
      label: "Период и дополнительные сведения",
      kind: "changed",
      beforeText: "Текущие дополнительные поля",
      afterText: "Дополнительные поля из версии",
      hiddenChanged: true,
    });
  const totalPages = Math.max(1, Math.ceil(changes.length / ROLLBACK_PAGE)),
    selectedPage = Math.min(page, totalPages - 1);
  const beforeNames = catalogs(current),
    afterNames = catalogs(restored);
  const pageChanges = changes
    .slice(selectedPage * ROLLBACK_PAGE, (selectedPage + 1) * ROLLBACK_PAGE)
    .map((change) => {
      if (!change.fields) return change;
      const { section, label, kind, a, b, fields, hiddenChanged } = change;
      const title = fields.includes("name")
        ? b?.name || a?.name
        : fields.includes("title")
          ? b?.title || a?.title
          : null;
      return {
        section,
        label: clip(
          `${label} · ${title || b?.id || a?.id || "Учебная запись"}`,
          180,
        ),
        kind,
        beforeText: describe(beforeNames, a, fields),
        afterText: describe(afterNames, b, fields),
        hiddenChanged,
      };
    });
  return {
    format: "uniflow-rollback-preview-v1",
    revision,
    target,
    fingerprint: await rollbackFingerprint(current, restored, revision, target),
    page: selectedPage,
    pageSize: ROLLBACK_PAGE,
    totalPages,
    totalChanges: changes.length,
    summary,
    changes: pageChanges,
  };
}
