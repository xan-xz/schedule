import test from "node:test";
import assert from "node:assert/strict";
import { handle } from "../backend/uniflow-api.mjs";
import {
  handle as legacyHandle,
  LEGACY_WRITES_ENABLED,
} from "../backend/admin.mjs";
import { sha } from "../backend/security.mjs";
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
const request = (body, headers = {}) =>
  new Request("https://edge.invalid/uniflow-api", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
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
test("HTTP legacy teacher cannot cancel even their own lesson or impersonate the owner", async (t) => {
  const { calls } = backend(t, { userId: "account-t", teacherId: "t1" });
  for (const teacherId of ["t1", "other"])
    assert.equal(
      (
        await handle(
          request({
            action: "mutate",
            token,
            revision: 7,
            op: "exception.save",
            role: "admin",
            user: { id: ownerId, role: "admin", teacherId },
            payload: { lessonId: "l", date: "2026-11-09", status: "cancelled" },
          }),
        )
      ).status,
      401,
    );
  assert.deepEqual(calls, []);
});

test("HTTP public all subgroup is preserved and returns no session/account lists", async (t) => {
  const { calls } = backend(t);
  const res = await handle(
    request({
      action: "state",
      groupId: "g",
      subgroup: "all",
      role: "admin",
      user: { id: ownerId, role: "admin" },
    }),
  );
  const body = await res.json();
  assert.equal(body.user.subgroup, "all");
  assert.deepEqual(body.users, []);
  assert.deepEqual(body.versions, []);
  assert.equal(body.user.id, "guest");
  assert.equal(body.user.role, "guest");
  assert.deepEqual(
    calls.map((call) => call.path),
    ["uf_platform?id=eq.1"],
  );
});

test("localhost preview can preflight and read only the fixed guest projection", async (t) => {
  const { calls, row } = backend(t);
  const origin = "http://127.0.0.1:4173";
  const preflight = await handle(
    new Request("https://edge.invalid/uniflow-api", {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,apikey",
      },
    }),
  );
  assert.equal(preflight.status, 200);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(
    preflight.headers.has("Access-Control-Allow-Credentials"),
    false,
  );
  assert.deepEqual(calls, []);
  row.data.history = [{ id: "private", summary: "private audit" }];
  row.data.requests = [{ id: "private", teacherId: "t1" }];
  row.data.attendance = [{ studentId: "former-student", lessonId: "l" }];
  const response = await handle(
    request(
      {
        action: "state",
        groupId: "g",
        subgroup: "all",
        role: "admin",
        user: { id: ownerId, role: "admin" },
      },
      { Origin: origin },
    ),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(response.headers.has("Access-Control-Allow-Credentials"), false);
  const snapshot = await response.json();
  assert.equal(snapshot.user.id, "guest");
  assert.equal(snapshot.user.role, "guest");
  for (const key of ["history", "requests", "attendance"])
    assert.deepEqual(snapshot.data[key], []);
  assert.deepEqual(snapshot.users, []);
  assert.deepEqual(snapshot.versions, []);
  assert.deepEqual(
    calls.map((call) => call.path),
    ["uf_platform?id=eq.1"],
  );
});

test("every protected POST rejects an untrusted Origin before actor or database IO", async (t) => {
  const { calls } = backend(t);
  const operations = [
    { action: "state", token: ownerToken },
    { action: "state", token },
    {
      action: "mutate",
      token: ownerToken,
      revision: 7,
      op: "lesson.delete",
      payload: { id: "l" },
    },
    { action: "rollback", token: ownerToken, revision: 7, target: 3 },
    { action: "account.save", token: ownerToken },
    { action: "password.change", token: ownerToken },
    { action: "logout", token: ownerToken },
    { action: "logout.all", token },
  ];
  for (const origin of [
    "http://127.0.0.1:4173",
    "https://other.test",
    "https://xan-xz.github.io.attacker.test",
    "null",
    "",
  ])
    for (const body of operations) {
      const response = await handle(request(body, { Origin: origin }));
      assert.equal(response.status, 403, origin + " " + body.action);
      assert.equal(
        response.headers.get("Access-Control-Allow-Origin"),
        "https://xan-xz.github.io",
      );
      assert.equal(
        response.headers.has("Access-Control-Allow-Credentials"),
        false,
      );
    }
  assert.deepEqual(calls, []);
});

test("the exact production Origin retains verified owner reads and writes", async (t) => {
  const { calls } = backend(t);
  const headers = { Origin: "https://xan-xz.github.io" };
  for (const body of [
    { action: "state", token: ownerToken },
    {
      action: "mutate",
      token: ownerToken,
      revision: 7,
      op: "exception.save",
      payload: { lessonId: "l", date: "2026-11-09", status: "cancelled" },
    },
  ]) {
    const response = await handle(request(body, headers));
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("Access-Control-Allow-Origin"),
      headers.Origin,
    );
    assert.equal(
      response.headers.has("Access-Control-Allow-Credentials"),
      false,
    );
    assert.equal((await response.json()).user.id, ownerId);
  }
  assert.equal(calls.filter((call) => call.path === "rpc/uf_commit").length, 1);
});

