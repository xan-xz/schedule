import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mutate, visible } from "../backend/core.mjs";
import { facultyChoices } from "../backend/group-state.mjs";
import {
  createTelegramWebhook,
  telegramScheduleMenu,
} from "../backend/telegram-webhook.mjs";
import {
  assertDraftRecoverable,
  recoverChanges,
} from "../app/manage/drafts.mjs";
import { previewScheduleCsv } from "../app/manage/tools.mjs";
import { scheduleWorkbook, readScheduleWorkbook } from "../app/manage/xlsx.mjs";
import { renderInitialChoice } from "../scripts/inline-release-snapshot.mjs";

const seed = JSON.parse(
  await readFile(new URL("../app/seed.json", import.meta.url), "utf8"),
);
const owner = { id: "test-owner", name: "Test owner", role: "admin" };
const guest = {
  id: "guest",
  role: "guest",
  groupId: "g-25-01",
  subgroup: "all",
};
const subject = seed.subjects.find((row) => row.name === "Философия");
const now = new Date("2026-11-23T03:00:00Z");
const records = (menu) => menu.reply_markup.inline_keyboard.flat();
const callback = (menu, label) =>
  records(menu).find((button) => button.text === label)?.callback_data;

test("one faculty workbook creates and assigns groups, survives draft restoration and updates the site and bot together", async () => {
  const draft = mutate(seed, owner, "faculty.save", {
    name: "Факультет науки",
  }).data;
  const faculty = draft.faculties[0];
  const workbook = await readScheduleWorkbook(
    scheduleWorkbook(
      [
        ["Ф-101", 0, "08:00", "08:50", subject.id, "", "", "Лекция"],
        ["Ф-102", 0, "10:00", "10:50", subject.id, "", "", "Лекция", "Г"],
      ],
      [],
      { faculty: true },
    ),
  );
  const sheet = await workbook.readSheet(workbook.sheets[0].id);
  const plan = previewScheduleCsv(sheet.text, draft, {
    facultyId: faculty.id,
    mode: "replace-scope",
    literalReferences: true,
  });
  assert.equal(seed.faculties, undefined);
  assert.equal(draft.groups.length, 19);
  assert.deepEqual(plan.groupChanges, [
    { name: "Ф-101", created: true },
    { name: "Ф-102", created: true },
  ]);
  assert.deepEqual(
    plan.data.lessons.slice(0, seed.lessons.length),
    seed.lessons,
  );
  const changes = assertDraftRecoverable(seed, plan.data);
  const restored = recoverChanges(seed, changes);
  assert.deepEqual(restored.conflicts, []);
  const published = mutate(seed, owner, "import", {
    data: restored.data,
    fromDraft: true,
  }).data;
  const stable = published.groups.find((row) => row.name === "Ф-101");
  const { faculties: _faculties, ...retained } = published;
  const oldImport = mutate(published, owner, "import", {
    data: {
      ...retained,
      groups: retained.groups.map(({ facultyId: _facultyId, ...row }) => row),
    },
  }).data;
  assert.equal(
    oldImport.groups.find((row) => row.id === stable.id).facultyId,
    faculty.id,
  );

  const data = visible(published, guest);
  assert.deepEqual(data.faculties, [{ id: faculty.id, name: faculty.name }]);
  assert.match(renderInitialChoice({ data }), /Факультет науки/);
  assert.deepEqual(
    facultyChoices(data, "Без факультета").map((item) => item.name),
    ["Факультет науки", "Без факультета"],
  );
  const first = await telegramScheduleMenu(data, "", now);
  const groups = await telegramScheduleMenu(
    data,
    callback(first, faculty.name),
    now,
  );
  assert.deepEqual(
    records(groups)
      .slice(0, 2)
      .map((item) => item.text),
    ["Ф-101", "Ф-102"],
  );
  const subgroups = await telegramScheduleMenu(
    data,
    callback(groups, "Ф-102"),
    now,
  );
  const result = await telegramScheduleMenu(
    data,
    callback(subgroups, "Г"),
    now,
  );
  assert.equal(
    callback(subgroups, "‹ К группам"),
    callback(first, faculty.name),
  );
  assert.equal(
    callback(result, "Сменить группу"),
    callback(first, faculty.name),
  );
  assert.match(result.text, /10:00–10:50 · Философия/);
  assert.doesNotMatch(result.text, /08:00/);
  assert.deepEqual(
    result.entities.map(({ offset, length }) =>
      result.text.slice(offset, offset + length),
    ),
    ["📅 Сегодня · Ф-102", "Понедельник, 23 ноября", "10:00–10:50 · Философия"],
  );
  assert.equal(
    records(result).find((item) => item.style === "primary")?.text,
    "✓ Сегодня",
  );
  const week = await telegramScheduleMenu(
    data,
    callback(result, "Неделя"),
    now,
  );
  assert.equal(
    records(week).find((item) => item.style === "primary")?.text,
    "✓ Неделя",
  );
  assert.ok(
    records(result).some((item) => item.url?.includes("subgroup=%D0%93")),
  );
});

