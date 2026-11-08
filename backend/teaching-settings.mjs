// Authored form presets, never canonical lesson identities or a source repair.
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const dayMinutes = 1440;
function fail(message) {
  throw new Error(message);
}
function record(value, keys, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    fail("Неверный формат: " + label);
}
function id(value, label) {
  if (typeof value !== "string" || !ID.test(value))
    fail("Проверь идентификатор: " + label);
  return value;
}
function name(value, max, label) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    fail("Проверь название: " + label);
  return value.trim();
}
function enabled(value) {
  if (typeof value !== "boolean") fail("Состояние шаблона должно быть boolean");
  return value;
}
function list(value, max, label, parse, min = 0) {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    fail("Проверь количество записей: " + label);
  const parsed = value.map(parse),
    ids = new Set(),
    names = new Set();
  for (const item of parsed) {
    const key = item.name.toLocaleLowerCase("ru");
    if (ids.has(item.id) || names.has(key))
      fail("Повторяется идентификатор или название: " + label);
    ids.add(item.id);
    names.add(key);
  }
  return parsed;
}
const minutes = (value) =>
  Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
function slot(value) {
  record(value, ["id", "name", "start", "end", "endDayOffset"], "звонок");
  if (
    typeof value.start !== "string" ||
    typeof value.end !== "string" ||
    !TIME.test(value.start) ||
    !TIME.test(value.end) ||
    ![0, 1].includes(value.endDayOffset)
  )
    fail("Проверь время звонка");
  const duration =
    minutes(value.end) + value.endDayOffset * dayMinutes - minutes(value.start);
  if (duration <= 0 || duration > dayMinutes)
    fail("Длительность звонка должна быть больше нуля и не больше 24 часов");
  return {
    id: id(value.id, "звонок"),
    name: name(value.name, 80, "звонок"),
    start: value.start,
    end: value.end,
    endDayOffset: value.endDayOffset,
  };
}
function schedule(value) {
  record(value, ["id", "name", "enabled", "slots"], "расписание звонков");
  const slots = list(value.slots, 32, "звонки", slot, 1);
  // A daily scheme repeats after midnight. Compare the neighbouring copies too;
  // half-open intervals allow adjacent slots and an exactly 24-hour single slot.
  for (let i = 0; i < slots.length; i++)
    for (let j = i + 1; j < slots.length; j++) {
      const a = slots[i],
        b = slots[j];
      const as = minutes(a.start),
        ae = minutes(a.end) + a.endDayOffset * dayMinutes;
      const bs = minutes(b.start),
        be = minutes(b.end) + b.endDayOffset * dayMinutes;
      if (
        [-dayMinutes, 0, dayMinutes].some(
          (shift) => as < be + shift && bs + shift < ae,
        )
      )
        fail("Звонки пересекаются, включая переход через полночь");
    }
  return {
    id: id(value.id, "расписание звонков"),
    name: name(value.name, 80, "расписание звонков"),
    enabled: enabled(value.enabled),
    slots,
  };
}
/** Closed, bounded DTO. Return fresh authored data; never mutate the caller. */
export function validateTeachingSettings(settings) {
  record(
    settings,
    ["version", "lessonTypes", "bellSchedules", "defaultBellScheduleId"],
    "типы занятий и звонки",
  );
  if (settings.version !== 1)
    fail("Версия настроек типов и звонков не поддерживается");
  const lessonTypes = list(
    settings.lessonTypes,
    64,
    "типы занятий",
    (value) => {
      record(value, ["id", "name", "enabled"], "тип занятия");
      return {
        id: id(value.id, "тип занятия"),
        name: name(value.name, 40, "тип занятия"),
        enabled: enabled(value.enabled),
      };
    },
  );
  const bellSchedules = list(
    settings.bellSchedules,
    16,
    "расписания звонков",
    schedule,
  );
  const selected = settings.defaultBellScheduleId;
  if (
    typeof selected !== "string" ||
    (selected !== "" &&
      (!ID.test(selected) ||
        !bellSchedules.some((item) => item.id === selected && item.enabled)))
  )
    fail("Основное расписание звонков должно существовать и быть включено");
  return {
    version: 1,
    lessonTypes,
    bellSchedules,
    defaultBellScheduleId: selected,
  };
}
/** Match the old form convenience, not an inferred correction to imported times. */
export function defaultTeachingSettings() {
  return {
    version: 1,
    lessonTypes: [
      { id: "laboratory", name: "Лабораторная", enabled: true },
      { id: "lecture", name: "Лекция", enabled: true },
      { id: "practice", name: "Практика", enabled: true },
      { id: "lesson", name: "Занятие", enabled: true },
    ],
    bellSchedules: [
      {
        id: "standard",
        name: "Стандартные звонки · 50 минут",
        enabled: true,
        slots: Array.from({ length: 14 }, (_, i) => {
          const hour = String(i + 8).padStart(2, "0");
          return {
            id: "hour-" + hour,
            name: hour + ":00–" + hour + ":50",
            start: hour + ":00",
            end: hour + ":50",
            endDayOffset: 0,
          };
        }),
      },
    ],
    defaultBellScheduleId: "standard",
  };
}
/** Only absent settings use defaults. Invalid or unknown versions never reset silently. */
export function teachingSettings(data) {
  const value = data?.siteSettings?.teaching;
  return value === undefined
    ? defaultTeachingSettings()
    : validateTeachingSettings(value);
}
/** Exact historical strings stay usable; presets do not become a closed enum. */
export function lessonTypeSuggestions(data, current = "") {
  const values = teachingSettings(data)
    .lessonTypes.filter((item) => item.enabled)
    .map((item) => item.name);
  for (const row of [...(data?.lessons || []), ...(data?.exceptions || [])])
    values.push(row.type);
  values.push(current);
  return [
    ...new Set(
      values.filter(
        (value) =>
          typeof value === "string" && value.trim() && value.length <= 40,
      ),
    ),
  ];
}
