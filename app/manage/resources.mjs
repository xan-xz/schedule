import { addDays, instant, lessonsForDate, validDate } from "../lib/time.mjs";

const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** Half-open room occupancy for a same-day query, including the previous night. */
export function busyRoomIds(data, date, start, end) {
  if (!validDate(date) || !clock.test(start) || !clock.test(end))
    throw Error("Проверь дату и время поиска.");
  if (start >= end) throw Error("Конец должен быть позже начала");
  const from = instant(date, start),
    until = instant(date, end),
    busy = new Set();
  for (const day of [addDays(date, -1), date])
    for (const lesson of lessonsForDate(data, day))
      if (
        !lesson.cancelled &&
        lesson.roomId &&
        lesson.startAt < until &&
        lesson.endAt > from
      )
        busy.add(lesson.roomId);
  return busy;
}
