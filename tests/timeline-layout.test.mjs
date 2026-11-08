import test from "node:test";
import assert from "node:assert/strict";
import { timelineDay } from "../app/layouts/timeline.mjs";
const scope = { groupId: "g", subgroup: "А" };
const night = {
  id: "night",
  groupId: "g",
  subgroup: "А",
  day: 4,
  week: "all",
  start: "23:00",
  end: "01:00",
  endDayOffset: 1,
};
const model = (lessons = [night], exceptions = []) => ({ lessons, exceptions });

test("the actual day carries the shared previous-night current only until its exclusive end", () => {
  const data = model();
  const started = timelineDay(
    data,
    "2026-11-06",
    scope,
    new Date("2026-11-06T23:00:00+05:00"),
  );
  assert.equal(started.current.id, "night");
  assert.deepEqual(
    started.lessons.map((l) => l.id),
    ["night"],
  );
  const active = timelineDay(
    data,
    "2026-11-07",
    scope,
    new Date("2026-11-07T00:30:00+05:00"),
  );
  assert.equal(active.current.id, "night");
  assert.deepEqual(
    active.lessons.map((l) => l.id),
    ["night"],
  );
  assert.equal(active.lessons[0].sourceDate, "2026-11-06");
  assert.equal(active.lessons[0].endDate, "2026-11-07");
  const ended = timelineDay(
    data,
    "2026-11-07",
    scope,
    new Date("2026-11-07T01:00:00+05:00"),
  );
  assert.equal(ended.current, null);
  assert.deepEqual(ended.lessons, []);
});

test("a current occurrence starting today is listed once, and browsing another date adds no foreign current", () => {
  const sameDay = {
    ...night,
    id: "today",
    day: 5,
    start: "00:00",
    endDayOffset: 0,
  };
  const data = model([sameDay]);
  const now = new Date("2026-11-07T00:30:00+05:00");
  const active = timelineDay(data, "2026-11-07", scope, now);
  assert.equal(active.current.id, "today");
  assert.deepEqual(
    active.lessons.map((l) => l.id),
    ["today"],
  );
  const other = timelineDay(data, "2026-11-06", scope, now);
  assert.equal(other.current, null);
  assert.deepEqual(other.lessons, []);
});

test("cancelled or other-subgroup overnight occurrences cannot become a current day row", () => {
  const now = new Date("2026-11-07T00:30:00+05:00");
  for (const data of [
    model(
      [night],
      [{ lessonId: "night", date: "2026-11-06", status: "cancelled" }],
    ),
    model([{ ...night, subgroup: "Б" }]),
  ]) {
    const selected = timelineDay(data, "2026-11-07", scope, now);
    assert.equal(selected.current, null);
    assert.deepEqual(selected.lessons, []);
  }
});
