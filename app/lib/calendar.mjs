import { addDays, lessonsForDate, localDate } from "./time.mjs";

export function icsEscape(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

/** RFC 5545 folds at 75 UTF-8 octets, never in the middle of a code point. */
export function foldLine(line) {
  const encoder = new TextEncoder();
  const lines = [];
  let current = "";
  let bytes = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (bytes + size > 75) {
      lines.push(current);
      current = " ";
      bytes = 1;
    }
    current += char;
    bytes += size;
  }
  lines.push(current);
  return lines.join("\r\n");
}

const stamp = (at) =>
  new Date(at)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/** Static download; online subscription requires a separately deployed public feed endpoint. */
export function generateIcs(data, scope = {}, options = {}) {
  const {
    startDate = localDate(),
    days = 7,
    reminderMinutes = 0,
    now = new Date(),
  } = options;
  const count = Math.max(1, Math.min(370, Math.trunc(days)));
  const name = (kind, id) =>
    data[kind]?.find((item) => item.id === id)?.name || "";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//UniFlow//Schedule//RU",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-TIMEZONE:Asia/Almaty",
  ];
  for (let offset = 0; offset < count; offset++) {
    for (const lesson of lessonsForDate(
      data,
      addDays(startDate, offset),
      scope,
    )) {
      if (lesson.cancelled) continue;
      // Original date keeps an instance's UID stable when it moves to another date.
      lines.push(
        "BEGIN:VEVENT",
        `UID:${icsEscape(lesson.id)}-${lesson.sourceDate}@uniflow.schedule`,
        `DTSTAMP:${stamp(now)}`,
        `DTSTART:${stamp(lesson.startAt)}`,
        `DTEND:${stamp(lesson.endAt)}`,
        `SUMMARY:${icsEscape(name("subjects", lesson.subjectId))}`,
        `LOCATION:${icsEscape(name("rooms", lesson.roomId))}`,
        `DESCRIPTION:${icsEscape([name("groups", lesson.groupId), name("teachers", lesson.teacherId), lesson.type].filter(Boolean).join(" · "))}`,
      );
      if (
        Number.isInteger(reminderMinutes) &&
        reminderMinutes > 0 &&
        reminderMinutes <= 1440
      ) {
        lines.push(
          "BEGIN:VALARM",
          `TRIGGER:-PT${reminderMinutes}M`,
          "ACTION:DISPLAY",
          `DESCRIPTION:${icsEscape(name("subjects", lesson.subjectId))}`,
          "END:VALARM",
        );
      }
      lines.push("END:VEVENT");
    }
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
