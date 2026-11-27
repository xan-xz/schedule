import {
  addDays,
  collision,
  occurrences,
  time,
  validate,
  weeksOverlap,
} from "./core.mjs";
import { groupFaculty, isGroupActive } from "./group-state.mjs";
import { validDate } from "./lib/time.mjs";

const lessonLimit = 40;
const searchLimit = 8000;
const minutesPerDay = 1440;
const timeValid = (value) =>
  typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const clock = (minutes) =>
  [Math.floor(minutes / 60) % 24, minutes % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");

function options(values, maximum, valid, label) {
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.length > maximum ||
    !values.every(valid)
  )
    throw new Error(`Проверьте ${label}. Допустимо до ${maximum} значений.`);
  return [...new Set(values)].sort();
}

function roomChoices(data, roomIds, minimumCapacity = 0) {
  if (
    !Number.isInteger(minimumCapacity) ||
    minimumCapacity < 0 ||
    minimumCapacity > 500
  )
    throw new Error("Укажите вместимость от 0 до 500 мест.");
  const catalog = new Map(data.rooms.map((room) => [room.id, room]));
  const allowed =
    roomIds === undefined || (Array.isArray(roomIds) && !roomIds.length)
      ? null
      : options(roomIds, 8, (id) => catalog.has(id), "аудитории");
  return (lesson) =>
    (allowed || [lesson.roomId || ""]).filter((id) => {
      const room = catalog.get(id);
      return (
        !minimumCapacity ||
        (room && !room.capacityEstimated && room.capacity >= minimumCapacity)
      );
    });
}

function movedSlot(lesson, start, roomId) {
  const duration =
    time(lesson.end) +
    (lesson.endDayOffset || 0) * minutesPerDay -
    time(lesson.start);
  const end = time(start) + duration;
  return {
    start,
    end: clock(end),
    endDayOffset: Math.floor(end / minutesPerDay),
    roomId,
  };
}

function placementReasons(candidate, hadSameRoom) {
  const reasons = ["У группы нет пересечений"];
  if (candidate.teacherId) reasons.push("Преподаватель свободен");
  if (candidate.roomId)
    reasons.push(
      hadSameRoom
        ? "Текущая аудитория свободна"
        : "Выбранная аудитория свободна",
    );
  else reasons.push("Аудиторию нужно назначить");
  return reasons;
}

function dayAvailable(data, date, groupId) {
  return (
    (!data.validFrom || date >= data.validFrom) &&
    (!data.validUntil || date <= data.validUntil) &&
    !(data.holidays || []).some(
      (item) =>
        (!item.groupId || item.groupId === groupId) &&
        date >= item.start &&
        date <= item.end,
    )
  );
}

function moveDistance(a, b) {
  return (
    Math.abs(Date.parse(a.date) - Date.parse(b.date)) / 60000 +
    Math.abs(time(a.start) - time(b.start)) +
    Number((a.roomId || "") !== (b.roomId || "")) * 15
  );
}

