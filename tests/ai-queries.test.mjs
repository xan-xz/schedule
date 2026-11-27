import assert from "node:assert/strict";
import test from "node:test";
import {
  answerScheduleQuestion,
  parseScheduleQuestion,
} from "../backend/ai-queries.mjs";
import { createTelegramWebhook } from "../backend/telegram-webhook.mjs";

const now = new Date("2026-11-27T08:30:00+05:00");
const groups = [
  { id: "group-a", name: "ИТ-21", subgroups: ["А", "Б"] },
  { id: "group-b", name: "ИТ-210", subgroups: [] },
  { id: "archived", name: "ИТ-22", subgroups: [], archived: true },
];
const lesson = {
  subjectId: "math",
  teacherId: "teacher",
  roomId: "room-a",
  groupId: "group-a",
  day: 4,
  subgroup: "А",
  week: "all",
  type: "Лекция",
  start: "09:00",
  end: "09:50",
};
const data = {
  groups,
  subjects: [
    { id: "math", name: "Математика" },
    { id: "physics", name: "Физика" },
  ],
  teachers: [{ id: "teacher", name: "Иванова А. В." }],
  rooms: [
    { id: "room-a", name: "А101" },
    { id: "room-b", name: "Б201" },
  ],
  lessons: [
    { id: "cancelled", ...lesson },
    { id: "next", ...lesson, start: "10:00", end: "10:50" },
    { id: "other-subgroup", ...lesson, start: "08:45", subgroup: "Б" },
    {
      id: "lab",
      ...lesson,
      subjectId: "physics",
      type: "Лабораторная",
      start: "11:00",
      end: "11:50",
    },
    { id: "tomorrow", ...lesson, day: 5 },
    { id: "other-group", ...lesson, groupId: "group-b" },
  ],
  exceptions: [
    { lessonId: "cancelled", date: "2026-11-27", status: "cancelled" },
    {
      lessonId: "lab",
      date: "2026-11-27",
      targetDate: "2026-11-28",
      status: "moved",
      start: "12:00",
      end: "12:50",
      roomId: "room-b",
    },
  ],
};

test("Russian and Kazakh questions resolve local academic dates", () => {
  assert.equal(
    parseScheduleQuestion("Какая следующая пара?", now).kind,
    "next",
  );
  assert.equal(
    parseScheduleQuestion("Ертең қандай сабақтар бар?", now).date,
    "2026-11-28",
  );
  assert.equal(
    parseScheduleQuestion("Ертең қандай сабақтар бар?", now).language,
    "kk",
  );
  assert.equal(
    parseScheduleQuestion("Что было 12 февраля 2026?", now).date,
    "2026-02-12",
  );
  assert.equal(
    parseScheduleQuestion("Что на следующей неделе?", now).date,
    "2026-11-30",
  );
  assert.equal(
    parseScheduleQuestion("Пары в следующую пятницу", now).date,
    "2026-12-04",
  );
  assert.equal(parseScheduleQuestion("Привет, как дела?", now), null);
  assert.equal(parseScheduleQuestion("/start", now), null);
});

test("answers stay within group, subgroup, lesson type and date", () => {
  const next = answerScheduleQuestion(
    data,
    "Какая следующая пара у ИТ-21, подгруппа А?",
    { now },
  );
  assert.equal(next.groupId, "group-a");
  assert.equal(next.subgroup, "А");
  assert.match(next.lines.join("\n"), /10:00–10:50.*Математика/);
  assert.doesNotMatch(next.lines.join("\n"), /08:45|Отменено/);
  const room = answerScheduleQuestion(
    data,
    "Где завтра лабораторная у ИТ-21?",
    { now },
  );
  assert.match(room.lines.join("\n"), /12:00–12:50.*Физика.*Б201/);
  assert.doesNotMatch(room.lines.join("\n"), /09:00|Математика/);
  const subject = answerScheduleQuestion(
    data,
    "Когда занятие по математике у ИТ-21 на 2026-11-28?",
    { now },
  );
  assert.match(subject.lines.join("\n"), /Математика/);
  assert.doesNotMatch(subject.lines.join("\n"), /Физика/);
  const partial = answerScheduleQuestion(
    {
      ...data,
      subjects: [{ id: "math", name: "Основы Python" }, data.subjects[1]],
    },
    "Где Python завтра у ИТ-21?",
    { now },
  );
  assert.match(partial.lines.join("\n"), /Основы Python/);
  assert.doesNotMatch(partial.lines.join("\n"), /Физика/);
  assert.equal(
    answerScheduleQuestion(data, "Пары завтра для ИТ-210?", { now }).groupId,
    "group-b",
  );
  assert.match(
    answerScheduleQuestion(data, "Пары завтра для ИТ-22?", { now }).lines[0],
    /Укажи группу/,
  );
  assert.match(
    answerScheduleQuestion(data, "Пары завтра у группы ИТ-999?", {
      now,
      context: { groupId: "group-a", subgroup: "А" },
    }).lines[0],
    /Укажи группу/,
  );
  assert.match(
    answerScheduleQuestion(data, "Пары 31.02.2026 для ИТ-21?", { now })
      .lines[0],
    /реальную дату/,
  );
});

test("the change summary deduplicates a move and shows its source and destination", () => {
  const result = answerScheduleQuestion(
    data,
    "Что изменилось на этой неделе у ИТ-21?",
    { now },
  );
  const summary = result.lines.join("\n");
  assert.match(summary, /Отменено/);
  assert.match(
    summary,
    /27 ноября, 11:00–11:50 · А101\n→ 28 ноября, 12:00–12:50 · Б201/,
  );
  assert.equal(summary.match(/Физика/g).length, 1);
});

test("Telegram replies use chat-local bot context and fetch only guest state", async () => {
  const secret = "a".repeat(32);
  const project = "https://fixture.supabase.co";
  const sent = [];
  const req = (reply) =>
    new Request("https://fixture.invalid/telegram", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
      body: JSON.stringify({
        update_id: 1,
        message: {
          chat: { id: 114, type: "private" },
          from: { id: 114 },
          text: "Какая следующая пара?",
          reply_to_message: reply,
        },
      }),
    });
  const handler = createTelegramWebhook({
    now: () => now,
    env: new Map([
      ["TELEGRAM_BOT_TOKEN", "15:" + "a".repeat(20)],
      ["TELEGRAM_WEBHOOK_SECRET", secret],
      ["SUPABASE_URL", project],
      ["SUPABASE_ANON_KEY", "anon"],
    ]),
    fetcher: async (url, options) => {
      const body = JSON.parse(options.body);
      if (url === `${project}/functions/v1/uniflow-api`) {
        assert.deepEqual(body, { action: "state", subgroup: "all" });
        return Response.json({ user: { role: "guest" }, data });
      }
      assert.ok(url.endsWith("/sendMessage"));
      sent.push(body);
      return Response.json({ ok: true });
    },
  });
  const reply = {
    chat: { id: 114 },
    from: { is_bot: true },
    text: "📅 Сегодня · ИТ-21\nПодгруппа А",
  };
  assert.equal((await handler(req(reply))).status, 204);
  assert.match(sent[0].text, /10:00–10:50/);
  assert.equal(sent[0].chat_id, 114);
  assert.equal(
    (await handler(req({ ...reply, chat: { id: 115 } }))).status,
    204,
  );
  assert.match(sent[1].text, /Укажи группу/);
});
