import test from "node:test";
import assert from "node:assert/strict";
import { handle } from "../backend/uniflow-api.mjs";
import {
  handle as legacyHandle,
  LEGACY_WRITES_ENABLED,
} from "../backend/admin.mjs";
import { hashPassword, sha } from "../backend/security.mjs";
const token = "a".repeat(64);
const ownerToken = "ow1a." + "b".repeat(64);
const ownerId = "11111111-1111-4111-8111-111111111111";
const state = () => ({
  revision: 7,
  data: {
    groups: [{ id: "g", name: "Group", subgroups: ["А", "Б"] }],
    teachers: [{ id: "t1", name: "Teacher", subjects: ["s"] }],
    subjects: [{ id: "s", name: "Subject" }],
    rooms: [{ id: "r", name: "101", capacity: 30 }],
    lessons: [
      {
        id: "l",
        day: 0,
        week: "all",
        start: "09:00",
        end: "09:50",
        groupId: "g",
        subgroup: "all",
        subjectId: "s",
        teacherId: "t1",
        roomId: "r",
        type: "Lecture",
      },
    ],
    exceptions: [],
    tasks: [],
    announcements: [],
    requests: [],
    attendance: [],
    history: [],
  },
});
const request = (body) =>
  new Request("https://edge.invalid/uniflow-api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
function backend(t, options = {}) {
  const calls = [];
  const row = state();
  const oldDeno = globalThis.Deno;
  globalThis.Deno = {
    env: {
      get: (n) =>
        n === "SUPABASE_URL"
          ? "https://test.invalid"
          : n === "SUPABASE_SERVICE_ROLE_KEY"
            ? "server-only-test-key"
            : undefined,
    },
  };
  t.after(() => {
    if (oldDeno === undefined) delete globalThis.Deno;
    else globalThis.Deno = oldDeno;
  });
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const path = String(url).split("/rest/v1/")[1];
    const payload = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, method: init.method || "GET", payload });
    if (options.respond) {
      const custom = await options.respond(path, payload, init);
      if (custom) return custom;
    }
    let result = [];
    if (path === "rpc/owner_access_command") {
      result = options.expired
        ? { error: "INVALID_PROOF" }
        : {
            id: "22222222-2222-4222-8222-222222222222",
            owner_uid: ownerId,
            owner_email: "arappayevv@gmail.com",
            native_session_id: "33333333-3333-4333-8333-333333333333",
            expires_at: "2099-01-01T00:00:00Z",
          };
    } else if (path.startsWith("uf_platform?")) result = [row];
    else if (path.startsWith("uf_sessions?") && init.method !== "DELETE")
      result = options.expired ? [] : [{ user_id: options.userId || "admin" }];
    else if (path.startsWith("schedule_sessions?") && init.method !== "DELETE")
      result = options.expired ? [] : [{ expires_at: "2099-01-01T00:00:00Z" }];
    else if (path === "rpc/uf_login_attempt")
      result = options.allowLogin !== false;
    else if (path === "rpc/uf_create_session") result = true;
    else if (path.startsWith("schedule_settings?"))
      result = options.settings ? [options.settings] : [];
    else if (path.startsWith("uf_accounts?id="))
      result = [
        {
          id: "account-t",
          role: options.accountRole || "teacher",
          teacher_id: options.teacherId || "t1",
          name: "Teacher",
          active: true,
          ...options.settings,
        },
      ];
    else if (path.startsWith("uf_accounts?username="))
      result = options.settings
        ? [
            {
              id: "account-t",
              role: "teacher",
              name: "Teacher",
              ...options.settings,
            },
          ]
        : [];
    else if (path === "rpc/uf_commit")
      result = { data: payload.p_data, revision: row.revision + 1 };
    return new Response(result === null ? "" : JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { calls, row };
}
test("HTTP guest cannot impersonate admin or write with no token", async (t) => {
  const { calls } = backend(t);
  const res = await handle(
    request({
      action: "mutate",
      role: "admin",
      user: { role: "admin" },
      revision: 7,
      op: "lesson.delete",
      payload: { id: "l" },
    }),
  );
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});
test("HTTP teacher can cancel own lesson but cross-teacher attempt fails", async (t) => {
  const { calls } = backend(t, { userId: "account-t", teacherId: "other" });
  const res = await handle(
    request({
      action: "mutate",
      token,
      revision: 7,
      op: "exception.save",
      payload: { lessonId: "l", date: "2026-11-09", status: "cancelled" },
    }),
  );
  assert.equal(res.status, 403);
  assert.equal(
    calls.some((c) => c.path === "rpc/uf_commit"),
    false,
  );
});
test("HTTP public all subgroup is preserved and returns no session/account lists", async (t) => {
  backend(t);
  const res = await handle(
    request({ action: "state", groupId: "g", subgroup: "all" }),
  );
  const body = await res.json();
  assert.equal(body.user.subgroup, "all");
  assert.deepEqual(body.users, []);
  assert.deepEqual(body.versions, []);
});
test("HTTP stale revisions fail before save, and a commit race maps to 409", async (t) => {
  const { calls } = backend(t, {
    respond: (path) =>
      path === "rpc/uf_commit"
        ? new Response('{"message":"version_conflict"}', { status: 400 })
        : null,
  });
  const stale = await handle(
    request({
      action: "mutate",
      token: ownerToken,
      revision: 6,
      op: "exception.save",
      payload: { lessonId: "l", date: "2026-11-09", status: "cancelled" },
    }),
  );
  assert.equal(stale.status, 409);
  assert.equal(
    calls.some((c) => c.path === "rpc/uf_commit"),
    false,
  );
  const race = await handle(
    request({
      action: "mutate",
      token: ownerToken,
      revision: 7,
      op: "exception.save",
      payload: { lessonId: "l", date: "2026-11-09", status: "cancelled" },
    }),
  );
  assert.equal(race.status, 409);
});
test("HTTP expired sessions cannot mutate and do not reach commit", async (t) => {
  const { calls } = backend(t, { expired: true });
  const res = await handle(
    request({
      action: "mutate",
      token: ownerToken,
      revision: 7,
      op: "lesson.delete",
      payload: { id: "l" },
    }),
  );
  assert.equal(res.status, 401);
  assert.equal(
    calls.some((c) => c.path === "rpc/uf_commit"),
    false,
  );
});
test("logout.all uses one transactional revocation for both admin session stores", async (t) => {
  const { calls } = backend(t);
  assert.equal(
    (await handle(request({ action: "logout.all", token }))).status,
    200,
  );
  assert.deepEqual(
    calls.find((c) => c.path === "rpc/uf_revoke_sessions").payload,
    { p_user_id: "admin" },
  );
  assert.equal(
    (await legacyHandle(request({ action: "logout.all", token }))).status,
    200,
  );
  assert.equal(
    calls.filter((c) => c.path === "rpc/uf_revoke_sessions").length,
    2,
  );
});
test("non-admin password rotation remains atomic and never sends plaintext new password to the database", async (t) => {
  const current = "test-fixture-current",
    next = "test-fixture-replacement",
    salt = "0".repeat(32);
  const settings = { salt, password_hash: await hashPassword(current, salt) };
  const { calls } = backend(t, { settings, userId: "account-t" });
  const res = await handle(
    request({
      action: "password.change",
      token,
      currentPassword: current,
      password: next,
    }),
  );
  assert.equal(res.status, 200);
  const call = calls.find((c) => c.path === "rpc/uf_change_password");
  assert.equal(call.payload.p_user_id, "account-t");
  assert.match(call.payload.p_hash, /^[a-f0-9]{64}$/);
  assert.equal(
    call.payload.p_hash,
    await hashPassword(next, call.payload.p_salt),
  );
  assert.equal(JSON.stringify(calls).includes(next), false);
});
test("non-admin login reserves atomic limiter slot and stores only token hash via race-safe RPC", async (t) => {
  const pass = "test-fixture-current",
    salt = "0".repeat(32),
    password_hash = await hashPassword(pass, salt);
  const { calls } = backend(t, { settings: { salt, password_hash } });
  const res = await handle(
    request({ action: "login", username: "teacher-fixture", password: pass }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.token, /^[a-f0-9]{64}$/);
  const created = calls.find((c) => c.path === "rpc/uf_create_session");
  assert.equal(created.payload.p_token_hash, await sha(body.token));
  assert.equal(created.payload.p_expected_hash, password_hash);
  assert.equal(created.payload.p_legacy, false);
  assert.match(calls[0].payload.p_ip_hash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(calls).includes(body.token), false);
});
test("limited login returns 429 after delay without reading credentials", async (t) => {
  const { calls } = backend(t, { allowLogin: false });
  const start = performance.now();
  const res = await handle(
    request({
      action: "login",
      username: "teacher-fixture",
      password: "test-fixture-wrong",
    }),
  );
  assert.equal(res.status, 429);
  assert.ok(performance.now() - start >= 400);
  assert.deepEqual(
    calls.map((c) => c.path),
    ["rpc/uf_login_attempt"],
  );
});
test("unknown accounts do not issue a session and share generic login error", async (t) => {
  const { calls } = backend(t);
  const res = await handle(
    request({
      action: "login",
      username: "unknown",
      password: "test-fixture-wrong",
    }),
  );
  assert.equal(res.status, 401);
  assert.equal(
    calls.some((c) => c.path === "rpc/uf_create_session"),
    false,
  );
  assert.match((await res.json()).error, /Неверный логин или пароль/);
});
test("import cannot orphan existing role accounts", async (t) => {
  const { row, calls } = backend(t, {
    respond: (path) =>
      path === "uf_accounts?select=role,group_id,subgroup,teacher_id"
        ? new Response(
            JSON.stringify([
              { role: "student", group_id: "missing", subgroup: "А" },
            ]),
          )
        : null,
  });
  const res = await handle(
    request({
      action: "mutate",
      token: ownerToken,
      revision: 7,
      op: "import",
      payload: { data: row.data },
    }),
  );
  assert.equal(res.status, 400);
  assert.equal(
    calls.some((c) => c.path === "rpc/uf_commit"),
    false,
  );
});

test("archived legacy editor rejects authenticated saves before any timetable write", async (t) => {
  const { calls } = backend(t);
  assert.equal(LEGACY_WRITES_ENABLED, false);
  const response = await legacyHandle(
    request({ action: "save", token, revision: 3, data: { old: "draft" } }),
  );
  assert.equal(response.status, 410);
  assert.equal(
    (await response.json()).error,
    "Прежний редактор отключён. Открой /schedule/admin/.",
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].path, /^schedule_sessions\?/);
  assert.equal(
    calls.some((call) => call.method !== "GET"),
    false,
  );
  assert.equal(
    calls.some((call) => call.path.startsWith("group_schedule")),
    false,
  );
});