test("retired login keeps its constant no-IO response even for a foreign Origin", async (t) => {
  const { calls } = backend(t);
  const response = await handle(
    request(
      { action: "login", username: "admin", password: "fixture" },
      { Origin: "https://other.test" },
    ),
  );
  assert.equal(response.status, 410);
  assert.equal(
    response.headers.get("Access-Control-Allow-Origin"),
    "https://xan-xz.github.io",
  );
  assert.deepEqual(calls, []);
});

test("failed public reads retain restrictive error CORS instead of exposing server failures", async (t) => {
  const { calls } = backend(t, {
    respond: (path) =>
      path.startsWith("uf_platform?")
        ? new Response("provider failure", { status: 500 })
        : null,
  });
  const response = await handle(
    request({ action: "state" }, { Origin: "http://127.0.0.1:4173" }),
  );
  assert.equal(response.status, 503);
  assert.equal(
    response.headers.get("Access-Control-Allow-Origin"),
    "https://xan-xz.github.io",
  );
  assert.equal(response.headers.has("Access-Control-Allow-Credentials"), false);
  assert.equal(
    (await response.json()).error.includes("provider failure"),
    false,
  );
  assert.deepEqual(
    calls.map((call) => call.path),
    ["uf_platform?id=eq.1"],
  );
});

test("legacy logout revokes only the actual session identity for every former role", async (t) => {
  let actualId;
  const { calls } = backend(t, {
    respond: (path, _payload, init) =>
      path.startsWith("uf_sessions?") && init.method !== "DELETE"
        ? Response.json([{ user_id: actualId }])
        : null,
  });
  for (const id of [
    "admin",
    "former-teacher",
    "former-student",
    "former-disabled",
  ])
    for (const action of ["logout", "logout.all"]) {
      actualId = id;
      const before = calls.length;
      const response = await handle(
        request({
          action,
          token,
          userId: "victim",
          user: { id: ownerId },
          role: "admin",
        }),
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
      const actions = calls.slice(before);
      assert.equal(actions.length, 2);
      assert.match(actions[0].path, /&select=user_id$/u);
      if (action === "logout.all")
        assert.deepEqual(actions[1], {
          path: "rpc/uf_revoke_sessions",
          method: "POST",
          payload: { p_user_id: id },
        });
      else
        assert.deepEqual(actions[1], {
          path: "uf_sessions?token_hash=eq." + (await sha(token)),
          method: "DELETE",
          payload: null,
        });
    }
  assert.equal(
    calls.some(
      (call) =>
        call.path.startsWith("uf_accounts") ||
        call.path.startsWith("uf_platform"),
    ),
    false,
  );
  assert.equal(JSON.stringify(calls).includes(token), false);
});

test("expired legacy credentials cannot revoke another identity or access account data", async (t) => {
  const { calls } = backend(t, { expired: true });
  assert.equal(
    (await handle(request({ action: "logout.all", token, userId: "victim" })))
      .status,
    401,
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].path, /^uf_sessions\?/u);
  assert.equal(calls[0].method, "GET");
});

test("owner revocation keeps the native boundary and ignores a supplied user identity", async (t) => {
  const { calls } = backend(t);
  assert.equal(
    (
      await handle(
        request({ action: "logout.all", token: ownerToken, userId: "victim" }),
      )
    ).status,
    200,
  );
  assert.deepEqual(
    calls.map((call) => call.path),
    ["rpc/owner_access_command", "rpc/owner_access_command"],
  );
  assert.equal(calls[0].payload.p_op, "session.verify");
  assert.deepEqual(calls[1].payload, {
    p_op: "session.revoke",
    p: { id: "22222222-2222-4222-8222-222222222222", all: true },
  });
});

