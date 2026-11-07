import test from "node:test";
import assert from "node:assert/strict";
import {
  OWNER_EMAIL,
  createSecretBox,
  privateIpHash,
  tokenHash,
  randomOpaque,
  isAccessToken,
  isRefreshToken,
  assertPassword,
  parseEmailProof,
  verifyOwnerAccess,
  ownerCommand,
  serverConfiguration,
  createAuthProvider,
} from "../backend/owner-access.mjs";

const UID = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const FACTOR = "33333333-3333-4333-8333-333333333333";
const APP_SESSION = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";
const NOW = Date.parse("2026-11-08T05:00:00Z");
const API = "https://testproject.supabase.co";
const configuration = {
  api: API,
  key: "synthetic-server-key",
  adminKey: "synthetic-admin-key",
};
const secret = "synthetic-server-secret-for-tests-only";
const user = (overrides = {}) => ({
  id: UID,
  email: OWNER_EMAIL,
  email_confirmed_at: "2026-11-08T04:00:00Z",
  is_anonymous: false,
  ...overrides,
});
const claims = (overrides = {}) => ({
  sub: UID,
  iss: API + "/auth/v1",
  aud: "authenticated",
  exp: NOW / 1000 + 900,
  session_id: SESSION,
  aal: "aal1",
  amr: [{ method: "password", timestamp: NOW / 1000 }],
  ...overrides,
});
const encode = (value) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (value) =>
  encode({ alg: "test" }) + "." + encode(value) + ".synthetic";
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("provider credentials are encrypted with random nonces and bound to purpose and key", async () => {
  const box = await createSecretBox(secret);
  const value = {
    access_token: "synthetic-sensitive-value",
    refresh_token: "other-sensitive-value",
  };
  const first = await box.seal(value, "pending-A");
  const second = await box.seal(value, "pending-A");
  assert.notEqual(first, second);
  assert.equal(first.includes(value.access_token), false);
  assert.deepEqual(await box.open(first, "pending-A"), value);
  await assert.rejects(box.open(first, "pending-B"));
  await assert.rejects(
    (await createSecretBox(secret + "rotated")).open(first, "pending-A"),
  );
  await assert.rejects(box.open(first.slice(0, -4) + "AAAA", "pending-A"));
  await assert.rejects(createSecretBox("too-short"));
});

test("IP hashes are keyed and tokens use independent opaque namespaces", async () => {
  const ip = "192.0.2.10";
  const first = await privateIpHash(secret, ip);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first.includes(ip), false);
  assert.notEqual(first, await tokenHash(ip));
  assert.notEqual(first, await privateIpHash(secret + "different", ip));
  assert.equal(first, await privateIpHash(secret, ip));
  const access = randomOpaque("ow1a.");
  assert.ok(isAccessToken(access));
  assert.equal(isRefreshToken(access), false);
  assert.ok(isRefreshToken(randomOpaque("ow1r.")));
  assert.notEqual(access, randomOpaque("ow1a."));
  assert.equal(isAccessToken("a".repeat(64)), false);
  assert.throws(() => assertPassword("short"));
  assert.throws(() => assertPassword("x".repeat(129)));
  assert.doesNotThrow(() => assertPassword("x".repeat(12)));
});

test("email links are parsed as data, allowlisted by project and verification path", () => {
  const token = "a".repeat(64);
  const valid =
    API +
    "/auth/v1/verify?token=" +
    token +
    "&type=invite&redirect_to=https://attacker.invalid/";
  assert.deepEqual(parseEmailProof(valid, API, ["invite"]), {
    type: "invite",
    token_hash: token,
  });
  assert.deepEqual(parseEmailProof("123456", API, ["email"]), {
    type: "email",
    token: "123456",
  });
  for (const value of [
    valid.replace("https:", "http:"),
    valid.replace("testproject.supabase.co", "attacker.invalid"),
    valid.replace("/auth/v1/verify", "/redirect"),
    valid.replace("https://", "https://user:password@"),
    valid.replace("type=invite", "type=signup"),
    API + "/auth/v1/verify?token=x&type=invite",
    "file:///etc/passwd",
    "javascript:alert(1)",
  ])
    assert.throws(() => parseEmailProof(value, API, ["invite"]));
});

test("server configuration rejects untrusted API destinations and missing key material", () => {
  const env = (values) => ({ get: (key) => values[key] });
  assert.equal(
    serverConfiguration(
      env({ SUPABASE_URL: API, SUPABASE_SERVICE_ROLE_KEY: secret }),
    ).api,
    API,
  );
  for (const url of [
    "http://testproject.supabase.co",
    "https://attacker.invalid",
    API + "/path",
    "https://user:pass@testproject.supabase.co",
  ])
    assert.throws(() =>
      serverConfiguration(
        env({ SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: secret }),
      ),
    );
  assert.throws(() => serverConfiguration(env({ SUPABASE_URL: API })));
});

