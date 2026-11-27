import test from "node:test";
import assert from "node:assert/strict";
import { createTelegramWebhook } from "../backend/telegram-webhook.mjs";
import { PUBLIC_DEFAULT_FACULTY_LABELS } from "../backend/group-state.mjs";

const buttons = (menu) => menu.reply_markup.inline_keyboard.flat();
const action = (menu, title) =>
  buttons(menu).find((button) => button.text === title)?.callback_data;

function fixture({ enabled = true } = {}) {
  const webhookSecret = "t".repeat(48);
  const chat = { id: 777, type: "private" };
  const schedule = {
    groups: [
      { id: "grp-test-one", name: "Тест-01", subgroups: ["А", "Б"] },
      { id: "grp-test-two", name: "Тест-02", subgroups: [] },
    ],
    lessons: [],
    subjects: [],
    rooms: [],
    teachers: [],
  };
  const subscriptions = new Map();
  const reads = [];
  const changes = [];
  const sent = [];
  const handler = createTelegramWebhook({
    now: () => new Date("2026-11-23T03:00:00Z"),
    env: new Map([
      ["TELEGRAM_WEBHOOK_SECRET", webhookSecret],
      ["TELEGRAM_BOT_TOKEN", "517:" + "q".repeat(30)],
      ["SUPABASE_URL", "https://fixture.supabase.co"],
      ["SUPABASE_ANON_KEY", "local-fixture-public-key"],
    ]),
    notifications: enabled
      ? {
          get: async ({ chatId }) => subscriptions.get(chatId) || null,
          subscribe: async ({ chatId, groupId, subgroup, updateId }) => {
            changes.push({ chatId, groupId, subgroup, updateId });
            subscriptions.set(chatId, { groupId, subgroup });
          },
          unsubscribe: async ({ chatId, updateId }) => {
            changes.push({ chatId, updateId });
            subscriptions.delete(chatId);
          },
        }
      : undefined,
    fetcher: async (url, init) => {
      const method = new URL(url).pathname.split("/").at(-1);
      const body = JSON.parse(init.body);
      if (method === "uniflow-api") {
        reads.push(body);
        return Response.json({ user: { role: "guest" }, data: schedule });
      }
      sent.push({ method, body });
      return Response.json({ ok: true });
    },
  });
  let count = 0;
  const request = (input, secret = webhookSecret) =>
    handler(
      new Request("https://fixture.invalid/webhook", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
        body: JSON.stringify({ update_id: ++count, ...input }),
      }),
    );
  const command = (text) =>
    request({ message: { chat, from: { id: chat.id }, text } });
  const click = (data, { actor = chat.id, type = "private", secret } = {}) =>
    request(
      {
        callback_query: {
          id: "test-button",
          data,
          message: { chat: { ...chat, type }, message_id: 42 },
          from: { id: actor },
        },
      },
      secret,
    );
  const last = () => sent.at(-1)?.body;
  return {
    click,
    command,
    last,
    schedule,
    reads,
    sent,
    changes,
    subscriptions,
  };
}

test("Telegram subscribes only on explicit confirmation, tracks one scope, and lets the student opt out", async () => {
  const { command, click, last, reads, sent, changes } = fixture();
  assert.equal((await command("/subscribe")).status, 204);
  assert.match(last().text, /Подписка выключена/);
  await click(action(last(), "Выбрать группу"));
  assert.ok(action(last(), "🔔 Уведомления"));
  const faculty = action(last(), PUBLIC_DEFAULT_FACULTY_LABELS.ru);
  await click(faculty);
  await click(action(last(), "Тест-01"));
  await click(action(last(), "Б"));
  await click(action(last(), "🔔 Уведомления"));
  assert.match(last().text, /Тест-01 · подгруппа Б/);
  assert.match(last().text, /перенос или отмену пары опубликуют/);
  assert.deepEqual(changes, []);
  await click(action(last(), "Подписаться на эту группу"));
  assert.match(last().text, /Подписка включена: Тест-01 · подгруппа Б/);
  assert.deepEqual(changes, [
    { chatId: 777, groupId: "grp-test-one", subgroup: "Б", updateId: 7 },
  ]);
  assert.equal(sent.at(-2).method, "answerCallbackQuery");
  assert.equal(sent.at(-1).method, "editMessageText");
  assert.equal(last().chat_id, 777);
  assert.equal(last().message_id, 42);

  await click(faculty);
  await click(action(last(), "Тест-02"));
  await click(action(last(), "🔔 Уведомления"));
  assert.match(last().text, /Новая подписка заменит текущую/);
  assert.equal(changes.length, 1);
  await click(action(last(), "Подписаться на эту группу"));
  await command("/notifications");
  assert.match(last().text, /Подписка включена: Тест-02/);
  assert.doesNotMatch(last().text, /Тест-01/);
  assert.deepEqual(changes.at(-1), {
    chatId: 777,
    groupId: "grp-test-two",
    subgroup: "all",
    updateId: 11,
  });
  assert.ok(reads.every((item) => item.action === "state" && !item.token));
  const before = reads.length;
  await click(action(last(), "Отключить уведомления"));
  assert.match(last().text, /Уведомления отключены/);
  assert.deepEqual(changes.at(-1), { chatId: 777, updateId: 13 });
  assert.equal(reads.length, before);
  await command("/unsubscribe");
  assert.match(last().text, /Уведомления отключены/);
  assert.deepEqual(changes.at(-1), { chatId: 777, updateId: 14 });
  assert.equal(reads.length, before);
});

test("Telegram rejects unverified, cross-chat, group, and stale subscription updates", async () => {
  const { command, click, last, schedule, sent, changes } = fixture();
  await command("/start");
  await click(action(last(), PUBLIC_DEFAULT_FACULTY_LABELS.ru));
  await click(action(last(), "Тест-02"));
  await click(action(last(), "🔔 Уведомления"));
  const confirm = action(last(), "Подписаться на эту группу");
  const before = sent.length;
  assert.equal((await click(confirm, { secret: "wrong" })).status, 403);
  assert.equal((await click(confirm, { actor: 778 })).status, 204);
  assert.equal((await click(confirm, { type: "group" })).status, 204);
  assert.equal((await click(123)).status, 204);
  assert.equal(sent.length, before);
  schedule.groups.at(-1).archived = true;
  assert.equal((await click(confirm)).status, 204);
  assert.match(last().text, /группа или подгруппа больше недоступна/);
  assert.deepEqual(changes, []);
});

test("Telegram explains when notifications are unavailable without breaking the usual menus", async () => {
  const { command, click, last, reads, sent } = fixture({ enabled: false });
  assert.equal((await command("/notifications")).status, 204);
  assert.match(last().text, /Уведомления пока недоступны/);
  assert.equal((await click("notifications")).status, 204);
  assert.equal(sent.at(-2).method, "answerCallbackQuery");
  assert.match(last().text, /Уведомления пока недоступны/);
  assert.equal(reads.length, 0);
  assert.equal((await command("/start")).status, 204);
  assert.ok(action(last(), PUBLIC_DEFAULT_FACULTY_LABELS.ru));
  assert.ok(action(last(), "Связаться с администратором"));
  assert.equal(action(last(), "🔔 Уведомления"), undefined);
});
