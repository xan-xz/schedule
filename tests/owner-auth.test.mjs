import test from "node:test";
import assert from "node:assert/strict";
import { createOwnerHandler } from "../backend/owner-auth.mjs";
import {
  OWNER_EMAIL,
  createSecretBox,
  tokenHash,
  ownerError,
  verifyOwnerAccess,
} from "../backend/owner-access.mjs";

const UID = "11111111-1111-4111-8111-111111111111";
const PASS_SESSION = "22222222-2222-4222-8222-222222222222";
const FACTOR = "33333333-3333-4333-8333-333333333333";
const EMAIL_SESSION = "44444444-4444-4444-8444-444444444444";
const NEW_FACTOR = "55555555-5555-4555-8555-555555555555";
const NEW_SESSION = "66666666-6666-4666-8666-666666666666";
const START = Date.parse("2026-11-08T05:00:00Z");
const PASSWORD = "synthetic-local-password";
const RECOVERY = "uwr1-" + "a".repeat(32);
const clone = structuredClone;

async function fixture({ configured = true, missingOwner = false } = {}) {
  let now = START;
  const cfg = {
    owner_uid: missingOwner ? null : UID,
    owner_email: OWNER_EMAIL,
    factor_id: configured ? FACTOR : null,
    setup_complete: configured,
    bootstrap_deadline: new Date(START + 15 * 60000).toISOString(),
  };
  const state = {
    cfg,
    calls: [],
    providerCalls: [],
    challenges: new Map(),
    sessions: new Map(),
    usedRefresh: new Map(),
    recovery: new Map([[await tokenHash(RECOVERY), false]]),
    nativeAlive: true,
    blocked: false,
    mailVersion: 0,
    emailSessions: new Map(),
  };
  const current = () => now;
  const fail = (error = "INVALID_PROOF") => ({ error });
  const db = async (path, options) => {
    assert.equal(path, "rpc/owner_access_command");
    const { p_op: op, p } = JSON.parse(options.body);
    state.calls.push({ op, p });
    const ch = state.challenges.get(p.challenge_hash);
    if (op === "state") return clone(cfg);
    if (op === "rate.reserve")
      return state.blocked
        ? { error: "RATE_LIMITED", retryAfterSeconds: 900 }
        : { attempt: 1 };
    if (op === "log")
      return state.failAudit ? { error: "UNAVAILABLE" } : { ok: true };
    if (op === "setup.reserve") {
      if (cfg.setup_complete) return fail("ACCESS_DENIED");
      if (cfg.mail_cooldown_until > now)
        return { error: "RATE_LIMITED", retryAfterSeconds: 300 };
      cfg.mail_cooldown_until = now + 300000;
      cfg.mail_lease = p.lease;
      return clone(cfg);
    }
    if (op === "setup.pin") {
      if (p.lease !== cfg.mail_lease || p.owner_uid !== UID) return fail();
      cfg.owner_uid = p.owner_uid;
      return clone(cfg);
    }
    if (op === "challenge.create") {
      if (
        p.owner_uid !== cfg.owner_uid ||
        (p.kind === "setup" &&
          [...state.challenges.values()].some(
            (value) => value.email_session_id === p.native_session_id,
          ))
      )
        return fail();
      const created = {
        ...p,
        email_session_id: p.kind === "setup" ? p.native_session_id : null,
        created_at: new Date(now).toISOString(),
        expires_at: new Date(
          now + (p.kind === "setup" ? 600000 : 300000),
        ).toISOString(),
        attempts: 0,
        email_proved_at:
          p.kind === "setup" ? new Date(now).toISOString() : null,
      };
      state.challenges.set(p.challenge_hash, created);
      return clone(created);
    }
    if (op === "challenge.claim") {
      if (
        !ch ||
        ch.consumed_at ||
        Date.parse(ch.expires_at) <= now ||
        ch.attempts >= 5
      )
        return fail();
      if (ch.lease) return fail("FLOW_CONFLICT");
      ch.lease = p.lease;
      ch.attempts++;
      return clone(ch);
    }
    if (op === "challenge.save") {
      if (!ch || ch.lease !== p.lease || ch.consumed_at) return fail();
      if (
        p.email_proved &&
        (!p.email_session_id ||
          ch.email_session_id ||
          [...state.challenges.values()].some(
            (value) => value.email_session_id === p.email_session_id,
          ))
      )
        return fail();
      ch.encrypted_state = p.encrypted_state;
      if (p.native_session_id) ch.native_session_id = p.native_session_id;
      if (p.email_proved) {
        ch.email_proved_at = new Date(now).toISOString();
        ch.email_session_id = p.email_session_id;
      }
      return clone(ch);
    }
    if (op === "challenge.release") {
      if (!ch || ch.lease !== p.lease) return fail();
      ch.lease = null;
      return clone(ch);
    }
    if (op === "recovery.consume") {
      if (
        !ch ||
        !ch.email_proved_at ||
        ch.lease !== p.lease ||
        state.recovery.get(p.code_hash) !== false
      )
        return fail();
      state.recovery.set(p.code_hash, true);
      ch.kind = "recovery";
      for (const session of state.sessions.values())
        session.revoked_at = new Date(now).toISOString();
      return clone(ch);
    }
    if (op === "session.create") {
      if (
        !ch ||
        ch.consumed_at ||
        ch.lease !== p.lease ||
        !ch.email_proved_at ||
        ch.native_session_id !== p.native_session_id ||
        !state.nativeAlive ||
        (ch.kind === "login" && p.factor_id !== cfg.factor_id)
      )
        return fail();
      if (p.recovery_hashes)
        for (const row of state.sessions.values())
          row.revoked_at = new Date(now).toISOString();
      const created = {
        id: crypto.randomUUID(),
        owner_uid: cfg.owner_uid,
        owner_email: OWNER_EMAIL,
        native_session_id: p.native_session_id,
        factor_id: p.factor_id,
        access_hash: p.access_hash,
        refresh_hash: p.refresh_hash,
        encrypted_state: p.encrypted_state,
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + 900000).toISOString(),
        absolute_expires_at: new Date(now + 3600000).toISOString(),
      };
      state.sessions.set(created.id, created);
      ch.consumed_at = new Date(now).toISOString();
      if (p.recovery_hashes) {
        cfg.setup_complete = true;
        cfg.factor_id = p.factor_id;
        state.recovery = new Map(
          p.recovery_hashes.map((code) => [code, false]),
        );
      }
      return clone(created);
    }
    if (op === "session.verify") {
      const session = [...state.sessions.values()].find(
        (row) => row.access_hash === p.access_hash,
      );
      if (
        !session ||
        session.revoked_at ||
        Date.parse(session.expires_at) <= now ||
        Date.parse(session.absolute_expires_at) <= now ||
        !state.nativeAlive ||
        session.factor_id !== cfg.factor_id
      )
        return fail();
      return clone(session);
    }
    if (op === "session.claim_refresh") {
      const session = [...state.sessions.values()].find(
        (row) => row.refresh_hash === p.refresh_hash,
      );
      if (!session) {
        const previous = state.usedRefresh.get(p.refresh_hash);
        if (previous)
          state.sessions.get(previous).revoked_at = new Date(now).toISOString();
        return fail();
      }
      if (
        session.revoked_at ||
        Date.parse(session.absolute_expires_at) <= now ||
        !state.nativeAlive
      )
        return fail();
      if (session.lease) return fail("FLOW_CONFLICT");
      session.lease = p.lease;
      return clone(session);
    }
    if (op === "session.rotate") {
      const session = state.sessions.get(p.id);
      if (
        !session ||
        session.lease !== p.lease ||
        session.revoked_at ||
        Date.parse(session.absolute_expires_at) <= now
      )
        return fail();
      state.usedRefresh.set(session.refresh_hash, session.id);
      session.access_hash = p.access_hash;
      session.refresh_hash = p.refresh_hash;
      session.encrypted_state = p.encrypted_state;
      session.expires_at = new Date(
        Math.min(now + 900000, Date.parse(session.absolute_expires_at)),
      ).toISOString();
      session.lease = null;
      return clone(session);
    }
    if (op === "session.revoke") {
      const session = state.sessions.get(p.id);
      if (!session) return fail();
      for (const row of state.sessions.values())
        if (p.all || row.id === p.id)
          row.revoked_at = new Date(now).toISOString();
      return { ok: true };
    }
    throw Error("Unexpected isolated database operation: " + op);
  };
  const native = (kind = "password", nativeId = PASS_SESSION) => ({
    access_token: "synthetic-provider-" + kind,
    refresh_token: "synthetic-refresh-" + kind,
    identity: {
      user: {
        id: UID,
        email: OWNER_EMAIL,
        factors: [{ id: FACTOR, factor_type: "totp", status: "verified" }],
      },
      claims: {
        session_id: nativeId,
        aal: kind === "verified" ? "aal2" : "aal1",
      },
    },
  });
  const auth = {
    async invite() {
      state.providerCalls.push({ op: "invite" });
      return { id: UID };
    },
    async sendEmail() {
      state.providerCalls.push({ op: "mail" });
      state.mailVersion++;
    },
    async email(value) {
      state.providerCalls.push({ op: "email" });
      assert.ok(typeof value === "string");
      const key = state.mailVersion + ":" + value;
      if (!state.emailSessions.has(key))
        state.emailSessions.set(key, crypto.randomUUID());
      return native("email", state.emailSessions.get(key));
    },
    async password(value) {
      state.providerCalls.push({ op: "password" });
      if (value !== PASSWORD) throw ownerError();
      return native();
    },
    async setPassword(_token, value) {
      state.providerCalls.push({ op: "setPassword" });
      if (value !== PASSWORD) throw ownerError();
      return native();
    },
    async enroll(accessToken) {
      state.providerCalls.push({ op: "enroll", accessToken });
      return {
        factorId: NEW_FACTOR,
        secret: "SYNTHETICSEED",
        uri: "otpauth://totp/UniFlow?secret=SYNTHETICSEED",
      };
    },
    async totp(session, factorId, code) {
      state.providerCalls.push({
        op: "totp",
        providerAccess: session.access_token,
        nativeSession: session.identity.claims.session_id,
        factorId,
      });
      if (code !== "123456") throw ownerError();
      return native("verified", session.identity.claims.session_id);
    },
    async deleteFactor(_uid, factorId) {
      state.providerCalls.push({ op: "deleteFactor", factorId });
    },
    async refresh(_refreshToken, nativeId) {
      state.providerCalls.push({ op: "refresh" });
      return native("verified", nativeId);
    },
    async logout(accessToken, all) {
      state.providerCalls.push({ op: "logout", accessToken, all });
    },
  };
  const box = await createSecretBox("synthetic-private-server-key-material");
  const handle = createOwnerHandler({
    db,
    auth,
    box,
    secret: "synthetic-private-server-key-material",
    now: current,
    sleep: async () => {},
  });
  async function post(action, data = {}, headers = {}) {
    const response = await handle(
      new Request("https://edge.invalid/owner-access", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          origin: "https://xan-xz.github.io",
          "x-forwarded-for": "192.0.2.20",
          "user-agent": "Synthetic browser",
          ...headers,
        },
        body: JSON.stringify({ action, ...data }),
      }),
    );
    return {
      status: response.status,
      body: await response.json(),
      headers: response.headers,
    };
  }
  async function begin() {
    const result = await post("login.begin", { password: PASSWORD });
    assert.equal(result.status, 200);
    return result.body.challengeId;
  }
  async function login() {
    const challengeId = await begin();
    const result = await post("login.verify", {
      challengeId,
      emailCode: "123456",
      totpCode: "123456",
    });
    assert.equal(result.status, 200);
    return result.body;
  }
  return {
    state,
    db,
    auth,
    box,
    post,
    begin,
    login,
    native,
    advance: (milliseconds) => {
      now += milliseconds;
    },
  };
}

