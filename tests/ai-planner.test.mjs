import assert from "node:assert/strict";
import test from "node:test";
import { planFacultySchedule, proposeLessonMoves } from "../app/ai-planner.mjs";
import { mutate, occurrences, validate } from "../app/core.mjs";

const owner = { role: "admin", name: "Владелец" };
const sourceDate = "2026-11-02";
const targetDate = "2026-11-03";

function lesson(id, fields = {}) {
  return {
    id,
    day: 0,
    week: "all",
    start: "08:00",
    end: "09:40",
    groupId: "group-a",
    subgroup: "all",
    subjectId: "programming",
    teacherId: "teacher-a",
    roomId: "room-a",
    type: "Лекция",
    ...fields,
  };
}

function dataWith(...lessons) {
  return {
    faculties: [
      { id: "faculty-a", name: "Факультет А" },
      { id: "faculty-b", name: "Факультет Б" },
    ],
    groups: [
      {
        id: "group-a",
        name: "А-01",
        subgroups: ["А", "Б"],
        facultyId: "faculty-a",
      },
      {
        id: "group-b",
        name: "Б-01",
        subgroups: ["А", "Б"],
        facultyId: "faculty-b",
      },
    ],
    teachers: [
      { id: "teacher-a", name: "Преподаватель А", subjects: ["programming"] },
      { id: "teacher-b", name: "Преподаватель Б", subjects: ["programming"] },
    ],
    subjects: [
      { id: "programming", name: "Программирование", color: "#7957d5" },
    ],
    rooms: [
      { id: "room-a", name: "101", capacity: 30 },
      { id: "room-b", name: "102", capacity: 50, capacityEstimated: true },
    ],
    lessons,
    exceptions: [],
    tasks: [],
    announcements: [],
    requests: [],
    attendance: [],
    history: [],
    validFrom: "2026-11-01",
    validUntil: "2026-12-01",
  };
}

test("one-off suggestions respect calendar dates, overnight pairs and each resource", () => {
  const original = lesson("source");
  const timetable = dataWith(
    original,
    lesson("late-room", {
      start: "23:50",
      end: "00:40",
      endDayOffset: 1,
      groupId: "group-b",
      teacherId: "teacher-b",
    }),
    lesson("busy-group", {
      day: 1,
      subgroup: "Б",
      teacherId: "teacher-b",
      roomId: "room-b",
    }),
    lesson("busy-room", {
      day: 1,
      start: "10:40",
      end: "12:20",
      groupId: "group-b",
      teacherId: "teacher-b",
    }),
    lesson("busy-teacher", {
      day: 1,
      start: "13:20",
      end: "15:00",
      groupId: "group-b",
      roomId: "room-b",
    }),
  );
  timetable.holidays = [
    { start: "2026-11-04", end: "2026-11-04", groupId: "group-a" },
  ];
  validate(timetable);
  const snapshot = structuredClone(timetable);
  const result = proposeLessonMoves(timetable, {
    lessonId: original.id,
    date: sourceDate,
    dates: [targetDate, "2026-11-04", "2026-12-02"],
    starts: ["00:00", "08:00", "10:40", "13:20", "15:00"],
    roomIds: ["room-a", "room-b"],
    minimumCapacity: 25,
  });
  assert.deepEqual(
    result.suggestions.map(({ date, start, end, roomId }) => [
      date,
      start,
      end,
      roomId,
    ]),
    [[targetDate, "15:00", "16:40", "room-a"]],
  );
  assert.deepEqual(timetable, snapshot);
  const saved = mutate(
    timetable,
    owner,
    "exception.save",
    result.suggestions[0].payload,
  ).data;
  assert.deepEqual(saved.lessons, snapshot.lessons);
  assert.equal(
    occurrences(saved, targetDate).find((item) => item.id === original.id)
      .start,
    "15:00",
  );
  assert.equal(
    occurrences(saved, sourceDate).some((item) => item.id === original.id),
    false,
  );
});

test("rescheduling an existing one-off move retains its original date and special fields", () => {
  const before = dataWith(lesson("source"));
  const timetable = mutate(before, owner, "exception.save", {
    lessonId: "source",
    date: sourceDate,
    targetDate,
    status: "moved",
    start: "10:00",
    end: "10:45",
    teacherId: "teacher-b",
    roomId: "room-b",
    type: "Семинар",
    note: "Смена аудитории",
  }).data;
  const result = proposeLessonMoves(timetable, {
    lessonId: "source",
    date: sourceDate,
    dates: ["2026-11-04"],
    starts: ["11:00"],
  });
  const payload = result.suggestions[0].payload;
  assert.equal(payload.date, sourceDate);
  assert.equal(payload.targetDate, "2026-11-04");
  assert.equal(payload.end, "11:45");
  assert.equal(payload.note, "Смена аудитории");
  assert.equal(payload.teacherId, "teacher-b");
  assert.equal(payload.roomId, "room-b");
  assert.equal(payload.type, "Семинар");
  assert.equal(timetable.exceptions[0].targetDate, targetDate);
});

test("faculty drafts keep linked and out-of-scope lessons fixed and find a verified combination", () => {
  const first = lesson("first");
  const second = lesson("second", {
    start: "10:00",
    end: "10:50",
    teacherId: "teacher-b",
  });
  const linked = lesson("linked", { day: 2, start: "14:00", end: "14:50" });
  const shared = lesson("shared", {
    start: "12:00",
    end: "12:50",
    sharedSessionId: "joint-session",
  });
  const sharedPeer = { ...shared, id: "shared-peer", groupId: "group-b" };
  const outside = lesson("outside", {
    day: 1,
    start: "08:00",
    end: "09:40",
    groupId: "group-b",
  });
  const timetable = dataWith(
    first,
    second,
    linked,
    shared,
    sharedPeer,
    outside,
  );
  timetable.exceptions.push({
    lessonId: "linked",
    date: "2026-11-04",
    status: "cancelled",
  });
  validate(timetable);
  const snapshot = structuredClone(timetable);
  const plan = planFacultySchedule(timetable, {
    facultyId: "faculty-a",
    days: [1],
    starts: ["08:00", "10:00", "11:40"],
  });
  assert.equal(plan.status, "planned");
  assert.deepEqual(plan.lockedLessonIds, ["linked", "shared"]);
  assert.equal(plan.changes.length, 2);
  assert.ok(
    plan.changes.every(
      ({ after }) => after.day === 1 && after.start !== "08:00",
    ),
  );
  const merged = timetable.lessons.map(
    (item) =>
      plan.changes.find((change) => change.before.id === item.id)?.after ||
      item,
  );
  validate({ ...timetable, lessons: merged });
  assert.deepEqual(merged.slice(2), snapshot.lessons.slice(2));
  assert.deepEqual(timetable, snapshot);
});

test("faculty planner reports unavailable without producing partial changes", () => {
  const timetable = dataWith(lesson("first"), lesson("second", { day: 1 }));
  const plan = planFacultySchedule(timetable, {
    facultyId: "faculty-a",
    days: [2],
    starts: ["10:00"],
  });
  assert.equal(plan.status, "unavailable");
  assert.deepEqual(plan.changes, []);
});