test("archived legacy editor still verifies a session before explaining save cutover", async (t) => {
  const { calls } = backend(t, { expired: true });
  const response = await legacyHandle(
    request({ action: "save", token, revision: 3, data: {} }),
  );
  assert.equal(response.status, 401);
  assert.equal(
    calls.some((call) => call.method !== "GET"),
    false,
  );
});

test("legacy password login is retired without reading a password or issuing a session", async (t) => {
  const password = "test-fixture-legacy",
    salt = "0".repeat(32);
  const password_hash = await hashPassword(password, salt);
  const { calls } = backend(t, { settings: { salt, password_hash } });
  const response = await legacyHandle(request({ action: "login", password }));
  assert.equal(response.status, 410);
  const body = await response.json();
  assert.equal(body.token, undefined);
  assert.deepEqual(calls, []);
});

test("the old shared admin token and additional admin roles cannot read protected state or mutate", async (t) => {
  const { calls } = backend(t);
  for (const action of ["state", "mutate", "account.save", "rollback"]) {
    const response = await handle(
      request({
        action,
        token,
        revision: 7,
        role: "admin",
        user: { id: ownerId, role: "admin" },
      }),
    );
    assert.equal(response.status, 401);
  }
  assert.equal(
    calls.some(
      (call) => call.path === "rpc/uf_commit" || call.method === "PATCH",
    ),
    false,
  );
});