test("status exposes no owner UID, provider credential, hash or private state", async () => {
  const f = await fixture();
  const result = await f.post("status");
  assert.equal(result.status, 200);
  assert.equal(result.body.configured, true);
  assert.equal(JSON.stringify(result.body).includes(UID), false);
  assert.equal(result.headers.get("cache-control"), "no-store");
  const denied = await f.post(
    "status",
    {},
    { origin: "https://attacker.invalid" },
  );
  assert.equal(denied.status, 403);
});

test("setup request sends only through the fixed-owner provider, pins UID and enforces cooldown", async () => {
  const f = await fixture({ configured: false, missingOwner: true });
  const first = await f.post("setup.request", {
    email: "attacker@example.invalid",
    role: "admin",
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.sent, true);
  assert.equal(f.state.cfg.owner_uid, UID);
  assert.deepEqual(
    f.state.providerCalls.map((call) => call.op),
    ["invite"],
  );
  const repeated = await f.post("setup.request");
  assert.equal(repeated.status, 429);
  assert.equal(f.state.providerCalls.length, 1);
  f.advance(300001);
  assert.equal((await f.post("setup.request")).status, 200);
  assert.equal(f.state.providerCalls.at(-1).op, "mail");
});

test("bootstrap is owner-bound and one use; password and TOTP remain separate from activation", async () => {
  const f = await fixture({ configured: false });
  const start = await f.post("setup.start", {
    bootstrapToken: "synthetic-email-proof",
  });
  assert.equal(start.status, 200);
  assert.equal(start.body.step, "password");
  assert.equal(
    (await f.post("setup.start", { bootstrapToken: "synthetic-email-proof" }))
      .status,
    401,
  );
  const challengeId = start.body.challengeId;
  const password = await f.post("setup.password", {
    challengeId,
    password: PASSWORD,
  });
  assert.equal(password.status, 200);
  assert.equal(password.body.step, "totp");
  assert.equal(password.body.enrollment.factorId, NEW_FACTOR);
  assert.equal(f.state.cfg.setup_complete, false);
  const invalid = await f.post("setup.verify", {
    challengeId,
    totpCode: "000000",
  });
  assert.equal(invalid.status, 401);
  assert.equal(f.state.sessions.size, 0);
  const completed = await f.post("setup.verify", {
    challengeId,
    totpCode: "123456",
  });
  assert.equal(completed.status, 200);
  assert.match(completed.body.token, /^ow1a\.[a-f0-9]{64}$/);
  assert.equal(completed.body.recoveryCodes.length, 10);
  assert.equal(new Set(completed.body.recoveryCodes).size, 10);
  assert.equal(f.state.cfg.setup_complete, true);
  const stored = JSON.stringify(f.state.calls);
  assert.equal(stored.includes(PASSWORD), false);
  assert.equal(stored.includes("synthetic-provider-password"), false);
  assert.equal(stored.includes(completed.body.token), false);
  for (const code of completed.body.recoveryCodes)
    assert.equal(stored.includes(code), false);
  assert.equal(
    (await f.post("setup.verify", { challengeId, totpCode: "123456" })).status,
    401,
  );
});

test("bootstrap rejects a different verified identity without creating a challenge", async () => {
  const f = await fixture({ configured: false });
  f.auth.email = async () => ({
    ...f.native("email"),
    identity: {
      user: { id: NEW_SESSION },
      claims: { session_id: EMAIL_SESSION },
    },
  });
  assert.equal(
    (await f.post("setup.start", { bootstrapToken: "synthetic-email-proof" }))
      .status,
    403,
  );
  assert.equal(f.state.challenges.size, 0);
});

test("bootstrap replay remains blocked after its password session replaces the invite session", async () => {
  const f = await fixture({ configured: false });
  const first = await f.post("setup.start", {
    bootstrapToken: "same-native-email-proof",
  });
  assert.equal(
    (
      await f.post("setup.password", {
        challengeId: first.body.challengeId,
        password: PASSWORD,
      })
    ).status,
    200,
  );
  const stored = [...f.state.challenges.values()][0];
  assert.notEqual(stored.native_session_id, stored.email_session_id);
  assert.equal(
    (await f.post("setup.start", { bootstrapToken: "same-native-email-proof" }))
      .status,
    401,
  );
  assert.equal(f.state.challenges.size, 1);
});

test("saved setup enrollment can be returned after a lost reply without changing the password or factor again", async () => {
  const f = await fixture({ configured: false });
  const started = await f.post("setup.start", {
    bootstrapToken: "synthetic-email-proof",
  });
  const data = { challengeId: started.body.challengeId, password: PASSWORD };
  const first = await f.post("setup.password", data);
  const retry = await f.post("setup.password", data);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body.enrollment, first.body.enrollment);
  assert.equal(
    f.state.providerCalls.filter((call) => call.op === "enroll").length,
    1,
  );
  assert.equal(
    f.state.providerCalls.filter((call) => call.op === "setPassword").length,
    1,
  );
});