/** Finds verifiable target slots for the occurrence identified by its original date. */
export function proposeLessonMoves(
  data,
  { lessonId, date, dates, starts, roomIds, minimumCapacity, limit = 5 },
) {
  if (!validDate(date) || !Number.isInteger(limit) || limit < 1 || limit > 8)
    throw new Error("Проверьте исходную дату и число вариантов (от 1 до 8).");
  const targetDates = options(dates, 14, validDate, "даты переноса");
  const targetStarts = options(starts, 16, timeValid, "время начала");
  const existing = data.exceptions.find(
    (item) => item.lessonId === lessonId && item.date === date,
  );
  const byDate = new Map();
  const on = (day) => {
    if (!byDate.has(day))
      byDate.set(day, occurrences(data, day, { activeOnly: true }));
    return byDate.get(day);
  };
  const isSource = (lesson) =>
    lesson.id === lessonId && (lesson.exception?.date || lesson.date) === date;
  const source = on(existing?.targetDate || date).find(isSource);
  if (!source || source.cancelled)
    return {
      suggestions: [],
      reason: "На исходную дату нет действующей пары.",
    };
  const rooms = roomChoices(data, roomIds, minimumCapacity)(source);
  const candidates = [];
  for (const targetDate of targetDates) {
    if (!dayAvailable(data, targetDate, source.groupId)) continue;
    const busy = [-1, 0, 1]
      .flatMap((offset) => on(addDays(targetDate, offset)))
      .filter((lesson) => !lesson.cancelled && !isSource(lesson));
    for (const start of targetStarts) {
      for (const roomId of rooms) {
        const slot = movedSlot(source, start, roomId);
        const candidate = { ...source, ...slot, date: targetDate };
        if (
          (targetDate === source.date &&
            start === source.start &&
            roomId === (source.roomId || "")) ||
          (slot.endDayOffset &&
            !dayAvailable(data, addDays(targetDate, 1), source.groupId)) ||
          busy.some((lesson) => collision(candidate, lesson))
        )
          continue;
        candidates.push(candidate);
      }
    }
  }
  candidates.sort((a, b) => moveDistance(a, source) - moveDistance(b, source));
  const otherExceptions = existing
    ? data.exceptions.filter((item) => item !== existing)
    : data.exceptions;
  const suggestions = [];
  // The existing full-model validator is the final authority on candidate writes.
  for (const candidate of candidates.slice(0, limit * 2)) {
    const { date: targetDate, start, end, endDayOffset, roomId } = candidate;
    const payload = {
      ...(existing?.note !== undefined ? { note: existing.note } : {}),
      lessonId,
      date,
      targetDate,
      status: "moved",
      start,
      end,
      endDayOffset,
      roomId,
      subjectId: source.subjectId,
      teacherId: source.teacherId,
      type: source.type,
    };
    try {
      validate({ ...data, exceptions: [...otherExceptions, payload] });
    } catch {
      continue;
    }
    suggestions.push({
      date: targetDate,
      start,
      end,
      endDayOffset,
      roomId,
      reasons: placementReasons(candidate, roomId === source.roomId),
      payload,
    });
    if (suggestions.length === limit) break;
  }
  return suggestions.length
    ? { suggestions }
    : {
        suggestions,
        reason: "По этим условиям не найден проверенный перенос.",
      };
}

function overnightCollision(first, next) {
  if (!first.endDayOffset || next.day !== (first.day + 1) % 7) return false;
  const sameParity = first.week === next.week;
  if (
    (first.week !== "all" &&
      next.week !== "all" &&
      (first.day === 6 ? sameParity : !sameParity)) ||
    (first.validUntil &&
      next.validFrom &&
      addDays(first.validUntil, 1) < next.validFrom) ||
    (next.validUntil && first.validFrom && next.validUntil < first.validFrom)
  )
    return false;
  return Boolean(
    collision(
      { ...first, date: "2026-01-05" },
      { ...next, date: "2026-01-06" },
    ),
  );
}

function weeklyCollision(a, b) {
  if (a.day === b.day)
    return weeksOverlap(a.week, b.week) && Boolean(collision(a, b));
  return overnightCollision(a, b) || overnightCollision(b, a);
}

function resourceKeys(lesson) {
  return [
    `group:${lesson.groupId}`,
    ...(lesson.teacherId ? [`teacher:${lesson.teacherId}`] : []),
    ...(lesson.roomId ? [`room:${lesson.roomId}`] : []),
  ];
}

function weeklyOccupancy(lessons) {
  const byResource = new Map();
  for (const lesson of lessons) {
    for (const key of resourceKeys(lesson)) {
      if (!byResource.has(key)) byResource.set(key, []);
      byResource.get(key).push(lesson);
    }
  }
  return (candidate) =>
    resourceKeys(candidate).some((key) =>
      byResource.get(key)?.some((lesson) => weeklyCollision(candidate, lesson)),
    );
}

function weeklyDistance(a, b) {
  return (
    Math.abs(a.day - b.day) * minutesPerDay +
    Math.abs(time(a.start) - time(b.start)) +
    Number((a.roomId || "") !== (b.roomId || "")) * 15
  );
}

