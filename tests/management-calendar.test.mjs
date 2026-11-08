import test from "node:test";
import assert from "node:assert/strict";
import { generateManagementIcs } from "../app/manage/calendar-export.mjs";
import { occurrences } from "../backend/core.mjs";
import { addDays } from "../app/lib/time.mjs";

const data = {
  groups: [{ id: "g", name: "Группа" }],
  subjects: [{ id: "s", name: "Предмет" }],
  rooms: [{ id: "r", name: "204" }],
  teachers: [{ id: "t", name: "Учитель" }],
  lessons: [
    {
      id: "night",
      groupId: "g",
      subgroup: "all",
      subjectId: "s",
      teacherId: "t",
      roomId: "r",
      day: 0,
      week: "all",
      start: "23:30",
      end: "00:20",
      endDayOffset: 1,
    },
  ],
  exceptions: [],
};
const now = new Date("2026-11-06T04:00:00Z");
const rows = (d, start = "2026-11-09", days = 7) =>
  Array.from({ length: days }, (_, n) =>
    occurrences(d, addDays(start, n)),
  ).flat();
const unfolded = (s) => s.replace(/\r\n[ \t]/g, "");
test("owner export encodes a positive overnight interval in UTC and keeps ordinary legacy UID", () => {
  const ics = generateManagementIcs(data, rows(data), now);
  assert.match(ics, /UID:night-2026-11-09@uniflow\r\n/);
  assert.match(ics, /DTSTART:20261109T183000Z\r\nDTEND:20261109T192000Z/);
  assert.match(ics, /DTSTAMP:20261106T040000Z/);
  assert.ok(ics.endsWith("\r\nEND:VCALENDAR\r\n"));
});
test("a moved occurrence keeps its source UID and uses the override's actual date and ending offset", () => {
  const moved = {
    ...data,
    exceptions: [
      {
        lessonId: "night",
        date: "2026-11-09",
        targetDate: "2026-11-10",
        status: "moved",
        start: "14:00",
        end: "15:00",
        endDayOffset: 0,
      },
    ],
  };
  const ics = generateManagementIcs(moved, rows(moved), now);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.match(ics, /UID:night-2026-11-09@uniflow/);
  assert.match(ics, /DTSTART:20261110T090000Z\r\nDTEND:20261110T100000Z/);
});
test("cancelled rows do not export; an empty selection remains a valid empty calendar", () => {
  const cancelled = {
    ...data,
    exceptions: [
      { lessonId: "night", date: "2026-11-09", status: "cancelled" },
    ],
  };
  assert.doesNotMatch(
    generateManagementIcs(cancelled, rows(cancelled), now),
    /BEGIN:VEVENT/,
  );
  assert.match(generateManagementIcs(data, [], now), /^BEGIN:VCALENDAR\r\n/);
});
test("CR LF and punctuation cannot inject iCalendar properties or events", () => {
  const d = structuredClone(data);
  d.subjects[0].name = "Subject\rATTENDEE:bad\nEND:VEVENT\r\nBEGIN:VEVENT";
  d.rooms[0].name = "Room, 1;2\\3";
  d.lessons[0].id = "night\r\nATTENDEE:bad";
  const selected = rows(d);
  selected[0].exception = { date: "2026-11-09\r\nATTENDEE:bad" };
  const ics = unfolded(generateManagementIcs(d, selected, now));
  assert.equal(
    ics.split("\r\n").filter((line) => line === "BEGIN:VEVENT").length,
    1,
  );
  assert.doesNotMatch(ics, /\r\nATTENDEE:/);
  assert.match(ics, /LOCATION:Room\\, 1\\;2\\\\3/);
});
test("long Unicode lines fold by UTF-8 octets and unfold without data loss", () => {
  const d = structuredClone(data);
  d.subjects[0].name = "Қазақша🙂".repeat(20);
  const ics = generateManagementIcs(d, rows(d), now);
  for (const line of ics.split("\r\n"))
    assert.ok(Buffer.byteLength(line, "utf8") <= 75);
  assert.ok(unfolded(ics).includes("SUMMARY:" + d.subjects[0].name));
});
test("only supplied visible rows and teaching labels export; private metadata and inputs stay unchanged", () => {
  const d = structuredClone(data);
  d.accounts = [{ password: "NEVER_EXPORT" }];
  d.rooms[0].note = "PRIVATE_ROOM_NOTE";
  d.lessons[0].source = { raw: "PRIVATE_SOURCE" };
  const selected = rows(d);
  selected[0].exception = { date: "2026-11-09", note: "PRIVATE_EXCEPTION" };
  const before = structuredClone({ d, selected });
  const ics = generateManagementIcs(d, selected, now);
  for (const privateValue of [
    "NEVER_EXPORT",
    "PRIVATE_ROOM_NOTE",
    "PRIVATE_SOURCE",
    "PRIVATE_EXCEPTION",
  ])
    assert.ok(!ics.includes(privateValue));
  assert.deepEqual({ d, selected }, before);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, selected.length);
});