test("login requires password, fresh email proof and the approved TOTP on the original session", async () => {
  const f = await fixture();
  const credentials = await f.login();
  const totp = f.state.providerCalls.find((call) => call.op === "totp");
  assert.equal(totp.providerAccess, "synthetic-provider-password");
  assert.equal(totp.nativeSession, PASS_SESSION);
  assert.equal(totp.factorId, FACTOR);
  const discarded = f.state.providerCalls.find((call) => call.op === "logout");
  assert.equal(discarded.accessToken, "synthetic-provider-email");
  assert.equal(discarded.all, false);
  const owner = await verifyOwnerAccess(f.db, credentials.token);
  assert.equal(owner.id, UID);
  assert.equal(owner.email, OWNER_EMAIL);
  const session = [...f.state.sessions.values()][0];
  assert.equal(session.native_session_id, PASS_SESSION);
  assert.equal(Date.parse(session.expires_at) - START, 900000);
  assert.equal(Date.parse(session.absolute_expires_at) - START, 3600000);
  assert.equal("recoveryCodes" in credentials, false);
});

test("email-only sessions and another owner's proof cannot replace the password chain", async () => {
  for (const mode of ["same-session", "other-owner"]) {
    const f = await fixture();
    const challengeId = await f.begin();
    f.auth.email = async () => {
      const value = f.native(
        "email",
        mode === "same-session" ? PASS_SESSION : EMAIL_SESSION,
      );
      if (mode === "other-owner") value.identity.user.id = NEW_SESSION;
      return value;
    };
    assert.equal(
      (
        await f.post("login.verify", {
          challengeId,
          emailCode: "123456",
          totpCode: "123456",
        })
      ).status,
      401,
    );
    assert.equal(f.state.sessions.size, 0);
    assert.equal(
      f.state.providerCalls.some((call) => call.op === "totp"),
      false,
    );
  }
});

