import test from "node:test";
import assert from "node:assert/strict";
import { foldLine, generateIcs, icsEscape } from "../app/lib/calendar.mjs";

const data = {
  groups: [{ id: "g", name: "Группа А" }],
  subjects: [{ id: "s", name: "Алгоритмы, часть 1; «Практика»\nТест" }],
  rooms: [{ id: "r", name: "204" }],
  teachers: [],
  exceptions: [],
  lessons: [
    {
      id: "lesson-1",
      groupId: "g",
      subgroup: "all",
      day: 0,
      week: "all",
      start: "23:30",
      end: "00:20",
      endDayOffset: 1,
      roomId: "r",
      subjectId: "s",
    },
  ],
};
const options = {
  startDate: "2026-11-09",
  days: 7,
  now: new Date("2026-11-06T00:00:00Z"),
};

test("calendar escapes text and uses correct UTC timestamps across midnight", () => {
  const ics = generateIcs(
    data,
    { groupId: "g" },
    { ...options, reminderMinutes: 10 },
  );
  assert.match(ics, /DTSTART:20261109T183000Z/);
  assert.match(ics, /DTEND:20261109T192000Z/);
  assert.match(ics, /UID:lesson-1-2026-11-09@uniflow.schedule/);
  assert.match(ics, /Алгоритмы\\, часть 1\\;/);
  assert.match(ics, /TRIGGER:-PT10M/);
  assert.ok(ics.endsWith("\r\n"));
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
});

test("UTF-8 line folding never exceeds 75 octets and unfolds identically", () => {
  const source = `SUMMARY:${"Казахский ӘӨҚ🙂".repeat(20)}`;
  const folded = foldLine(source);
  for (const line of folded.split("\r\n"))
    assert.ok(Buffer.byteLength(line, "utf8") <= 75);
  assert.equal(folded.replace(/\r\n /g, ""), source);
  assert.equal(icsEscape("a\\b,c;d\ne"), "a\\\\b\\,c\\;d\\ne");
});

test("cancellation removes event and moving preserves original instance UID", () => {
  const cancelled = {
    ...data,
    exceptions: [
      { lessonId: "lesson-1", date: "2026-11-09", status: "cancelled" },
    ],
  };
  assert.doesNotMatch(generateIcs(cancelled, {}, options), /BEGIN:VEVENT/);
  const moved = {
    ...data,
    exceptions: [
      {
        lessonId: "lesson-1",
        date: "2026-11-09",
        targetDate: "2026-11-10",
        status: "moved",
        start: "14:00",
        end: "15:00",
        endDayOffset: 0,
      },
    ],
  };
  const ics = generateIcs(moved, {}, options);
  assert.match(ics, /UID:lesson-1-2026-11-09@uniflow.schedule/);
  assert.match(ics, /DTSTART:20261110T090000Z/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
});

test("semester range, group filter and invalid reminder limits are enforced", () => {
  const bounded = {
    ...data,
    lessons: [{ ...data.lessons[0], validUntil: "2026-11-16" }],
  };
  assert.equal(
    (
      generateIcs(bounded, {}, { ...options, days: 100 }).match(
        /BEGIN:VEVENT/g,
      ) || []
    ).length,
    2,
  );
  assert.doesNotMatch(
    generateIcs(data, { groupId: "other" }, options),
    /BEGIN:VEVENT/,
  );
  assert.doesNotMatch(
    generateIcs(data, {}, { ...options, reminderMinutes: 2000 }),
    /VALARM/,
  );
});
