import assert from "node:assert/strict";
import test from "node:test";
import {
  createTelegramNotificationWorker,
  telegramNotificationText,
} from "../backend/telegram-notification-worker.mjs";

const secret = "x".repeat(40);
const botToken = "123:" + "t".repeat(30);
const project = "https://fixture.supabase.co";
const modernKey = "sb_secret_fixture";
const oldKey = "legacy.service.fixture";
const header = "X-UniFlow-Notification-Secret";
const notification = {
  groupName: "СОПР-20",
  subject: "Математика",
  subgroup: "А",
  status: "moved",
  originalDate: "2026-11-30",
  originalStart: "08:00",
  originalEnd: "08:50",
  originalRoom: "204",
  date: "2026-12-01",
  start: "09:00",
  end: "09:50",
  room: "209",
};

function claim(n, options = {}) {
  return {
    id: "10000000-0000-4000-8000-" + String(n).padStart(12, "0"),
    lease_token: "20000000-0000-4000-8000-" + String(n).padStart(12, "0"),
    chat_id: String(4000000000000000 + n),
    attempts: 1,
    payload: notification,
    ...options,
  };
}

function clients({
  claims = [],
  deliver = () => Response.json({ ok: true }),
  finish = () => Response.json(true),
  legacy = false,
  claimResponse,
} = {}) {
  const env = new Map([
    ["SUPABASE_URL", project],
    ["TELEGRAM_BOT_TOKEN", botToken],
    ["UNIFLOW_TELEGRAM_NOTIFICATION_SECRET", secret],
    ["SUPABASE_SERVICE_ROLE_KEY", oldKey],
    ...(legacy
      ? []
      : [["SUPABASE_SECRET_KEYS", JSON.stringify({ default: modernKey })]]),
  ]);
  const requests = [];
  const worker = createTelegramNotificationWorker({
    env,
    fetcher: async (url, options) => {
      const target = new URL(url);
      assert.equal(options.method, "POST");
      assert.equal(options.redirect, "error");
      assert.ok(options.signal);
      const body = JSON.parse(options.body);
      if (target.origin === project) {
        assert.equal(options.headers.apikey, legacy ? oldKey : modernKey);
        assert.equal(
          options.headers.Authorization,
          legacy ? "Bearer " + oldKey : undefined,
        );
        assert.equal(options.headers[header], undefined);
        if (target.pathname.endsWith("/uf_telegram_claim_notifications")) {
          requests.push(["claim", body]);
          assert.deepEqual(body, { p_limit: 12 });
          return claimResponse || Response.json(claims);
        }
        assert.equal(
          target.pathname,
          "/rest/v1/rpc/uf_telegram_finish_notification",
        );
        requests.push(["finish", body]);
        return finish(body);
      }
      assert.equal(
        target.href,
        "https://api.telegram.org/bot" + botToken + "/sendMessage",
      );
      assert.deepEqual(options.headers, { "Content-Type": "application/json" });
      assert.equal(body.link_preview_options.is_disabled, true);
      assert.equal(body.parse_mode, undefined);
      requests.push(["send", body]);
      return deliver(body);
    },
  });
  const run = (method = "POST", token = secret) =>
    worker(
      new Request(project + "/functions/v1/telegram-notifications", {
        method,
        headers: { [header]: token },
      }),
    );
  return { run, requests, env };
}

test("notification text renders the prior and new slots and scope as plain text", () => {
  assert.equal(
    telegramNotificationText(notification),
    [
      "🔔 Занятие перенесено",
      "Математика",
      "Группа СОПР-20 · подгруппа А",
      "Было 30.11.2026, 08:00–08:50 · ауд. 204",
      "Стало 01.12.2026, 09:00–09:50 · ауд. 209",
    ].join("\n"),
  );
  assert.equal(
    telegramNotificationText({
      ...notification,
      status: "cancelled",
      subgroup: "all",
      originalRoom: null,
      date: null,
    }),
    "🚫 Занятие отменено\nМатематика\nГруппа СОПР-20\n30.11.2026, 08:00–08:50",
  );
  assert.equal(
    telegramNotificationText({ ...notification, date: "2026-02-30" }),
    null,
  );
});

