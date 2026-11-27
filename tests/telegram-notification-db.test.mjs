import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { addDays, dayOf, localDate } from "../app/lib/time.mjs";

const load = (path) => readFile(new URL(path, import.meta.url), "utf8");
const migration =
  "../supabase/migrations/20261127141150_telegram_schedule_notifications.sql";
const originalDate = addDays(localDate(), 2);
const newDate = addDays(originalDate, 1);
const originalLesson = {
  id: "lesson-a",
  groupId: "group-a",
  subgroup: "А",
  semester: 1,
  day: dayOf(originalDate),
  week: "all",
  start: "08:00",
  end: "08:50",
  subjectId: "subject-a",
  roomId: "room-a",
  teacherId: "teacher-a",
  type: "Лекция",
};
const schedule = {
  groups: [
    { id: "group-a", name: "Группа 20", subgroups: ["А", "Б"] },
    { id: "group-b", name: "Группа 21", subgroups: [] },
  ],
  lessons: [
    originalLesson,
    { ...originalLesson, id: "lesson-all", subgroup: "all" },
  ],
  subjects: [{ id: "subject-a", name: "Математика" }],
  rooms: [
    { id: "room-a", name: "204" },
    { id: "room-b", name: "209" },
  ],
  teachers: [{ id: "teacher-a", name: "Тестовый преподаватель" }],
  exceptions: [],
  tasks: [],
  announcements: [],
  requests: [],
  attendance: [],
  history: [],
};
const moved = {
  id: "exception-moved",
  lessonId: "lesson-a",
  date: originalDate,
  targetDate: newDate,
  status: "moved",
  start: "09:00",
  end: "09:50",
  roomId: "room-b",
};
const cancelled = {
  id: "exception-cancelled",
  lessonId: "lesson-all",
  date: originalDate,
  status: "cancelled",
};

let db;
before(async () => {
  db = new PGlite();
  await db.exec(await load("./fixtures/managed-auth-schema.sql"));
  await db.exec(await load("../backend/fresh-project-bootstrap.sql"));
  await db.exec(await load(migration));
});
after(async () => {
  await db?.close();
});

async function withFixture(run) {
  await db.exec("begin;");
  try {
    await db.exec("set local role service_role;");
    await publish(schedule);
    await run();
  } finally {
    await db.exec("rollback;");
  }
}

async function publish(data) {
  const { rows } = await db.query(
    "select revision from public.uf_platform where id=1",
  );
  const result = await db.query(
    "select public.uf_commit($1,$2::jsonb,'Тест','Публикация тестовой версии') as document",
    [rows[0].revision, JSON.stringify(data)],
  );
  return result.rows[0].document.revision;
}

async function subscription(
  chat,
  update = null,
  group = null,
  subgroup = null,
) {
  const { rows } = await db.query(
    "select public.uf_telegram_subscription($1::bigint,$2::bigint,$3::text,$4::text) as subscription",
    [chat, update, group, subgroup],
  );
  return rows[0].subscription;
}

async function claim() {
  const { rows } = await db.query(
    "select * from public.uf_telegram_claim_notifications(12)",
  );
  return rows;
}

async function finish(record, result = "sent", delay = 0) {
  const { rows } = await db.query(
    "select public.uf_telegram_finish_notification($1::uuid,$2::uuid,$3::text,$4::integer) as acknowledged",
    [record.id, record.lease_token, result, delay],
  );
  return rows[0].acknowledged;
}

async function drain() {
  const events = [];
  for (let i = 0; i < 12; i++) {
    const rows = await claim();
    if (!rows.length) return events;
    for (const row of rows) {
      assert.ok(row.lease_token);
      events.push(row);
      assert.equal(await finish(row), true);
    }
  }
  assert.fail("Queue does not drain");
}

test("canonical publication delivers only affected group and subgroup events", async () => {
  await withFixture(async () => {
    await subscription(110, 1, "group-a", "А");
    await subscription(111, 1, "group-a", "Б");
    await subscription(112, 1, "group-a", "all");
    await subscription(113, 1, "group-b", "all");
    assert.deepEqual(await claim(), []);
    // Rollback of the database transaction also removes the pending notices.
    await db.exec("savepoint failed_publication;");
    await publish({ ...schedule, exceptions: [moved, cancelled] });
    assert.ok((await claim()).length);
    await db.exec("rollback to failed_publication;");
    assert.deepEqual(await claim(), []);

    await publish({ ...schedule, exceptions: [moved, cancelled] });
    const events = await drain();
    assert.deepEqual(
      events.map((row) => `${row.chat_id}:${row.payload.status}`).sort(),
      [
        "110:cancelled",
        "110:moved",
        "111:cancelled",
        "112:cancelled",
        "112:moved",
      ],
    );
    const move = events.find((row) => row.payload.status === "moved").payload;
    assert.equal(move.groupName, "Группа 20");
    assert.equal(move.subject, "Математика");
    assert.equal(move.originalDate, originalDate);
    assert.equal(move.originalStart, "08:00");
    assert.equal(move.originalEnd, "08:50");
    assert.equal(move.originalRoom, "204");
    assert.equal(move.date, newDate);
    assert.equal(move.start, "09:00");
    assert.equal(move.end, "09:50");
    assert.equal(move.room, "209");
    assert.equal(move.subgroup, "А");

    await publish({ ...schedule, exceptions: [moved, cancelled] });
    await publish({
      ...schedule,
      exceptions: [
        {
          ...moved,
          note: "Тестовая правка заметки",
          updatedAt: "2026-01-01",
          actor: "Иное имя",
        },
        cancelled,
      ],
      history: [{ message: "Тестовая запись журнала" }],
    });
    assert.deepEqual(await claim(), []);
  });
});

