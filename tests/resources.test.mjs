import test from "node:test";
import assert from "node:assert/strict";
import { busyRoomIds } from "../app/manage/resources.mjs";

const fixture = () => ({
  groups: [{ id: "g", name: "Group", subgroups: ["А"] }],
  lessons: [
    {
      id: "night",
      groupId: "g",
      subgroup: "А",
      day: 4,
      week: "all",
      start: "23:00",
      end: "01:00",
      endDayOffset: 1,
      roomId: "r",
    },
  ],
  exceptions: [],
});
const rooms = (data, date, start, end) => [
  ...busyRoomIds(data, date, start, end),
];
test("night occupancy blocks the starting evening and the following morning using Kazakhstan instants", () => {
  const data = fixture();
  assert.deepEqual(rooms(data, "2026-11-06", "23:30", "23:59"), ["r"]);
  assert.deepEqual(rooms(data, "2026-11-07", "00:30", "01:30"), ["r"]);
  assert.deepEqual(rooms(data, "2026-11-07", "12:00", "13:00"), []);
});
test("exact start and end boundaries remain half-open for both day and night classes", () => {
  const data = fixture();
  assert.deepEqual(rooms(data, "2026-11-06", "22:00", "23:00"), []);
  assert.deepEqual(rooms(data, "2026-11-06", "23:00", "23:30"), ["r"]);
  assert.deepEqual(rooms(data, "2026-11-07", "01:00", "02:00"), []);
  Object.assign(data.lessons[0], {
    start: "09:00",
    end: "10:00",
    endDayOffset: 0,
  });
  assert.deepEqual(rooms(data, "2026-11-06", "08:00", "09:00"), []);
  assert.deepEqual(rooms(data, "2026-11-06", "09:30", "10:00"), ["r"]);
  assert.deepEqual(rooms(data, "2026-11-06", "10:00", "11:00"), []);
});
test("cancellation removes both halves of overnight occupancy", () => {
  const data = fixture();
  data.exceptions = [
    { lessonId: "night", date: "2026-11-06", status: "cancelled" },
  ];
  assert.deepEqual(rooms(data, "2026-11-06", "23:30", "23:59"), []);
  assert.deepEqual(rooms(data, "2026-11-07", "00:30", "01:00"), []);
});
test("a moved overnight lesson occupies only its actual target dates and overridden room", () => {
  const data = fixture();
  data.exceptions = [
    {
      lessonId: "night",
      date: "2026-11-06",
      targetDate: "2026-11-08",
      status: "moved",
      roomId: "new",
    },
  ];
  assert.deepEqual(rooms(data, "2026-11-07", "00:30", "01:00"), []);
  assert.deepEqual(rooms(data, "2026-11-08", "23:30", "23:59"), ["new"]);
  assert.deepEqual(rooms(data, "2026-11-09", "00:30", "01:00"), ["new"]);
});
test("archive, restoration, holidays and term bounds use the shared occurrence policy", () => {
  const data = fixture();
  data.groups[0].archivedAt = "2026-11-01T00:00:00Z";
  assert.deepEqual(rooms(data, "2026-11-07", "00:30", "01:00"), []);
  data.groups[0].archivedAt = null;
  assert.deepEqual(rooms(data, "2026-11-07", "00:30", "01:00"), ["r"]);
  data.holidays = [{ groupId: "g", start: "2026-11-06", end: "2026-11-06" }];
  assert.deepEqual(rooms(data, "2026-11-07", "00:30", "01:00"), []);
  data.holidays = [];
  data.validUntil = "2026-11-05";
  assert.deepEqual(rooms(data, "2026-11-07", "00:30", "01:00"), []);
});
test("same-day finder rejects overnight query ranges and malformed values instead of claiming availability", () => {
  for (const args of [
    ["2026-11-06", "23:30", "00:30"],
    ["2026-11-06", "01:00", "01:00"],
    ["2026-02-30", "01:00", "02:00"],
    ["2026-11-06", "25:00", "26:00"],
  ])
    assert.throws(() => busyRoomIds(fixture(), ...args));
});
