// A plan changes lesson fields only. Authorization and whole-model validation
// belong to core.mjs; no catalog, provenance, history or private row is rewritten.
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const dayMinutes = 1440;
const scalarChanges = new Set(["roomId", "teacherId", "subjectId", "type"]);
function fail(message) {
  throw Object.assign(new Error(message), { status: 400 });
}
function record(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    fail("Неверный формат массового изменения");
}
const minute = (value) =>
  Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
function interval(start, end, offset) {
  if (
    typeof start !== "string" ||
    typeof end !== "string" ||
    !TIME.test(start) ||
    !TIME.test(end) ||
    ![0, 1].includes(offset)
  )
    fail("Проверь время выбранных занятий");
  const duration = minute(end) + offset * dayMinutes - minute(start);
  if (duration <= 0 || duration > dayMinutes)
    fail("Длительность занятия должна быть больше нуля и не больше 24 часов");
  return duration;
}
/** Strict primitive request; IDs are compared exactly, never trimmed or rewritten. */
export function normalizeLessonBatch(payload) {
  record(payload, ["ids", "change"]);
  if (
    !Array.isArray(payload.ids) ||
    payload.ids.length < 1 ||
    payload.ids.length > 1000 ||
    payload.ids.some(
      (id) => typeof id !== "string" || !id || id.length > 100,
    ) ||
    new Set(payload.ids).size !== payload.ids.length
  )
    fail("Выбери от 1 до 1000 разных существующих занятий");
  const change = payload.change;
  if (!change || typeof change !== "object" || Array.isArray(change))
    fail("Выбери одно массовое изменение");
  let normalized;
  if (scalarChanges.has(change.kind)) {
    record(change, ["kind", "value"]);
    const max = change.kind === "type" ? 40 : 100;
    if (
      typeof change.value !== "string" ||
      change.value.length > max ||
      ((change.kind === "type" || change.kind === "subjectId") &&
        !change.value.trim())
    )
      fail("Проверь новое значение выбранного поля");
    normalized = { kind: change.kind, value: change.value };
  } else if (change.kind === "setTime") {
    record(change, ["kind", "start", "end", "endDayOffset"]);
    interval(change.start, change.end, change.endDayOffset);
    normalized = {
      kind: "setTime",
      start: change.start,
      end: change.end,
      endDayOffset: change.endDayOffset,
    };
  } else if (change.kind === "shiftTime") {
    record(change, ["kind", "minutes"]);
    if (
      !Number.isInteger(change.minutes) ||
      change.minutes === 0 ||
      Math.abs(change.minutes) > 1439
    )
      fail("Сдвиг: целое ненулевое число от −1439 до 1439 минут");
    normalized = { kind: "shiftTime", minutes: change.minutes };
  } else fail("Выбери одно разрешённое массовое изменение");
  return { ids: [...payload.ids], change: normalized };
}
const clock = (value) =>
  String(Math.floor(value / 60)).padStart(2, "0") +
  ":" +
  String(value % 60).padStart(2, "0");
function timePatch(lesson, start, end, endDayOffset) {
  if (
    lesson.start === start &&
    lesson.end === end &&
    (lesson.endDayOffset ?? 0) === endDayOffset
  )
    return null;
  const patch = { start, end };
  // Missing offset and zero mean the same thing. Preserve absence unless a real
  // midnight transition requires an offset or the record already authored one.
  if (endDayOffset !== 0 || Object.hasOwn(lesson, "endDayOffset"))
    patch.endDayOffset = endDayOffset;
  return patch;
}
function patchFor(lesson, change) {
  if (scalarChanges.has(change.kind)) {
    const previous = lesson[change.kind];
    if (
      previous === change.value ||
      (["roomId", "teacherId"].includes(change.kind) &&
        change.value === "" &&
        (previous === undefined || previous === null || previous === ""))
    )
      return null;
    return { [change.kind]: change.value };
  }
  if (change.kind === "setTime")
    return timePatch(lesson, change.start, change.end, change.endDayOffset);
  const duration = interval(lesson.start, lesson.end, lesson.endDayOffset ?? 0);
  const start = minute(lesson.start) + change.minutes;
  if (start < 0 || start >= dayMinutes)
    fail(
      "Сдвиг выводит начало занятия за границы его дня. Выбери другой сдвиг",
    );
  const end = start + duration;
  return timePatch(
    lesson,
    clock(start),
    clock(end % dayMinutes),
    Math.floor(end / dayMinutes),
  );
}
/** Apply all selected rows to a detached candidate before a single validation. */
export function buildLessonBatch(data, payload) {
  const { ids, change } = normalizeLessonBatch(payload);
  if (!Array.isArray(data?.lessons)) fail("Раздел занятий недоступен");
  const selected = new Set(ids),
    counts = new Map();
  for (const row of data.lessons)
    if (selected.has(row?.id))
      counts.set(row.id, (counts.get(row.id) || 0) + 1);
  if (ids.some((id) => counts.get(id) !== 1))
    fail("Выбранные занятия изменились или отсутствуют. Обнови выбор");
  // Calculate every patch first: a late bad shift must never leak a partial plan.
  const patches = new Map();
  for (const lesson of data.lessons)
    if (selected.has(lesson.id)) {
      const patch = patchFor(lesson, change);
      if (patch) patches.set(lesson.id, patch);
    }
  const lessons = structuredClone(data.lessons);
  for (const lesson of lessons) {
    const patch = patches.get(lesson.id);
    if (patch) Object.assign(lesson, patch);
  }
  return {
    lessons,
    selectedCount: ids.length,
    changedIds: [...patches.keys()],
    unchangedCount: ids.length - patches.size,
  };
}