test("a reverted or superseded queued exception is never sent as a current change", async () => {
  await withFixture(async () => {
    await subscription(120, 1, "group-a", "all");
    await publish({ ...schedule, exceptions: [moved] });
    await publish(schedule);
    assert.deepEqual(await claim(), []);

    await publish({ ...schedule, exceptions: [moved] });
    const rescheduled = { ...moved, start: "10:00", end: "10:50" };
    await publish({ ...schedule, exceptions: [rescheduled] });
    const events = await drain();
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.start, "10:00");
    assert.equal(events[0].payload.status, "moved");
  });
});

test("Telegram updates are idempotent and old callbacks cannot overwrite a choice", async () => {
  await withFixture(async () => {
    assert.equal(await subscription(130), null);
    await subscription(130, 10, "group-a", "А");
    await subscription(130, 10, "group-a", "Б");
    await subscription(130, 9, "group-b", "all");
    await publish({ ...schedule, exceptions: [moved] });
    const deliveries = await drain();
    assert.equal(deliveries.length, 1);
    assert.equal(Number(deliveries[0].chat_id), 130);

    await subscription(130, 11);
    await subscription(130, 10, "group-a", "А");
    await publish({ ...schedule, exceptions: [cancelled] });
    assert.deepEqual(await claim(), []);
  });
});

test("blocked chats stop receiving and only explicit opt-in enables them again", async () => {
  await withFixture(async () => {
    await subscription(140, 1, "group-a", "all");
    await publish({ ...schedule, exceptions: [moved] });
    const [delivery] = await claim();
    assert.equal(Number(delivery.chat_id), 140);
    assert.deepEqual(await claim(), []);
    await finish(delivery, "blocked");
    await subscription(140, 1, "group-a", "all");
    await publish({ ...schedule, exceptions: [cancelled] });
    assert.deepEqual(await claim(), []);

    await subscription(140, 2, "group-a", "all");
    await publish({ ...schedule, exceptions: [moved] });
    const [newDelivery] = await claim();
    assert.equal(Number(newDelivery.chat_id), 140);
    await finish(newDelivery);
    assert.deepEqual(await claim(), []);
  });
});

test("expired leases are reclaimed while acknowledged retries respect their delay", async () => {
  await withFixture(async () => {
    await subscription(160, 1, "group-a", "all");
    await publish({ ...schedule, exceptions: [moved] });
    const [first] = await claim();
    assert.equal(first.attempts, 1);
    assert.deepEqual(await claim(), []);
    await db.query(
      "update public.uf_telegram_outbox set lease_until=now()-interval '1 second' where id=$1",
      [first.id],
    );
    const [reclaimed] = await claim();
    assert.equal(reclaimed.id, first.id);
    assert.notEqual(reclaimed.lease_token, first.lease_token);
    assert.equal(reclaimed.attempts, 2);
    assert.equal(await finish(first), false);
    assert.equal(await finish(reclaimed, "retry", 43), true);
    assert.deepEqual(await claim(), []);
    const { rows } = await db.query(
      "select (extract(epoch from available_at-now()))::integer as seconds from public.uf_telegram_outbox where id=$1",
      [reclaimed.id],
    );
    assert.equal(rows[0].seconds, 43);
    await db.query(
      "update public.uf_telegram_outbox set available_at=now()-interval '1 second' where id=$1",
      [reclaimed.id],
    );
    const [retry] = await claim();
    assert.equal(retry.attempts, 3);
    assert.equal(await finish(retry), true);
    assert.deepEqual(await claim(), []);
  });
});

test("public roles cannot invoke the private notification RPCs", async () => {
  for (const role of ["anon", "authenticated"]) {
    await db.exec("set role " + role + ";");
    try {
      await assert.rejects(subscription(150, 1, "group-a", "all"), {
        code: "42501",
      });
      await assert.rejects(claim(), { code: "42501" });
      await assert.rejects(
        db.query("select chat_id from public.uf_telegram_subscriptions"),
        { code: "42501" },
      );
      await assert.rejects(
        db.query("select payload from public.uf_telegram_outbox"),
        {
          code: "42501",
        },
      );
      const token = "00000000-0000-0000-0000-000000000000";
      await assert.rejects(finish({ id: token, lease_token: token }), {
        code: "42501",
      });
    } finally {
      await db.exec("reset role;");
    }
  }
});