test("a consumed email OTP is remembered only server-side while TOTP is retried", async () => {
  const f = await fixture();
  const challengeId = await f.begin();
  assert.equal(
    (
      await f.post("login.verify", {
        challengeId,
        emailCode: "123456",
        totpCode: "000000",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.post("login.verify", {
        challengeId,
        emailCode: "already-consumed",
        totpCode: "123456",
      })
    ).status,
    200,
  );
  assert.equal(
    f.state.providerCalls.filter((call) => call.op === "email").length,
    1,
  );
});

test("the same email-session JWT cannot be reused for another password challenge", async () => {
  const f = await fixture();
  f.auth.email = async () => f.native("email", EMAIL_SESSION);
  const first = await f.login();
  const challengeId = await f.begin();
  const replay = await f.post("login.verify", {
    challengeId,
    emailCode: "same-native-JWT",
    totpCode: "123456",
  });
  assert.equal(replay.status, 401);
  assert.equal(f.state.sessions.size, 1);
  assert.equal((await verifyOwnerAccess(f.db, first.token)).id, UID);
});

test("full login can renew lost recovery codes and revoke all older application sessions atomically", async () => {
  const f = await fixture();
  const original = await f.login();
  const challengeId = await f.begin();
  const renewed = await f.post("login.verify", {
    challengeId,
    emailCode: "123456",
    totpCode: "123456",
    renewRecoveryCodes: true,
  });
  assert.equal(renewed.status, 200);
  assert.equal(renewed.body.recoveryCodes.length, 10);
  assert.equal(f.state.cfg.factor_id, FACTOR);
  assert.equal(f.state.recovery.has(await tokenHash(RECOVERY)), false);
  await assert.rejects(verifyOwnerAccess(f.db, original.token));
  assert.equal((await verifyOwnerAccess(f.db, renewed.body.token)).id, UID);
  const creation = f.state.calls
    .filter((call) => call.op === "session.create")
    .at(-1).p;
  assert.equal(creation.renew_recovery, true);
  assert.equal(creation.recovery_hashes.length, 10);
});

test("completion audit belongs to the commit command, not a fallible post-commit request", async () => {
  const f = await fixture();
  f.state.failAudit = true;
  const challengeId = await f.begin();
  const completed = await f.post("login.verify", {
    challengeId,
    emailCode: "123456",
    totpCode: "123456",
    renewRecoveryCodes: true,
  });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.recoveryCodes.length, 10);
  const creation = f.state.calls.find((call) => call.op === "session.create").p;
  assert.match(creation.ip_hash, /^[a-f0-9]{64}$/);
  assert.equal(creation.device, "Synthetic browser");
  assert.equal(f.state.calls.filter((call) => call.op === "log").length, 0);
});

test("expired challenges and repeated TOTP failures never reach session creation", async () => {
  const f = await fixture();
  const challengeId = await f.begin();
  for (let attempt = 0; attempt < 5; attempt++)
    assert.equal(
      (
        await f.post("login.verify", {
          challengeId,
          emailCode: "123456",
          totpCode: "000000",
        })
      ).status,
      401,
    );
  assert.equal(
    (
      await f.post("login.verify", {
        challengeId,
        emailCode: "123456",
        totpCode: "123456",
      })
    ).status,
    401,
  );
  const next = await f.begin();
  f.advance(300001);
  assert.equal(
    (
      await f.post("login.verify", {
        challengeId: next,
        emailCode: "123456",
        totpCode: "123456",
      })
    ).status,
    401,
  );
  assert.equal(f.state.sessions.size, 0);
});

test("session refresh rotates both opaque tokens, detects replay and retains the absolute deadline", async () => {
  const f = await fixture();
  const initial = await f.login();
  f.advance(14 * 60000);
  const refreshed = await f.post("session.refresh", {
    refreshToken: initial.refreshToken,
  });
  assert.equal(refreshed.status, 200);
  assert.notEqual(refreshed.body.token, initial.token);
  assert.notEqual(refreshed.body.refreshToken, initial.refreshToken);
  assert.equal(refreshed.body.refreshExpiresAt, initial.refreshExpiresAt);
  await assert.rejects(verifyOwnerAccess(f.db, initial.token));
  assert.equal((await verifyOwnerAccess(f.db, refreshed.body.token)).id, UID);
  assert.equal(
    (await f.post("session.refresh", { refreshToken: initial.refreshToken }))
      .status,
    401,
  );
  await assert.rejects(verifyOwnerAccess(f.db, refreshed.body.token));
});

test("native Auth revocation, expired absolute lifetime or refresh errors revoke application access", async () => {
  const f = await fixture();
  const credentials = await f.login();
  f.state.nativeAlive = false;
  await assert.rejects(verifyOwnerAccess(f.db, credentials.token));
  assert.equal(
    (
      await f.post("session.refresh", {
        refreshToken: credentials.refreshToken,
      })
    ).status,
    401,
  );
  const g = await fixture();
  const next = await g.login();
  g.advance(3600001);
  assert.equal(
    (await g.post("session.refresh", { refreshToken: next.refreshToken }))
      .status,
    401,
  );
  const h = await fixture();
  const last = await h.login();
  h.auth.refresh = async () => {
    throw Error("synthetic provider secret must not be returned");
  };
  const failed = await h.post("session.refresh", {
    refreshToken: last.refreshToken,
  });
  assert.equal(failed.status, 503);
  assert.equal(JSON.stringify(failed.body).includes("synthetic"), false);
  await assert.rejects(verifyOwnerAccess(h.db, last.token));
});

test("recovery consumes one hashed code and grants no access before a new native TOTP is proven", async () => {
  const f = await fixture();
  const challengeId = await f.begin();
  const recovery = await f.post("recovery.verify", {
    challengeId,
    emailCode: "123456",
    recoveryCode: RECOVERY,
    password: PASSWORD,
  });
  assert.equal(recovery.status, 200);
  assert.equal(recovery.body.enrollment.factorId, NEW_FACTOR);
  assert.equal(f.state.sessions.size, 0);
  assert.equal(f.state.recovery.get(await tokenHash(RECOVERY)), true);
  const order = f.state.providerCalls.map((call) => call.op);
  assert.ok(
    order.indexOf("password", order.indexOf("email")) <
      order.indexOf("deleteFactor"),
  );
  assert.ok(order.lastIndexOf("password") > order.indexOf("deleteFactor"));
  const finished = await f.post("recovery.finish", {
    challengeId,
    totpCode: "123456",
  });
  assert.equal(finished.status, 200);
  assert.equal(finished.body.recoveryCodes.length, 10);
  assert.equal(f.state.cfg.factor_id, NEW_FACTOR);
  assert.equal(f.state.recovery.has(await tokenHash(RECOVERY)), false);
});

test("a wrong repeated recovery password does not consume its code or remove native factors", async () => {
  const f = await fixture();
  const challengeId = await f.begin();
  assert.equal(
    (
      await f.post("recovery.verify", {
        challengeId,
        emailCode: "123456",
        recoveryCode: RECOVERY,
        password: "incorrect-password",
      })
    ).status,
    401,
  );
  assert.equal(f.state.recovery.get(await tokenHash(RECOVERY)), false);
  assert.equal(
    f.state.providerCalls.some((call) => call.op === "deleteFactor"),
    false,
  );
});

test("recovery resumes after a provider failure and replays saved enrollment without burning another code", async () => {
  const f = await fixture();
  const challengeId = await f.begin();
  const data = {
    challengeId,
    emailCode: "123456",
    recoveryCode: RECOVERY,
    password: PASSWORD,
  };
  const remove = f.auth.deleteFactor;
  let first = true;
  f.auth.deleteFactor = async (...args) => {
    if (first) {
      first = false;
      throw Error("synthetic temporary provider failure");
    }
    return remove(...args);
  };
  assert.equal((await f.post("recovery.verify", data)).status, 503);
  assert.equal([...f.state.challenges.values()][0].kind, "recovery");
  const resumed = await f.post("recovery.verify", data);
  assert.equal(resumed.status, 200);
  const repeated = await f.post("recovery.verify", data);
  assert.equal(repeated.status, 200);
  assert.deepEqual(repeated.body.enrollment, resumed.body.enrollment);
  assert.equal(
    f.state.calls.filter((call) => call.op === "recovery.consume").length,
    1,
  );
  assert.equal(
    f.state.providerCalls.filter((call) => call.op === "enroll").length,
    1,
  );
  assert.equal(
    (await f.post("recovery.finish", { challengeId, totpCode: "123456" }))
      .status,
    200,
  );
});

test("logout-all revokes local access before native logout and never reports success on provider failure", async () => {
  const f = await fixture();
  const credentials = await f.login();
  f.auth.logout = async () => {
    throw Error("synthetic provider failure");
  };
  assert.equal(
    (await f.post("logout.all", { token: credentials.token })).status,
    503,
  );
  await assert.rejects(verifyOwnerAccess(f.db, credentials.token));
  const g = await fixture();
  const second = await g.login();
  assert.equal(
    (await g.post("logout.all", { token: second.token })).status,
    200,
  );
  assert.ok(
    g.state.providerCalls.some(
      (call) => call.op === "logout" && call.all === true,
    ),
  );
});

test("rate limiting and errors do not reveal raw IP, password, tokens or provider messages", async () => {
  const f = await fixture();
  f.state.blocked = true;
  const limited = await f.post("login.begin", { password: PASSWORD });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "900");
  assert.equal(f.state.providerCalls.length, 0);
  const g = await fixture();
  g.auth.password = async () => {
    throw Object.assign(Error("synthetic private provider value"), {
      code: "INVALID_PROOF",
      status: 401,
    });
  };
  const denied = await g.post("login.begin", { password: PASSWORD });
  assert.equal(denied.status, 401);
  assert.equal(JSON.stringify(denied.body).includes("synthetic"), false);
  const logs = JSON.stringify(g.state.calls);
  assert.equal(logs.includes("192.0.2.20"), false);
  assert.equal(logs.includes(PASSWORD), false);
});
