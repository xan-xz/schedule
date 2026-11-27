import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createTelegramSupportStore } from "../backend/telegram-support-store.mjs";
import { createTelegramWebhook } from "../backend/telegram-webhook.mjs";

const migration = new URL(
  "../supabase/migrations/20261127144614_telegram_support.sql",
  import.meta.url,
);
const sqlFields = [
  "p_action",
  "p_chat_id",
  "p_update_id",
  "p_group_id",
  "p_language",
  "p_report_id",
  "p_message_id",
  "p_lease_token",
];
const owner = "401";
const student = "402";
let db;
let store;

async function rpc(args) {
  const { rows } = await db.query(
    "select public.uf_telegram_support($1,$2,$3,$4,$5,$6,$7,$8) as result",
    sqlFields.map((field) => args[field] ?? null),
  );
  return rows[0].result;
}

before(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated;
    create role service_role bypassrls;`);
  await db.exec(await readFile(migration, "utf8"));
  store = createTelegramSupportStore({
    env: new Map([
      ["SUPABASE_URL", "https://project.supabase.co"],
      ["SUPABASE_SECRET_KEYS", '{"default":"sb_secret_test"}'],
    ]),
    fetcher: async (url, request) => {
      assert.equal(
        url.href,
        "https://project.supabase.co/rest/v1/rpc/uf_telegram_support",
      );
      assert.equal(request.headers.apikey, "sb_secret_test");
      return Response.json(await rpc(JSON.parse(request.body)));
    },
  });
});

after(async () => db?.close());

test("support RPC and all routing data are private", async () => {
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    await assert.rejects(
      rpc({ p_action: "status", p_chat_id: student }),
      /permission denied/,
    );
    await assert.rejects(
      rpc({ p_action: "bind", p_chat_id: student }),
      /permission denied/,
    );
    for (const table of ["owner", "drafts", "deliveries"]) {
      await assert.rejects(
        db.query(`select 1 from public.uf_telegram_support_${table}`),
        /permission denied/,
      );
    }
  }
  await db.exec("set role service_role");
});

test("routes one text report and replies after successful acknowledgements", async () => {
  assert.deepEqual(await store.status(student), {
    ownerChatId: null,
    pending: null,
  });
  const context = { groupId: "g-25-23", language: "kk" };
  assert.equal(await store.begin(student, context), false);
  assert.deepEqual(await store.claim(student, 100), { code: "unavailable" });
  assert.equal(await rpc({ p_action: "bind", p_chat_id: owner }), true);
  assert.equal(await rpc({ p_action: "bind", p_chat_id: student }), false);
  assert.equal(await store.begin(student, context), true);

  const first = await store.claim(student, 100);
  assert.equal(first.code, "claimed");
  assert.equal(first.ownerChatId, owner);
  assert.equal(first.groupId, context.groupId);
  assert.equal(first.language, context.language);
  assert.deepEqual(await store.claim(student, 100), { code: "busy" });
  assert.deepEqual(await store.claim(student, 101), { code: "busy" });
  assert.equal(await store.release(first.reportId, first.leaseToken), true);
  assert.deepEqual(await store.status(student), {
    ownerChatId: owner,
    pending: context,
  });

  const next = await store.claim(student, 100);
  assert.equal(next.code, "claimed");
  assert.notEqual(next.leaseToken, first.leaseToken);
  assert.equal(
    await store.complete(next.reportId, 301, first.leaseToken),
    false,
  );
  assert.equal(await store.complete(next.reportId, 301, next.leaseToken), true);
  assert.deepEqual(await store.claim(student, 100), { code: "duplicate" });
  assert.deepEqual(await store.status(student), {
    ownerChatId: owner,
    pending: null,
  });

  assert.deepEqual(await store.routeReply(student, 301, 102), {
    code: "inactive",
  });
  assert.deepEqual(await store.routeReply(owner, 302, 102), {
    code: "inactive",
  });
  const reply = await store.routeReply(owner, 301, 102);
  assert.equal(reply.code, "claimed");
  assert.equal(reply.chatId, student);
  assert.equal(reply.language, "kk");
  assert.equal(reply.reportId, next.reportId);
  assert.deepEqual(await store.routeReply(owner, 301, 102), { code: "busy" });
  assert.equal(await store.releaseReply(102, reply.leaseToken), true);
  const retried = await store.routeReply(owner, 301, 102);
  assert.equal(await store.completeReply(102, reply.leaseToken), false);
  assert.equal(await store.completeReply(102, retried.leaseToken), true);
  assert.deepEqual(await store.routeReply(owner, 301, 102), {
    code: "duplicate",
  });

  assert.equal(await store.begin(student, context), true);
  assert.deepEqual(await store.claim(student, 103), { code: "rate_limited" });
  assert.equal(await store.cancel(student), true);
  assert.deepEqual(await store.claim(student, 103), { code: "inactive" });
});

test("a claim expiring or finishing late preserves the current report draft", async () => {
  const chatId = "403";
  await store.begin(chatId, { groupId: null, language: "ru" });
  const first = await store.claim(chatId, 200);
  await db.query(
    "update public.uf_telegram_support_deliveries set lease_until=now()-interval '1 second' where id=$1",
    [first.reportId],
  );
  const retry = await store.claim(chatId, 200);
  assert.equal(retry.code, "claimed");
  assert.equal(retry.reportId, first.reportId);
  assert.notEqual(retry.leaseToken, first.leaseToken);
  assert.equal(await store.release(first.reportId, first.leaseToken), false);

  const replacement = { groupId: "g-25-24", language: "kk" };
  await store.begin(chatId, replacement);
  assert.equal(
    await store.complete(retry.reportId, 401, retry.leaseToken),
    true,
  );
  assert.deepEqual(await store.status(chatId), {
    ownerChatId: owner,
    pending: replacement,
  });
});

test("Telegram relays a student's report and an administrator's reply between private chats", async () => {
  const relayOwner = Number(owner);
  const relayStudent = 404;
  const secret = "s".repeat(40);
  const sent = [];
  const handler = createTelegramWebhook({
    support: store,
    env: new Map([
      ["TELEGRAM_WEBHOOK_SECRET", secret],
      ["TELEGRAM_BOT_TOKEN", "100:" + "t".repeat(30)],
      ["SUPABASE_URL", "https://project.supabase.co"],
      ["SUPABASE_ANON_KEY", "test-publishable"],
    ]),
    fetcher: async (url, init) => {
      if (new URL(url).pathname.endsWith("/uniflow-api"))
        return Response.json({
          user: { role: "guest" },
          data: { groups: [{ id: "g-25-23", name: "06-057-25-23" }] },
        });
      assert.ok(url.endsWith("/sendMessage"));
      sent.push(JSON.parse(init.body));
      return Response.json({ ok: true, result: { message_id: sent.length } });
    },
  });
  const message = async (chatId, updateId, text, replyId) =>
    handler(
      new Request("https://fixture.invalid/webhook", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
        body: JSON.stringify({
          update_id: updateId,
          message: {
            chat: { id: chatId, type: "private" },
            from: { id: chatId, username: "PrivateFixture" },
            text,
            ...(replyId && { reply_to_message: { message_id: replyId } }),
          },
        }),
      }),
    );

  assert.equal(await rpc({ p_action: "bind", p_chat_id: owner }), true);
  assert.equal(
    (await message(relayStudent, 901, "/start report_g-25-23")).status,
    204,
  );
  assert.match(sent[0].text, /Группа · 06-057-25-23/);
  assert.equal(
    (await message(relayStudent, 902, "Проверьте пару.")).status,
    204,
  );
  assert.equal(String(sent[1].chat_id), owner);
  assert.match(sent[1].text, /Группа · 06-057-25-23\n\nПроверьте пару/);
  assert.doesNotMatch(sent[1].text, /PrivateFixture/);
  assert.match(sent[2].text, /Обращение отправлено/);
  await message(relayStudent, 902, "Проверьте пару.");
  await message(relayStudent, 903, "Ответ из чужого чата.", 2);
  assert.equal(sent.length, 3);

  assert.equal((await message(relayOwner, 904, "Проверю.", 2)).status, 204);
  assert.equal(String(sent[3].chat_id), String(relayStudent));
  assert.match(sent[3].text, /Ответ администратора UniFlow\n\nПроверю/);
  assert.ok(
    sent[3].reply_markup.inline_keyboard.flat().every((button) => !button.url),
  );
  await message(relayOwner, 904, "Проверю.", 2);
  assert.equal(sent.length, 5);
});