test("verified owner edits, imports and rolls back through the existing CAS transaction", async (t) => {
  let archived;
  const { calls, row } = backend(t, {
    respond: (path) =>
      path === "uf_versions?revision=eq.3"
        ? Response.json([{ revision: 3, data: archived }])
        : null,
  });
  archived = structuredClone(row.data);
  for (const body of [
    {
      action: "mutate",
      op: "exception.save",
      payload: { lessonId: "l", date: "2026-11-09", status: "cancelled" },
    },
    {
      action: "mutate",
      op: "import",
      payload: { data: structuredClone(row.data) },
    },
    { action: "rollback", target: 3 },
  ]) {
    const response = await handle(
      request({
        ...body,
        token: ownerToken,
        revision: 7,
        user: { id: "attacker", name: "attacker" },
      }),
    );
    assert.equal(response.status, 200, JSON.stringify(body));
    const snapshot = await response.json();
    assert.equal(snapshot.revision, 8);
    assert.equal(snapshot.user.id, ownerId);
    assert.deepEqual(snapshot.users, []);
  }
  const commits = calls.filter((call) => call.path === "rpc/uf_commit");
  assert.equal(commits.length, 3);
  assert.equal(
    commits.every(
      (call) =>
        call.payload.p_expected === 7 &&
        call.payload.p_actor === "Араппаев Азат",
    ),
    true,
  );
  assert.equal(
    calls.some(
      (call) =>
        call.path.includes("password") ||
        call.path.startsWith("schedule_settings"),
    ),
    false,
  );
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
test("legacy credentials cannot access any retired account or password route", async (t) => {
  const { calls } = backend(t, { userId: "account-t" });
  for (const action of [
    "account.save",
    "account.password",
    "account.delete",
    "account.reset",
    "password.change",
    "password.reset",
  ])
    assert.equal(
      (
        await handle(
          request({
            action,
            token,
            currentPassword: "fixture",
            password: "replacement-fixture",
            userId: ownerId,
          }),
        )
      ).status,
      401,
    );
  assert.deepEqual(calls, []);
});

test("every legacy username/password login is retired before credentials or session storage are read", async (t) => {
  const { calls } = backend(t, { allowLogin: false });
  const errors = [];
  for (const username of [
    "admin",
    "teacher-fixture",
    "student-fixture",
    "unknown",
    "bad username",
    "",
    null,
    { role: "admin" },
  ]) {
    const response = await handle(
      request({
        action: "login",
        username,
        password: "test-fixture",
        token: ownerToken,
      }),
    );
    assert.equal(response.status, 410);
    const body = await response.json();
    assert.equal(body.token, undefined);
    errors.push(body.error);
  }
  assert.equal(new Set(errors).size, 1);
  assert.deepEqual(calls, []);
});

test("retired login never evaluates credential shape or invokes the former limiter", async (t) => {
  const { calls } = backend(t);
  for (const password of [null, [], {}, true, "x".repeat(10000)])
    assert.equal(
      (await handle(request({ action: "login", password }))).status,
      410,
    );
  assert.deepEqual(calls, []);
});

test("malformed JSON, unsupported methods and preflight remain separate from retired login", async (t) => {
  const { calls } = backend(t);
  const invalid = await handle(
    new Request("https://edge.invalid/uniflow-api", {
      method: "POST",
      body: "{",
    }),
  );
  assert.equal(invalid.status, 400);
  assert.equal(
    (await handle(new Request("https://edge.invalid/uniflow-api"))).status,
    405,
  );
  const preflight = await handle(
    new Request("https://edge.invalid/uniflow-api", { method: "OPTIONS" }),
  );
  assert.equal(preflight.status, 200);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "*");
  assert.deepEqual(calls, []);
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
  const { calls } = backend(t);
  const response = await legacyHandle(
    request({ action: "login", password: "test-fixture-legacy" }),
  );
  assert.equal(response.status, 410);
  assert.equal((await response.json()).token, undefined);
  assert.deepEqual(calls, []);
});

test("all legacy roles and forged identity claims are rejected before any protected state lookup", async (t) => {
  const { calls } = backend(t);
  for (const role of ["admin", "teacher", "student", "guest"])
    for (const action of ["state", "mutate", "account.save", "rollback"])
      assert.equal(
        (
          await handle(
            request({
              action,
              token,
              revision: 7,
              role,
              user: { id: ownerId, role: "admin" },
            }),
          )
        ).status,
        401,
      );
  assert.deepEqual(calls, []);
});

test("a rejected opaque owner token cannot trigger a platform or account read", async (t) => {
  const { calls } = backend(t, { expired: true });
  const response = await handle(
    request({
      action: "state",
      token: ownerToken,
      role: "admin",
      user: { id: ownerId, role: "admin" },
    }),
  );
  assert.equal(response.status, 401);
  assert.deepEqual(
    calls.map((call) => call.path),
    ["rpc/owner_access_command"],
  );
  assert.equal(calls[0].payload.p_op, "session.verify");
});

test("only verified owner identity is returned and every former account/password operation is retired", async (t) => {
  const { calls } = backend(t);
  const response = await handle(
    request({
      action: "state",
      token: ownerToken,
      user: { id: "attacker", role: "teacher" },
    }),
  );
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.user.id, ownerId);
  assert.equal(snapshot.user.email, "arappayevv@gmail.com");
  assert.equal(snapshot.user.role, "admin");
  assert.deepEqual(snapshot.users, []);
  for (const action of [
    "account.save",
    "account.password",
    "account.delete",
    "account.reset",
    "account.future",
    "password.change",
    "password.reset",
  ]) {
    const before = calls.length;
    assert.equal(
      (
        await handle(
          request({
            action,
            token: ownerToken,
            account: { role: "admin" },
            currentPassword: "fixture",
            password: "replacement-fixture",
          }),
        )
      ).status,
      410,
    );
    assert.deepEqual(
      calls.slice(before).map((call) => call.path),
      ["rpc/owner_access_command"],
    );
  }
  assert.equal(
    calls.some(
      (call) =>
        call.path.startsWith("uf_accounts") ||
        call.path.startsWith("schedule_settings") ||
        call.path === "rpc/uf_change_password",
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

test("owner catalog save, duplicate, archive and replacement keep the CAS path and no account credentials", async (t) => {
  const { row, calls } = backend(t);
  row.data.rooms.push({ id: "r2", name: "102", capacity: 40 });
  row.data.rooms[0].unknown = { preserve: true };
  for (const [op, payload, verify] of [
    [
      "catalog.save",
      {
        entity: "rooms",
        item: { id: "r", building: "A", floor: "цоколь", note: "Owner only" },
      },
      (data) => assert.deepEqual(data.rooms[0].unknown, { preserve: true }),
    ],
    [
      "catalog.duplicate",
      { entity: "teachers", id: "t1", name: "New teacher" },
      (data) => assert.deepEqual(data.teachers.at(-1).subjects, []),
    ],
    [
      "group.archive",
      { id: "g", archived: true },
      (data) => assert.equal(typeof data.groups[0].archivedAt, "string"),
    ],
    [
      "catalog.replace",
      { entity: "rooms", id: "r", replacementId: "r2" },
      (data) => assert.equal(data.lessons[0].roomId, "r2"),
    ],
  ]) {
    const response = await handle(
      request({
        action: "mutate",
        token: ownerToken,
        revision: 7,
        op,
        payload,
      }),
    );
    assert.equal(
      response.status,
      200,
      JSON.stringify(await response.clone().json()),
    );
    verify((await response.json()).data);
  }
  const commits = calls.filter((call) => call.path === "rpc/uf_commit");
  assert.equal(commits.length, 4);
  assert.equal(
    commits.every((call) => call.payload.p_expected === 7),
    true,
  );
  assert.equal(
    calls.some((call) => /password|salt|verifier/.test(call.path)),
    false,
  );
});

test("common account guard rejects subgroup removal, replacement and rollback before commit", async (t) => {
  const accounts = [{ role: "student", group_id: "g", subgroup: "Б" }];
  let version;
  const { row, calls } = backend(t, {
    respond: (path) =>
      path === "uf_accounts?select=role,group_id,subgroup,teacher_id"
        ? new Response(JSON.stringify(accounts))
        : path === "uf_versions?revision=eq.2"
          ? new Response(JSON.stringify([{ data: version }]))
          : null,
  });
  row.data.groups.push({ id: "g2", name: "Other", subgroups: ["А", "Б"] });
  version = structuredClone(row.data);
  version.groups[0].subgroups = ["А"];
  for (const body of [
    {
      action: "mutate",
      op: "catalog.save",
      payload: { entity: "groups", item: { id: "g", subgroups: ["А"] } },
    },
    {
      action: "mutate",
      op: "catalog.replace",
      payload: { entity: "groups", id: "g", replacementId: "g2" },
    },
    { action: "rollback", target: 2 },
  ]) {
    const response = await handle(
      request({ token: ownerToken, revision: 7, ...body }),
    );
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /аккаунта/);
  }
  assert.equal(
    calls.some((call) => call.path === "rpc/uf_commit"),
    false,
  );
  assert.equal(
    calls
      .filter((call) => call.path.startsWith("uf_accounts?"))
      .every(
        (call) =>
          call.path === "uf_accounts?select=role,group_id,subgroup,teacher_id",
      ),
    true,
  );
});

test("teacher catalog replacement cannot orphan a legacy reference even if its regular lessons are reassigned", async (t) => {
  const { row, calls } = backend(t, {
    respond: (path) =>
      path === "uf_accounts?select=role,group_id,subgroup,teacher_id"
        ? new Response(JSON.stringify([{ role: "teacher", teacher_id: "t1" }]))
        : null,
  });
  row.data.teachers.push({ id: "t2", name: "Other", subjects: ["s"] });
  const response = await handle(
    request({
      action: "mutate",
      token: ownerToken,
      revision: 7,
      op: "catalog.replace",
      payload: { entity: "teachers", id: "t1", replacementId: "t2" },
    }),
  );
  assert.equal(response.status, 400);
  assert.equal(
    calls.some((call) => call.path === "rpc/uf_commit"),
    false,
  );
});

test("replacement publication uses current private references and discards forged uploaded private arrays", async (t) => {
  const { row, calls } = backend(t);
  row.data.requests.push({
    id: "late",
    lessonId: "l",
    date: "2026-11-09",
    status: "rejected",
    roomId: "r",
    unknown: { private: "retain" },
  });
  row.data.attendance.push({
    lessonId: "l",
    date: "2026-11-09",
    studentId: "private-account",
    status: "present",
    roomId: "r",
  });
  const candidate = structuredClone(row.data);
  candidate.rooms = [{ id: "new", name: "New room", capacity: 40 }];
  candidate.lessons[0].roomId = "new";
  candidate.requests = [{ forged: true }];
  candidate.attendance = [{ forged: true }];
  const response = await handle(
    request({
      action: "mutate",
      token: ownerToken,
      revision: 7,
      op: "import",
      payload: {
        data: candidate,
        catalogReplacements: [
          { entity: "rooms", id: "r", replacementId: "new" },
        ],
      },
    }),
  );
  assert.equal(response.status, 200);
  const committed = calls.find((call) => call.path === "rpc/uf_commit").payload
    .p_data;
  assert.equal(committed.requests[0].roomId, "new");
  assert.deepEqual(committed.requests[0].unknown, { private: "retain" });
  assert.equal(committed.attendance[0].studentId, "private-account");
  assert.equal(committed.attendance[0].roomId, "new");
});

test("catalog writes reject forged identity before platform IO and retain stale/CAS protection", async (t) => {
  const { calls } = backend(t);
  for (const op of [
    "catalog.save",
    "catalog.delete",
    "catalog.replace",
    "catalog.duplicate",
    "group.archive",
  ]) {
    const response = await handle(
      request({
        action: "mutate",
        token: "forged",
        role: "admin",
        revision: 7,
        op,
        payload: { entity: "rooms", id: "r" },
      }),
    );
    assert.equal(response.status, 401);
  }
  assert.deepEqual(calls, []);
  const stale = await handle(
    request({
      action: "mutate",
      token: ownerToken,
      revision: 6,
      op: "catalog.save",
      payload: { entity: "rooms", item: { id: "r", name: "Changed" } },
    }),
  );
  assert.equal(stale.status, 409);
  assert.equal(
    calls.some((call) => call.path === "rpc/uf_commit"),
    false,
  );
});
