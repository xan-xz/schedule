import { clone, mutate, DAYS } from "../core.mjs";
import { draftChanges, recoverChanges } from "./drafts.mjs";

export const JSON_IMPORT_BYTES = 1_000_000;
const specs = [
  [
    "groups",
    "Группы",
    "name subgroups specialty language code archivedAt deletedAt",
  ],
  ["subjects", "Предметы", "name shortName color"],
  ["teachers", "Преподаватели", "name subjects"],
  ["rooms", "Аудитории", "name capacity capacityEstimated building floor"],
  [
    "lessons",
    "Постоянные занятия",
    "groupId subgroup day week start end endDayOffset subjectId teacherId roomId type validFrom validUntil",
  ],
  [
    "exceptions",
    "Разовые изменения",
    "lessonId date targetDate status start end endDayOffset subjectId teacherId roomId type",
  ],
];
const properties = [
  ["holidays", "Нерабочие дни"],
  ["validFrom", "Начало периода"],
  ["validUntil", "Конец периода"],
  ["source", "Сведения источника"],
  ["sourceWarnings", "Замечания источника"],
  ["siteSettings.teaching", "Типы занятий и звонки"],
  ["siteSettings.appearance", "Оформление сайта"],
];
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
export const jsonImportFingerprint = (value) =>
  JSON.stringify(canonical(value));
const equal = (a, b) => jsonImportFingerprint(a) === jsonImportFingerprint(b);
const property = (data, path) =>
  path.split(".").reduce((value, key) => value?.[key], data);
const editable = (data) =>
  Object.fromEntries([
    ...specs.map(([key]) => [key, data[key]]),
    ...properties.map(([key]) => [key, property(data, key)]),
  ]);
const clip = (value, limit = 700) =>
  Array.from(String(value)).slice(0, limit).join("");
const labels = {
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
  capacityEstimated: "Оценка вместимости",
  building: "Корпус",
  floor: "Этаж",
  groupId: "Группа",
  subgroup: "Подгруппа",
  day: "День",
  week: "Неделя",
  start: "Начало",
  end: "Конец",
  endDayOffset: "Следующие сутки",
  subjectId: "Предмет",
  teacherId: "Преподаватель",
  roomId: "Аудитория",
  type: "Тип",
  validFrom: "Действует с",
  validUntil: "Действует до",
  lessonId: "Занятие",
  date: "Дата",
  targetDate: "Новая дата",
  status: "Статус",
};
const catalogFields = {
  groupId: "groups",
  subjectId: "subjects",
  teacherId: "teachers",
  roomId: "rooms",
};
function names(data) {
  return Object.fromEntries(
    ["groups", "subjects", "teachers", "rooms"].map((key) => [
      key,
      new Map(data[key].map((row) => [row.id, row.name])),
    ]),
  );
}
function describe(row, fields, catalogs) {
  if (!row) return "Запись отсутствует";
  return (
    clip(
      fields
        .filter((key) => Object.hasOwn(row, key))
        .map((key) => {
          let value = row[key];
          if (catalogFields[key])
            value =
              catalogs[catalogFields[key]].get(value) ||
              value ||
              "Не назначено";
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
                    ? catalogs.subjects.get(item) || item
                    : item
                  : "",
              )
              .join(", ");
          if (!["string", "number", "boolean"].includes(typeof value))
            value = "Не задано";
          return `${labels[key]}: ${value === "" ? "Не задано" : value}`;
        })
        .join(" · "),
    ) || "Учебная запись"
  );
}

/** Mirrors the existing authenticated import semantics; file content never grants authority. */
export function previewJsonImport(
  raw,
  data,
  user,
  { before = data, replacements = [] } = {},
) {
  if (
    typeof raw !== "string" ||
    raw.length > JSON_IMPORT_BYTES ||
    new TextEncoder().encode(raw).length > JSON_IMPORT_BYTES
  )
    throw Error("Размер JSON не должен превышать 1 МБ.");
  let input;
  try {
    input = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    throw Error("Не удалось прочитать JSON. Выберите файл экспорта UniFlow 2.");
  }
  if (!input || Array.isArray(input) || input.format !== "uniflow-2")
    throw Error("Нужен файл экспорта UniFlow 2.");
  const result = mutate(data, user, "import", { data: input }).data;
  // Existing replacement intents refer to the original server snapshot, not to
  // the already edited draft. Validate their eventual publication separately.
  mutate(before, user, "import", {
    data: result,
    catalogReplacements: replacements,
  });
  // Publication creates its own real announcement/audit. The preview is read-only.
  result.announcements = clone(data.announcements);
  result.history = clone(data.history);
  let journal;
  try {
    journal = draftChanges(before, result, replacements);
    const recovered = recoverChanges(before, journal);
    if (
      recovered.conflicts.length ||
      !equal(editable(recovered.data), editable(result))
    )
      throw Error("roundtrip");
  } catch {
    throw Error(
      "Порядок записей, дополнительные сведения или объём изменений нельзя точно восстановить из локальной копии. Файл не применён; сохраните текущий порядок и поддерживаемые поля экспорта.",
    );
  }
  const changes = [],
    summary = [];
  for (const [section, label, keys] of specs) {
    const fields = keys.split(" "),
      old = new Map(data[section].map((row) => [row.id, row])),
      next = new Map(result[section].map((row) => [row.id, row]));
    const counts = {
      section,
      label,
      beforeCount: old.size,
      afterCount: next.size,
      added: 0,
      removed: 0,
      changed: 0,
    };
    for (const id of new Set([...old.keys(), ...next.keys()])) {
      const a = old.get(id),
        b = next.get(id);
      if (equal(a, b)) continue;
      const kind = !a ? "added" : !b ? "removed" : "changed";
      counts[kind]++;
      const extra = (row) =>
        Object.fromEntries(
          Object.entries(row || {}).filter(
            ([key]) => key !== "id" && !fields.includes(key),
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
    summary.push(counts);
  }
  for (const [section, label] of properties) {
    const a = property(data, section),
      b = property(result, section),
      changed = !equal(a, b);
    const count = (value) =>
      Array.isArray(value)
        ? value.length
        : value === undefined || value === null
          ? 0
          : 1;
    summary.push({
      section,
      label,
      beforeCount: count(a),
      afterCount: count(b),
      added: 0,
      removed: 0,
      changed: changed ? 1 : 0,
      opaque: true,
    });
    if (changed)
      changes.push({
        section,
        label,
        kind: "changed",
        beforeText: "Текущее значение",
        afterText: "Значение после импорта",
        hiddenChanged: true,
      });
  }
  return {
    data: result,
    summary,
    changes,
    totalChanges: changes.length,
    namesBefore: names(data),
    namesAfter: names(result),
  };
}

/** Only the selected forty descriptors become display text; no private metadata enters the DTO. */
export function jsonImportPage(plan, page = 0) {
  if (!Number.isSafeInteger(page) || page < 0)
    throw Error("Неверная страница изменений.");
  return plan.changes.slice(page * 40, (page + 1) * 40).map((change) => {
    const { section, label, kind, fields, a, b, hiddenChanged } = change;
    if (!fields)
      return {
        section,
        label,
        kind,
        beforeText: change.beforeText,
        afterText: change.afterText,
        hiddenChanged,
      };
    const title = fields.includes("name") ? b?.name || a?.name : null;
    return {
      section,
      label: clip(
        `${label} · ${title || b?.id || a?.id || "Учебная запись"}`,
        180,
      ),
      kind,
      beforeText: describe(a, fields, plan.namesBefore),
      afterText: describe(b, fields, plan.namesAfter),
      hiddenChanged,
    };
  });
}
