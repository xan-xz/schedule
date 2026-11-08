import { addDays, instant } from "../lib/time.mjs";
import { foldLine, icsEscape } from "../lib/calendar.mjs";

const stamp = (at) =>
  new Date(at)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/** Serialize the exact dated rows selected by the workspace, without private metadata. */
export function generateManagementIcs(data, rows, now = new Date()) {
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
  const created = stamp(now);
  for (const lesson of rows) {
    if (lesson.cancelled) continue;
    const sourceDate = lesson.exception?.date || lesson.date;
    const endDate = addDays(lesson.date, Number(lesson.endDayOffset || 0));
    lines.push(
      "BEGIN:VEVENT",
      `UID:${icsEscape(`${lesson.id}-${sourceDate}@uniflow`)}`,
      `DTSTAMP:${created}`,
      `DTSTART:${stamp(instant(lesson.date, lesson.start))}`,
      `DTEND:${stamp(instant(endDate, lesson.end))}`,
      `SUMMARY:${icsEscape(name("subjects", lesson.subjectId))}`,
      `LOCATION:${icsEscape(name("rooms", lesson.roomId))}`,
      `DESCRIPTION:${icsEscape([name("groups", lesson.groupId), name("teachers", lesson.teacherId)].filter(Boolean).join(" · "))}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