test("faculty import replaces only the groups listed in the file and refuses groups belonging to another faculty", () => {
  let data = mutate(seed, owner, "faculty.save", { name: "Факультет А" }).data;
  data = mutate(data, owner, "faculty.save", { name: "Факультет Б" }).data;
  const [first, second] = data.faculties;
  const original = data.lessons.find((lesson) => lesson.groupId === "g-25-01");
  const workbook =
    "group,day,start,end,subject,subgroup\n06-057-25-01,0,08:00,08:50," +
    subject.id +
    ",all";
  const plan = previewScheduleCsv(workbook, data, {
    facultyId: first.id,
    mode: "replace-scope",
  });
  assert.equal(
    plan.data.groups.find((group) => group.id === "g-25-01").facultyId,
    first.id,
  );
  assert.ok(plan.changes.some((change) => change.before?.id === original.id));
  assert.deepEqual(
    plan.data.lessons.filter((lesson) => lesson.groupId !== "g-25-01"),
    data.lessons.filter((lesson) => lesson.groupId !== "g-25-01"),
  );
  assert.throws(
    () =>
      previewScheduleCsv(workbook, plan.data, {
        facultyId: second.id,
        mode: "replace-scope",
      }),
    /другому факультету/,
  );
  assert.throws(() => mutate(data, guest, "faculty.save", { name: "Тест" }), {
    status: 403,
  });
});

test("Telegram webhook handles only verified private updates and reads the published timetable", async () => {
  const secret = "s".repeat(40);
  const calls = [];
  const handler = createTelegramWebhook({
    env: new Map([
      ["TELEGRAM_WEBHOOK_SECRET", secret],
      ["TELEGRAM_BOT_TOKEN", "456789:" + "x".repeat(34)],
      ["SUPABASE_URL", "https://fixture.supabase.co"],
      ["SUPABASE_ANON_KEY", "local-fixture-public-key"],
    ]),
    fetcher: async (url, init) => {
      const path = new URL(url).pathname.split("/").at(-1);
      calls.push({ path, body: JSON.parse(init.body) });
      return Response.json(
        path === "uniflow-api"
          ? { user: guest, data: visible(seed, guest) }
          : { ok: true },
      );
    },
  });
  const request = (header, type = "private", text = "/start") =>
    new Request("https://fixture.invalid/telegram-webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": header },
      body: JSON.stringify({
        update_id: 1,
        message: { chat: { id: 123, type }, from: { id: 123 }, text },
      }),
    });
  assert.equal((await handler(request("wrong"))).status, 403);
  assert.equal((await handler(request(secret, "group"))).status, 204);
  assert.deepEqual(calls, []);
  assert.equal((await handler(request(secret))).status, 204);
  assert.deepEqual(calls[0], {
    path: "uniflow-api",
    body: { action: "state", subgroup: "all" },
  });
  assert.equal(calls[1].path, "sendMessage");
  assert.equal(
    calls[1].body.entities[0].length,
    "📅 Расписание UniFlow".length,
  );
  assert.ok(callback(calls[1].body, "Факультет бизнеса и цифровых технологий"));
  assert.equal(
    callback(calls[1].body, "Связаться с администратором"),
    "contact",
  );
  assert.equal(
    (await handler(request(secret, "private", "/HELP"))).status,
    204,
  );
  assert.equal(calls.length, 3);
  assert.equal(calls[2].path, "sendMessage");
  assert.match(calls[2].body.text, /^Как посмотреть расписание/);
  assert.equal(callback(calls[2].body, "Выбрать группу"), "faculties:0");
  assert.match(calls[2].body.text, /«Факультет бизнеса и цифровых технологий»/);
  assert.equal(
    callback(calls[2].body, "Связаться с администратором"),
    "contact",
  );
});