test("a legacy account carrying admin role cannot become the owner", async (t) => {
  const { calls } = backend(t, { userId: "shadow", accountRole: "admin" });
  const response = await handle(request({ action: "state", token }));
  assert.equal(response.status, 401);
  assert.equal(
    calls.some((call) => call.path === "rpc/owner_access_command"),
    false,
  );
});

test("only a verified owner session supplies administrative identity and cannot create another admin", async (t) => {
  const { calls } = backend(t);
  const stateResponse = await handle(
    request({ action: "state", token: ownerToken, user: { id: "attacker" } }),
  );
  assert.equal(stateResponse.status, 200);
  const snapshot = await stateResponse.json();
  assert.equal(snapshot.user.id, ownerId);
  assert.equal(snapshot.user.email, "arappayevv@gmail.com");
  assert.equal(snapshot.user.role, "admin");
  const create = await handle(
    request({
      action: "account.save",
      token: ownerToken,
      account: { role: "admin", username: "another-admin" },
    }),
  );
  assert.equal(create.status, 403);
  assert.equal(
    calls.some((call) => call.path === "uf_accounts" && call.method === "POST"),
    false,
  );
  const retiredPasswordForm = await handle(
    request({
      action: "password.change",
      token: ownerToken,
      currentPassword: "fixture",
      password: "replacement-fixture",
    }),
  );
  assert.equal(retiredPasswordForm.status, 410);
  assert.equal(
    calls.some(
      (call) =>
        call.path === "rpc/uf_change_password" ||
        call.path.startsWith("schedule_settings?"),
    ),
    false,
  );
});

test("the shared admin password route cannot bypass owner authentication", async (t) => {
  const { calls } = backend(t);
  const response = await handle(
    request({ action: "login", username: "admin", password: "fixture" }),
  );
  assert.equal(response.status, 410);
  assert.deepEqual(calls, []);
});

test("archive policy preserves logout of the current legacy session", async (t) => {
  const { calls } = backend(t);
  const response = await legacyHandle(request({ action: "logout", token }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  const writes = calls.filter((call) => call.method !== "GET");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, "DELETE");
  assert.equal(
    writes[0].path,
    "schedule_sessions?token_hash=eq." + (await sha(token)),
  );
});
