import test from "node:test";
import assert from "node:assert/strict";
import {
  createOwnerApi,
  createOwnerSession,
  consumeBootstrapFragment,
  OwnerAccessError,
  validOwnerPassword,
} from "../beta/admin/api.mjs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

test("owner password uses Unicode characters and native Auth UTF-8 byte limit", () => {
  for (const value of [
    "a".repeat(12),
    "a".repeat(72),
    "я".repeat(36),
    "🔑".repeat(18),
  ])
    assert.equal(validOwnerPassword(value), true);
  for (const value of [
    "a".repeat(11),
    "a".repeat(73),
    "я".repeat(37),
    "🔑".repeat(19),
    "🔑".repeat(6),
    null,
  ])
    assert.equal(validOwnerPassword(value), false);
});

const session = (token = "a", expiresAt = Date.now() + 900000) => ({
  token: "ow1a." + token.repeat(64),
  refreshToken: "ow1r." + token.repeat(64),
  expiresAt: new Date(expiresAt).toISOString(),
  refreshExpiresAt: new Date(Date.now() + 3600000).toISOString(),
  owner: { id: "fixed-owner", email: "owner@example.invalid" },
});

test("owner transport is POST/no-store, does not send cookies, referrer or identity", async () => {
  let seen;
  const request = createOwnerApi({
    fetcher: async (url, options) => {
      seen = { url, options };
      return new Response(JSON.stringify({ available: true }));
    },
  });
  assert.deepEqual(await request("status"), { available: true });
  assert.equal(seen.options.method, "POST");
  assert.equal(seen.options.cache, "no-store");
  assert.equal(seen.options.credentials, "omit");
  assert.equal(seen.options.referrerPolicy, "no-referrer");
  assert.equal(seen.options.body, '{"action":"status"}');
  assert.equal(new URL(seen.url).search, "");
});

test("transport turns server/network/invalid JSON into safe codes without echoing secrets", async () => {
  for (const response of [
    new Response("private-proof", { status: 502 }),
    new Response(
      JSON.stringify({ error: "private-proof", code: "UNEXPECTED" }),
      { status: 403 },
    ),
  ]) {
    const request = createOwnerApi({ fetcher: async () => response });
    await assert.rejects(
      request("login.begin", { password: "private-proof" }),
      (error) =>
        error.message === "UNAVAILABLE" &&
        !String(error).includes("private-proof"),
    );
  }
  const request = createOwnerApi({
    fetcher: async () => {
      throw Error("private-proof");
    },
  });
  await assert.rejects(request("status"), { code: "UNAVAILABLE" });
  await assert.rejects(request("unknown"), { code: "INVALID_REQUEST" });
});

test("rate limit preserves bounded Retry-After without exposing backend message", async () => {
  const request = createOwnerApi({
    fetcher: async () =>
      new Response(
        JSON.stringify({ code: "RATE_LIMITED", error: "private-details" }),
        { status: 429, headers: { "Retry-After": "45" } },
      ),
  });
  await assert.rejects(
    request("login.begin"),
    (error) =>
      error instanceof OwnerAccessError &&
      error.retryAfterSeconds === 45 &&
      error.message === "RATE_LIMITED",
  );
});

test("fragment is completely scrubbed synchronously, only access proof retained in memory", () => {
  const location = {
    hash: "#access_token=one-time&refresh_token=never-retain&type=invite",
    pathname: "/schedule/admin/",
    search: "",
  };
  let changed;
  assert.equal(
    consumeBootstrapFragment(location, {
      replaceState: (...args) => {
        changed = args;
      },
    }),
    "one-time",
  );
  assert.deepEqual(changed, [null, "", "/schedule/admin/"]);
});

test("session serializes rotation and exposes no credential properties", async () => {
  let calls = 0;
  const old = session("a", Date.now() - 1000);
  const next = session("b");
  const memory = createOwnerSession(old, async (action, body) => {
    assert.equal(action, "session.refresh");
    assert.equal(body.refreshToken, old.refreshToken);
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return next;
  });
  assert.deepEqual(
    await Promise.all([memory.getAccessToken(), memory.getAccessToken()]),
    [next.token, next.token],
  );
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(memory).includes("ow1"), false);
  assert.equal(memory.token, undefined);
  assert.equal(memory.refreshToken, undefined);
});

test("late rotation cannot resurrect cleared session", async () => {
  let finish;
  const memory = createOwnerSession(
    session("a", Date.now() - 1000),
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = memory.getAccessToken();
  memory.clear();
  finish(session("b"));
  await assert.rejects(pending, { code: "INVALID_PROOF" });
  await assert.rejects(memory.getAccessToken(), { code: "INVALID_PROOF" });
});

test("logout-all always clears local credentials even when server is unavailable", async () => {
  const initial = session();
  const memory = createOwnerSession(initial, async (action, body) => {
    assert.equal(action, "logout.all");
    assert.equal(body.token, initial.token);
    throw new OwnerAccessError();
  });
  await assert.rejects(memory.logoutAll());
  await assert.rejects(memory.getAccessToken(), { code: "INVALID_PROOF" });
});

test("identity swap on rotating refresh fails closed", async () => {
  const memory = createOwnerSession(
    session("a", Date.now() - 1000),
    async () => ({
      ...session("b"),
      owner: { id: "other", email: "other@example.invalid" },
    }),
  );
  await assert.rejects(memory.getAccessToken(), { code: "INVALID_PROOF" });
  await assert.rejects(memory.getAccessToken(), { code: "INVALID_PROOF" });
});

test("vendored QR encoder matches the pinned upstream artifact", async () => {
  const source = await readFile(
    new URL("../beta/admin/vendor/qrcode-generator-2.0.4.mjs", import.meta.url),
  );
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    "ea91d7118a5395289170da848b7c6758b996163bfbccf312591ab65a4911b7c0",
  );
});