test("Telegram contact works without schedule access and links only a configured public username", async () => {
  const secret = "v".repeat(40);
  const env = new Map([
    ["TELEGRAM_WEBHOOK_SECRET", secret],
    ["TELEGRAM_BOT_TOKEN", "456789:" + "x".repeat(34)],
  ]);
  const calls = [];
  const handleUpdate = createTelegramWebhook({
    env,
    fetcher: async (url, init) => {
      const endpoint = new URL(url);
      assert.equal(endpoint.origin, "https://api.telegram.org");
      calls.push({
        method: endpoint.pathname.split("/").at(-1),
        payload: JSON.parse(init.body),
      });
      return Response.json({ ok: true });
    },
  });
  const chat = { id: 123, type: "private" };
  const request = (update) =>
    new Request("https://fixture.invalid/telegram-webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
      body: JSON.stringify({ update_id: 1, ...update }),
    });
  const command = (text) =>
    request({ message: { chat, from: { id: 123 }, text } });
  assert.equal((await handleUpdate(command("/contact"))).status, 204);
  const { method, payload } = calls[0];
  assert.equal(method, "sendMessage");
  assert.equal(payload.chat_id, chat.id);
  const email = payload.entities.find((entity) => entity.type === "email");
  assert.ok(email);
  const address = payload.text.slice(email.offset, email.offset + email.length);
  assert.match(address, /^[a-z]+@gmail\.com$/);
  const options = payload.reply_markup.inline_keyboard.flat();
  assert.deepEqual(options[0].copy_text, { text: address });
  assert.equal(options[1].callback_data, "faculties:0");
  assert.ok(options.every((option) => !option.url));

  env.set("UNIFLOW_TELEGRAM_ADMIN_USERNAME", "https://example.invalid/path");
  assert.equal((await handleUpdate(command("/support"))).status, 204);
  assert.ok(
    calls[1].payload.reply_markup.inline_keyboard
      .flat()
      .every((option) => !option.url),
  );

  env.set("UNIFLOW_TELEGRAM_ADMIN_USERNAME", "@FixtureScheduleAdmin");
  const contact = {
    id: "button-id",
    data: "contact:kk",
    from: { id: chat.id },
    message: { chat, message_id: 42 },
  };
  assert.equal(
    (
      await handleUpdate(
        request({ callback_query: { ...contact, from: { id: 124 } } }),
      )
    ).status,
    204,
  );
  assert.equal(calls.length, 2);
  assert.equal(
    (await handleUpdate(request({ callback_query: contact }))).status,
    204,
  );
  assert.deepEqual(calls[2], {
    method: "answerCallbackQuery",
    payload: { callback_query_id: "button-id" },
  });
  assert.equal(calls[3].method, "editMessageText");
  assert.equal(calls[3].payload.chat_id, chat.id);
  assert.equal(calls[3].payload.message_id, 42);
  assert.match(calls[3].payload.text, /^Әкімшімен байланысу/);
  assert.deepEqual(calls[3].payload.reply_markup.inline_keyboard[0], [
    { text: "Telegram арқылы жазу", url: "https://t.me/FixtureScheduleAdmin" },
  ]);
});