test("owner actor never accepts legacy tokens or a different server identity", async () => {
  let calls = 0;
  const valid = {
    id: APP_SESSION,
    owner_uid: UID,
    owner_email: OWNER_EMAIL,
    native_session_id: SESSION,
    encrypted_state: "private",
    expires_at: "later",
  };
  const db = async () => {
    calls++;
    return valid;
  };
  await assert.rejects(verifyOwnerAccess(db, "a".repeat(64)));
  assert.equal(calls, 0);
  const result = await verifyOwnerAccess(db, randomOpaque("ow1a."));
  assert.equal(result.id, UID);
  assert.equal(result.role, "admin");
  assert.equal("encrypted_state" in result, false);
  await assert.rejects(
    verifyOwnerAccess(
      async () => ({ ...valid, owner_email: "other@example.invalid" }),
      randomOpaque("ow1a."),
    ),
  );
  await assert.rejects(
    verifyOwnerAccess(
      async () => ({ error: "INVALID_PROOF" }),
      randomOpaque("ow1a."),
    ),
  );
  await assert.rejects(
    ownerCommand(
      async () => ({ error: "constructor", detail: "sensitive" }),
      "state",
    ),
    (e) => e.code === "UNAVAILABLE" && !e.message.includes("sensitive"),
  );
});

test("JWT claims are never accepted before Auth verifies the signature and current owner", async () => {
  let calls = 0;
  const provider = createAuthProvider(
    configuration,
    async (url) => {
      calls++;
      assert.equal(url, API + "/auth/v1/user");
      return json({ message: "synthetic provider secret" }, 401);
    },
    () => NOW,
  );
  await assert.rejects(
    provider.verified(
      jwt(claims({ aal: "aal2", user_metadata: { role: "admin" } })),
    ),
    (e) => !e.message.includes("synthetic"),
  );
  assert.equal(calls, 1);
  for (const identity of [
    user({ id: OTHER }),
    user({ email: "other@example.invalid" }),
    user({ email_confirmed_at: null }),
    user({ is_anonymous: true }),
    user({ phone: "+12025550123" }),
  ]) {
    const checked = createAuthProvider(
      configuration,
      async () => json(identity),
      () => NOW,
    );
    await assert.rejects(checked.verified(jwt(claims())));
  }
});

test("verified JWT still requires matching issuer, audience, expiry, session and fresh proof method", async () => {
  const provider = createAuthProvider(
    configuration,
    async () => json(user()),
    () => NOW,
  );
  for (const overrides of [
    { iss: "https://attacker.invalid/auth/v1" },
    { aud: "anon" },
    { exp: NOW / 1000 - 1 },
    { session_id: "invalid" },
    { sub: OTHER },
    { amr: [{ method: "oauth", timestamp: NOW / 1000 }] },
    { amr: [{ method: "password", timestamp: NOW / 1000 - 600 }] },
  ])
    await assert.rejects(
      provider.verified(jwt(claims(overrides)), {
        method: "password",
        since: NOW - 60000,
      }),
    );
  const accepted = await provider.verified(jwt(claims()), {
    method: "password",
    since: NOW - 60000,
  });
  assert.equal(accepted.user.id, UID);
  await assert.rejects(provider.verified(jwt(claims()), { aal: "aal2" }));
});

test("email verification never follows an input link or accepts password authentication as email proof", async () => {
  const urls = [];
  const token = jwt(
    claims({
      session_id: OTHER,
      amr: [{ method: "otp", timestamp: NOW / 1000 }],
    }),
  );
  const provider = createAuthProvider(
    configuration,
    async (url, init) => {
      urls.push(url);
      if (url.endsWith("/verify")) {
        assert.deepEqual(JSON.parse(init.body), {
          type: "magiclink",
          token_hash: "b".repeat(64),
        });
        return json({
          access_token: token,
          refresh_token: "synthetic-refresh",
        });
      }
      if (url.endsWith("/user")) return json(user());
      throw Error("Unexpected destination");
    },
    () => NOW,
  );
  await provider.email(
    API + "/auth/v1/verify?type=magiclink&token=" + "b".repeat(64),
    { since: NOW - 1000 },
  );
  assert.deepEqual(urls, [API + "/auth/v1/verify", API + "/auth/v1/user"]);
  await assert.rejects(provider.email(jwt(claims()), { since: NOW - 1000 }));
});

test("the email-only invariant rejects SMS-bound profiles, OAuth and phone MFA as email proof", async () => {
  const fresh = { since: NOW - 1000 };
  const otp = jwt(claims({ amr: [{ method: "otp", timestamp: NOW / 1000 }] }));
  const phoneBound = createAuthProvider(
    configuration,
    async () => json(user({ phone: "+12025550123" })),
    () => NOW,
  );
  await assert.rejects(
    phoneBound.email(otp, fresh),
    (error) => error.code === "ACCESS_DENIED",
  );
  const emailOnly = createAuthProvider(
    configuration,
    async () => json(user({ phone: "" })),
    () => NOW,
  );
  for (const method of ["mfa/phone", "oauth", "password"])
    await assert.rejects(
      emailOnly.email(
        jwt(claims({ amr: [{ method, timestamp: NOW / 1000 }] })),
        fresh,
      ),
    );
  assert.equal((await emailOnly.email(otp, fresh)).identity.user.id, UID);
});

