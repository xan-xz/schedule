import test from "node:test";
import assert from "node:assert/strict";
import { createTelegramSubscriptions } from "../backend/telegram-subscriptions.mjs";

const project = "https://fixture.supabase.co";
const endpoint = project + "/rest/v1/rpc/uf_telegram_subscription";
const key = "sb_secret_" + "x".repeat(32);
const legacy = (role) =>
  [
    Buffer.from('{"alg":"HS256"}').toString("base64url"),
    Buffer.from(JSON.stringify({ role })).toString("base64url"),
    "test_signature_placeholder",
  ].join(".");

test("subscription adapter limits its RPC calls to the exact hosted endpoint and payload", async () => {
  const env = new Map([
    ["SUPABASE_URL", project + "/"],
    ["SUPABASE_SECRET_KEYS", JSON.stringify({ default: key })],
    ["SUPABASE_SERVICE_ROLE_KEY", legacy("service_role")],
  ]);
  const inputs = [];
  const subscription = { groupId: "group-test", subgroup: "Б" };
  const rpc = createTelegramSubscriptions({
    env,
    fetcher: async (url, options) => {
      assert.equal(url.href, endpoint);
      assert.equal(options.method, "POST");
      assert.equal(options.redirect, "error");
      assert.equal(options.signal.aborted, false);
      assert.deepEqual(options.headers, {
        "Content-Type": "application/json",
        apikey: key,
      });
      inputs.push(JSON.parse(options.body));
      return Response.json(inputs.length === 2 ? subscription : null);
    },
  });
  const chatId = 2 ** 43 + 7;
  assert.equal(await rpc.get({ chatId }), null);
  assert.deepEqual(
    await rpc.subscribe({ chatId, updateId: 23, ...subscription }),
    subscription,
  );
  assert.equal(await rpc.unsubscribe({ chatId, updateId: 24 }), null);
  assert.deepEqual(inputs, [
    { p_chat_id: chatId },
    {
      p_chat_id: chatId,
      p_update_id: 23,
      p_group_id: "group-test",
      p_subgroup: "Б",
    },
    { p_chat_id: chatId, p_update_id: 24 },
  ]);
});

test("subscription adapter accepts legacy service role JWTs and disables itself without privileged credentials", async () => {
  const serviceRole = legacy("service_role");
  const anon = legacy("anon");
  const env = new Map([
    ["SUPABASE_URL", project],
    ["SUPABASE_SECRET_KEYS", "broken JSON"],
    ["SUPABASE_SERVICE_ROLE_KEY", serviceRole],
  ]);
  const rpc = createTelegramSubscriptions({
    env,
    fetcher: async (url, options) => {
      assert.equal(url.href, endpoint);
      assert.equal(options.headers.apikey, serviceRole);
      assert.equal(options.headers.Authorization, "Bearer " + serviceRole);
      return new Response(null, { status: 204 });
    },
  });
  assert.equal(await rpc.get({ chatId: 123 }), null);
  env.set("SUPABASE_SERVICE_ROLE_KEY", anon);
  env.set(
    "SUPABASE_SECRET_KEYS",
    JSON.stringify({ default: "sb_publishable_test" }),
  );
  env.set("SUPABASE_ANON_KEY", anon);
  assert.equal(createTelegramSubscriptions({ env }), undefined);

  env.set("SUPABASE_SERVICE_ROLE_KEY", serviceRole);
  for (const url of [
    "https://fixture.supabase.co.other.invalid/",
    "https://fixture.supabase.co/path",
    "https://fixture.supabase.co:8080/",
    "https://user@fixture.supabase.co/",
    "http://fixture.supabase.co/",
  ]) {
    env.set("SUPABASE_URL", url);
    assert.equal(createTelegramSubscriptions({ env }), undefined);
  }
});

test("subscription adapter hides internal request failures and rejects malformed RPC results", async () => {
  const env = new Map([
    ["SUPABASE_URL", project],
    ["SUPABASE_SECRET_KEYS", JSON.stringify({ default: key })],
  ]);
  for (const fetcher of [
    async () => {
      throw Error("upstream internals");
    },
    async () =>
      Response.json({ message: "private error details" }, { status: 403 }),
    async () => Response.json({ groupId: "not-a-subscription" }),
  ]) {
    const rpc = createTelegramSubscriptions({ env, fetcher });
    await assert.rejects(rpc.get({ chatId: 123 }), {
      message: "Notification subscriptions unavailable",
    });
  }
});