/** Builds a verified recurring comparison while preserving fixed or linked lessons. */
export function planFacultySchedule(
  data,
  { facultyId, days, starts, lessonIds, roomIds, minimumCapacity },
) {
  const preferredDays = options(
    days,
    7,
    (day) => Number.isInteger(day) && day >= 0 && day <= 6,
    "дни недели",
  );
  const preferredStarts = options(starts, 16, timeValid, "время начала");
  const rooms = roomChoices(data, roomIds, minimumCapacity);
  const groupIds = new Set(
    data.groups
      .filter(
        (group) => isGroupActive(group) && groupFaculty(group) === facultyId,
      )
      .map((group) => group.id),
  );
  const faculty = data.lessons.filter((lesson) => groupIds.has(lesson.groupId));
  const allowed = new Set(faculty.map((lesson) => lesson.id));
  const requested = new Set(
    lessonIds === undefined
      ? allowed
      : options(lessonIds, lessonLimit, (id) => allowed.has(id), "занятия"),
  );
  const linked = new Set(
    [data.exceptions, data.attendance, data.requests]
      .flat()
      .map((entry) => entry.lessonId),
  );
  const available = faculty.filter(
    (lesson) =>
      requested.has(lesson.id) &&
      !lesson.sharedSessionId &&
      !linked.has(lesson.id),
  );
  const movableIds = new Set(available.map((lesson) => lesson.id));
  const lockedLessonIds = [...requested].filter((id) => !movableIds.has(id));
  function unavailable(reason) {
    return { status: "unavailable", changes: [], lockedLessonIds, reason };
  }
  if (!available.length)
    return unavailable(
      "В выбранном наборе нет занятий, доступных для новой расстановки.",
    );
  if (available.length > lessonLimit)
    return unavailable(`Выберите до ${lessonLimit} занятий на один расчёт.`);

  const activeGroups = new Set(
    data.groups.filter(isGroupActive).map((group) => group.id),
  );
  const busy = weeklyOccupancy(
    data.lessons.filter(
      (lesson) =>
        activeGroups.has(lesson.groupId) && !movableIds.has(lesson.id),
    ),
  );
  const domains = available.map((before) => {
    const choices = [];
    const roomOptions = rooms(before);
    for (const day of preferredDays)
      for (const start of preferredStarts)
        for (const roomId of roomOptions) {
          const after = { ...before, ...movedSlot(before, start, roomId), day };
          if (!busy(after)) choices.push(after);
        }
    choices.sort(
      (a, b) => weeklyDistance(a, before) - weeklyDistance(b, before),
    );
    return { before, choices };
  });
  domains.sort((a, b) => a.choices.length - b.choices.length);
  if (!domains[0].choices.length)
    return unavailable(
      "Для одного или нескольких занятий нет подходящего слота.",
    );
  const chosen = [];
  let attempts = 0;
  function arrange(index) {
    if (index === domains.length) return true;
    for (const after of domains[index].choices) {
      if (++attempts > searchLimit) return false;
      if (chosen.some((item) => weeklyCollision(after, item))) continue;
      chosen.push(after);
      if (arrange(index + 1)) return true;
      chosen.pop();
    }
    return false;
  }
  if (!arrange(0))
    return unavailable(
      attempts > searchLimit
        ? "Достигнут предел расчёта. Выберите меньше занятий или другие слоты."
        : "В заданных слотах не удалось разместить все выбранные занятия.",
    );
  const replacements = new Map(chosen.map((lesson) => [lesson.id, lesson]));
  try {
    validate({
      ...data,
      lessons: data.lessons.map(
        (lesson) => replacements.get(lesson.id) || lesson,
      ),
    });
  } catch (error) {
    return unavailable(
      `Проверка расписания отклонила вариант: ${error.message}.`,
    );
  }
  const changes = available.flatMap((before) => {
    const after = replacements.get(before.id);
    return weeklyDistance(before, after)
      ? [
          {
            before,
            after,
            reasons: placementReasons(after, before.roomId === after.roomId),
          },
        ]
      : [];
  });
  return {
    status: changes.length ? "planned" : "unchanged",
    changes,
    lockedLessonIds,
  };
}