test("native password and mail operations always select the fixed owner server-side", async () => {
  const sent = [];
  const token = jwt(claims());
  const provider = createAuthProvider(
    configuration,
    async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      sent.push({ url, body });
      if (url.endsWith("/user")) return json(user());
      if (url.includes("/token?"))
        return json({
          access_token: token,
          refresh_token: "synthetic-refresh",
        });
      if (url.includes("/invite?"))
        return json(user({ email_confirmed_at: null }));
      if (url.includes("/otp?")) return json({});
      throw Error("Unexpected operation");
    },
    () => NOW,
  );
  await provider.password("synthetic-password-only");
  await provider.invite("other@example.invalid");
  await provider.sendEmail("other@example.invalid");
  for (const entry of sent.filter((entry) => entry.body))
    assert.equal(entry.body.email, OWNER_EMAIL);
  assert.equal(
    sent.find((entry) => entry.url.includes("/otp?")).body.create_user,
    false,
  );
});

test("native TOTP must upgrade the original password session, never another email session", async () => {
  const inputToken = jwt(claims());
  const upgraded = (id) =>
    jwt(
      claims({
        aal: "aal2",
        session_id: id,
        amr: [
          { method: "totp", timestamp: NOW / 1000 },
          { method: "password", timestamp: NOW / 1000 },
        ],
      }),
    );
  for (const nativeId of [SESSION, OTHER]) {
    const provider = createAuthProvider(
      configuration,
      async (url, init) => {
        if (url.endsWith("/user")) return json(user());
        assert.equal(init.headers.Authorization, "Bearer " + inputToken);
        if (url.endsWith("/challenge")) return json({ id: APP_SESSION });
        if (url.endsWith("/verify"))
          return json({
            access_token: upgraded(nativeId),
            refresh_token: "synthetic-refresh",
          });
        throw Error("Unexpected operation");
      },
      () => NOW,
    );
    const pending = {
      access_token: inputToken,
      identity: { claims: claims() },
    };
    if (nativeId === SESSION)
      assert.equal(
        (await provider.totp(pending, FACTOR, "123456")).identity.claims.aal,
        "aal2",
      );
    else await assert.rejects(provider.totp(pending, FACTOR, "123456"));
  }
});

test("admin factor removal validates identifiers and tolerates a previously removed factor", async () => {
  let calls = 0;
  const provider = createAuthProvider(
    configuration,
    async (url, init) => {
      calls++;
      assert.equal(
        url,
        API + "/auth/v1/admin/users/" + UID + "/factors/" + FACTOR,
      );
      assert.equal(init.method, "DELETE");
      assert.equal(
        init.headers.Authorization,
        "Bearer " + configuration.adminKey,
      );
      return json({ error: "not found" }, 404);
    },
    () => NOW,
  );
  await assert.rejects(provider.deleteFactor("../other", FACTOR));
  assert.equal(calls, 0);
  await assert.doesNotReject(provider.deleteFactor(UID, FACTOR));
});

test("new secret keys remain apikey headers and are never used as JWT bearer credentials", async () => {
  const syntheticKey = "sb_secret_" + "synthetic-key-for-test-only";
  const secretConfiguration = {
    api: API,
    key: syntheticKey,
    adminKey: syntheticKey,
  };
  const provider = createAuthProvider(
    secretConfiguration,
    async (_url, init) => {
      assert.equal(init.headers.apikey, secretConfiguration.key);
      assert.equal(init.headers.Authorization, undefined);
      return json(user({ email_confirmed_at: null }));
    },
    () => NOW,
  );
  await provider.invite();
});

test("mail configuration failures have actionable nonsecret errors while provider limits retain retry semantics", async () => {
  for (const status of [400, 401, 422, 500]) {
    const provider = createAuthProvider(
      configuration,
      async () => json({ message: "synthetic provider secret" }, status),
      () => NOW,
    );
    await assert.rejects(
      provider.invite(),
      (e) =>
        e.code === "MAIL_UNAVAILABLE" &&
        e.status === 503 &&
        !e.message.includes("synthetic"),
    );
    await assert.rejects(
      provider.sendEmail(),
      (e) =>
        e.code === "MAIL_UNAVAILABLE" &&
        e.status === 503 &&
        !e.message.includes("synthetic"),
    );
  }
  const limited = createAuthProvider(
    configuration,
    async () => json({}, 429),
    () => NOW,
  );
  await assert.rejects(
    limited.sendEmail(),
    (e) => e.code === "RATE_LIMITED" && e.status === 429,
  );
});