test("worker rejects unauthenticated requests and missing credentials before claiming", async () => {
  const { run, env, requests } = clients();
  assert.equal((await run("GET")).status, 405);
  assert.equal((await run("POST", "bad")).status, 403);
  env.delete("TELEGRAM_BOT_TOKEN");
  assert.equal((await run()).status, 503);
  env.delete("UNIFLOW_TELEGRAM_NOTIFICATION_SECRET");
  assert.equal((await run()).status, 503);
  assert.deepEqual(requests, []);
});

test("worker persists the exact lease and the outcome of each Telegram request", async () => {
  const records = [
    claim(1),
    claim(2),
    claim(3),
    claim(4),
    claim(5, { attempts: 3 }),
    claim(6, { chat_id: "-5" }),
    claim(7, { payload: { ...notification, status: "unknown" } }),
    claim(8, { attempts: 2 }),
  ];
  const messages = new Map([
    [1, Response.json({ ok: true })],
    [
      2,
      Response.json(
        { ok: false, parameters: { retry_after: 85 } },
        { status: 429 },
      ),
    ],
    [3, Response.json({ ok: false }, { status: 403 })],
    [4, Response.json({ ok: false }, { status: 400 })],
    [5, new Response(null, { status: 502 })],
  ]);
  const { run, requests } = clients({
    claims: records,
    deliver(body) {
      return (
        messages.get(body.chat_id - 4000000000000000) ||
        Promise.reject(Error("temporary network failure"))
      );
    },
  });
  const result = await run();
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await result.json(), {
    ok: true,
    claimed: 8,
    sent: 1,
    retry: 3,
    discard: 3,
    blocked: 1,
    stale: 0,
    failed: 0,
  });
  const finishes = requests
    .filter(([kind]) => kind === "finish")
    .map(([, body]) => body)
    .sort((a, b) => a.p_id.localeCompare(b.p_id));
  assert.deepEqual(
    finishes,
    [
      ["sent", 0],
      ["retry", 85],
      ["blocked", 0],
      ["discard", 0],
      ["retry", 120],
      ["discard", 0],
      ["discard", 0],
      ["retry", 60],
    ].map(([outcome, delay], index) => ({
      p_id: records[index].id,
      p_lease_token: records[index].lease_token,
      p_outcome: outcome,
      p_delay_seconds: delay,
    })),
  );
  assert.equal(requests.filter(([kind]) => kind === "send").length, 6);
});

test("worker limits concurrency and avoids sending again within a blocked chat batch", async () => {
  let active = 0;
  let peak = 0;
  const records = Array.from({ length: 12 }, (_, i) => claim(i + 1));
  records[1].chat_id = records[0].chat_id;
  const { run, requests } = clients({
    claims: records,
    legacy: true,
    async deliver(body) {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return body.chat_id === Number(records[0].chat_id)
        ? Response.json({ ok: false }, { status: 403 })
        : Response.json({ ok: true });
    },
  });
  const result = await run();
  assert.equal(result.status, 200);
  assert.equal(peak, 4);
  assert.equal(requests.filter(([kind]) => kind === "send").length, 11);
  const body = await result.json();
  assert.equal(body.blocked, 2);
  assert.equal(body.sent, 10);
});

test("failed lease acknowledgement returns a generic aggregate result without retrying delivery", async () => {
  const record = claim(1);
  const { run, requests } = clients({
    claims: [record],
    finish: () => new Response("private error", { status: 500 }),
  });
  const result = await run();
  assert.equal(result.status, 503);
  const body = await result.text();
  assert.deepEqual(JSON.parse(body), {
    ok: false,
    claimed: 1,
    sent: 0,
    retry: 0,
    discard: 0,
    blocked: 0,
    stale: 0,
    failed: 1,
  });
  assert.doesNotMatch(
    body,
    /private error|fixture|10000000|20000000|400000000000/,
  );
  assert.equal(requests.filter(([kind]) => kind === "send").length, 1);
});

test("a superseded lease is not reported as an acknowledged delivery", async () => {
  const { run } = clients({
    claims: [claim(1)],
    finish: () => Response.json(false),
  });
  const result = await run();
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.sent, 0);
  assert.equal(body.stale, 1);
});
