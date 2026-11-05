/** Calendar arithmetic is date-only; lesson instants always use Kazakhstan UTC+5. */
export const TIME_ZONE = 'Asia/Almaty';
const dayMs = 86_400_000;
const dateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function localDate(now = new Date()) {
  const parts = Object.fromEntries(dateFormat.formatToParts(now).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function addDays(date, amount) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + amount * dayMs).toISOString().slice(0, 10);
}

export function dayOf(date) {
  return (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
}

export function monday(date) {
  return addDays(date, -dayOf(date));
}

export function isoWeek(date) {
  const thursday = addDays(date, 3 - dayOf(date));
  const firstThursday = addDays(`${thursday.slice(0, 4)}-01-04`, 3 - dayOf(`${thursday.slice(0, 4)}-01-04`));
  return 1 + Math.round((Date.parse(`${thursday}T12:00:00Z`) - Date.parse(`${firstThursday}T12:00:00Z`)) / (7 * dayMs));
}

export function instant(date, time) {
  return Date.parse(`${date}T${time}:00+05:00`);
}

function inScope(lesson, scope) {
  if (scope.teacherId) return lesson.teacherId === scope.teacherId;
  return (!scope.groupId || lesson.groupId === scope.groupId)
    && (!scope.subgroup || scope.subgroup === 'all' || lesson.subgroup === 'all' || lesson.subgroup === scope.subgroup);
}

function holiday(data, date, groupId) {
  return (data.holidays || []).some(item => (!item.groupId || item.groupId === groupId)
    && date >= item.start && date <= item.end);
}

function scheduled(lesson, date, data, contexts) {
  if (!contexts.has(date)) contexts.set(date, { day: dayOf(date), parity: isoWeek(date) % 2 ? 'odd' : 'even' });
  const { day, parity } = contexts.get(date);
  return lesson.day === day && (!lesson.week || lesson.week === 'all' || lesson.week === parity)
    && date >= (lesson.validFrom || data.validFrom || '0000-01-01')
    && date <= (lesson.validUntil || data.validUntil || '9999-12-31')
    && !holiday(data, date, lesson.groupId);
}

function occurrence(lesson, sourceDate, override) {
  const changes = override?.status === 'moved' ? override : {};
  const date = changes.targetDate || sourceDate;
  const result = { ...lesson };
  for (const key of ['start', 'end', 'endDayOffset', 'subjectId', 'teacherId', 'roomId', 'type']) {
    if (changes[key] !== undefined) result[key] = changes[key];
  }
  const endDate = addDays(date, Number(result.endDayOffset || 0));
  return {
    ...result,
    date,
    sourceDate,
    startDate: date,
    endDate,
    startAt: instant(date, result.start),
    endAt: instant(endDate, result.end),
    cancelled: override?.status === 'cancelled',
    exception: override || null,
    original: { ...lesson, date: sourceDate },
  };
}

/** Occurrences starting on date, including lessons moved in from another date. */
export function lessonsForDate(data, date, scope = {}) {
  const result = [];
  const exceptions = data.exceptions || data.overrides || [];
  const contexts = new Map();
  const byLesson = new Map();
  for (const item of exceptions) {
    if (!byLesson.has(item.lessonId)) byLesson.set(item.lessonId, []);
    byLesson.get(item.lessonId).push(item);
  }
  for (const lesson of data.lessons || []) {
    // Group assignment cannot change in a per-date override; filter before date arithmetic.
    if (!scope.teacherId && scope.groupId && lesson.groupId !== scope.groupId) continue;
    if (!scope.teacherId && scope.subgroup && scope.subgroup !== 'all' && lesson.subgroup !== 'all' && lesson.subgroup !== scope.subgroup) continue;
    const overrides = byLesson.get(lesson.id) || [];
    if (scope.teacherId && lesson.teacherId !== scope.teacherId && !overrides.some(item => item.teacherId === scope.teacherId)) continue;
    if (scheduled(lesson, date, data, contexts)) {
      const override = overrides.find(item => item.date === date);
      if (!override?.targetDate || override.targetDate === date || override.status !== 'moved') {
        const item = occurrence(lesson, date, override);
        if (inScope(item, scope)) result.push(item);
      }
    }
    for (const override of overrides) {
      if (override.lessonId !== lesson.id || override.status !== 'moved' || override.targetDate !== date || override.date === date) continue;
      // The original occurrence must exist, even when its target has another weekday/parity.
      if (scheduled(lesson, override.date, data, contexts) && !holiday(data, date, lesson.groupId)) {
        const item = occurrence(lesson, override.date, override);
        if (inScope(item, scope)) result.push(item);
      }
    }
  }
  return result.sort((a, b) => a.startAt - b.startAt || a.id.localeCompare(b.id));
}

/** Current/next and gaps use half-open intervals: start included, end excluded. */
export function timeline(data, scope = {}, now = new Date()) {
  const at = now.getTime();
  const date = localDate(now);
  const today = lessonsForDate(data, date, scope);
  const active = [...lessonsForDate(data, addDays(date, -1), scope), ...today]
    .filter(item => !item.cancelled);
  const current = active.find(item => item.startAt <= at && at < item.endAt) || null;
  const upcoming = today.filter(item => !item.cancelled && item.startAt > at);
  let next = upcoming[0] || null;
  // One academic year covers semester bounds and summer holidays without an unbounded search.
  for (let offset = 1; !next && offset <= 370; offset++) {
    next = lessonsForDate(data, addDays(date, offset), scope).find(item => !item.cancelled) || null;
  }
  const present = today.filter(item => !item.cancelled);
  const gaps = [];
  let last = null;
  for (const item of present) {
    if (last && item.startAt > last.endAt) gaps.push({
      afterId: last.id,
      beforeId: item.id,
      startAt: last.endAt,
      endAt: item.startAt,
      minutes: Math.round((item.startAt - last.endAt) / 60_000),
    });
    if (!last || item.endAt > last.endAt) last = item;
  }
  return {
    date,
    current,
    next,
    upcoming,
    today,
    gaps,
    progress: current ? Math.max(0, Math.min(1, (at - current.startAt) / (current.endAt - current.startAt))) : 0,
    remainingMinutes: current ? Math.ceil((current.endAt - at) / 60_000) : 0,
    untilNextMinutes: next ? Math.ceil((next.startAt - at) / 60_000) : null,
  };
}
