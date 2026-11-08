import test from "node:test";
import assert from "node:assert/strict";
import { handle } from "../backend/uniflow-api.mjs";
import { defaultTeachingSettings } from "../backend/teaching-settings.mjs";
import { fixture } from "./e2e/fixtures.mjs";
const token = "ow1a." + "b".repeat(64);
const request = (body) =>
  new Request("https://edge.invalid/uniflow-api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
function backend(t) {
  const versions = [];
  const old = globalThis.Deno,
    calls = [],
    row = {
      revision: 7,
      data: {
        ...structuredClone(fixture),
        siteSettings: { privateFuture: { retain: "never public" } },
      },
    };
  globalThis.Deno = {
    env: {
      get: (key) =>
        key === "SUPABASE_URL"
          ? "https://test.invalid"
          : key === "SUPABASE_SERVICE_ROLE_KEY"
            ? "server-only-test-key"
            : undefined,
    },
  };
  t.after(() => {
    if (old === undefined) delete globalThis.Deno;
    else globalThis.Deno = old;
  });
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const path = String(url).split("/rest/v1/")[1],
      body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, body });
    let result = [];
    if (path === "rpc/owner_access_command")
      result = {
        id: "22222222-2222-4222-8222-222222222222",
        owner_uid: "11111111-1111-4111-8111-111111111111",
        owner_email: "arappayevv@gmail.com",
        native_session_id: "33333333-3333-4333-8333-333333333333",
        expires_at: "2099-01-01T00:00:00Z",
      };
    else if (path.startsWith("uf_platform?")) result = [row];
    else if (path.startsWith("uf_versions?revision=eq."))
      result = versions.filter(
        (v) => v.revision === Number(path.split("eq.")[1]),
      );
    else if (path === "rpc/uf_commit") {
      versions.unshift(structuredClone(row));
      assert.equal(body.p_expected, row.revision);
      row.data = body.p_data;
      row.revision++;
      result = structuredClone(row);
    }
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { row, calls };
}

test("HTTP teaching writes reject forged roles and legacy/native tokens before platform IO", async (t) => {
  const { calls } = backend(t);
  for (const forged of [
    { role: "admin", user: { role: "admin" } },
    { token: "a".repeat(64), role: "admin" },
    { token: "eyJ.native.token", role: "admin" },
  ]) {
    calls.length = 0;
    const response = await handle(
      request({
        action: "mutate",
        op: "teaching.save",
        payload: { settings: defaultTeachingSettings() },
        revision: 7,
        ...forged,
      }),
    );
    assert.equal(response.status, 401);
    assert.deepEqual(calls, []);
  }
});

test("HTTP owner publishes presets through CAS, guest never receives them and rollback preserves existing auth/data boundary", async (t) => {
  const { row, calls } = backend(t),
    original = structuredClone(row.data);
  const response = await handle(
    request({
      action: "mutate",
      op: "teaching.save",
      payload: { settings: defaultTeachingSettings() },
      revision: 7,
      token,
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(row.revision, 8);
  assert.deepEqual(row.data.lessons, original.lessons);
  assert.deepEqual(
    row.data.siteSettings.privateFuture,
    original.siteSettings.privateFuture,
  );
  assert.deepEqual(
    (await response.json()).data.siteSettings.teaching,
    defaultTeachingSettings(),
  );
  const guest = await handle(
    request({ action: "state", groupId: "g-main", subgroup: "А" }),
  );
  const publicData = (await guest.json()).data;
  assert.equal(publicData.siteSettings, undefined);
  assert.equal(JSON.stringify(publicData).includes("bellSchedules"), false);
  const stale = await handle(
    request({
      action: "mutate",
      op: "teaching.save",
      payload: { settings: defaultTeachingSettings() },
      revision: 7,
      token,
    }),
  );
  assert.equal(stale.status, 409);
  assert.equal(row.revision, 8);
  assert.equal(calls.filter((c) => c.path === "rpc/uf_commit").length, 1);
  const rollback = await handle(
    request({ action: "rollback", revision: 8, target: 7, token }),
  );
  assert.equal(rollback.status, 200);
  assert.equal(row.data.siteSettings.teaching, undefined);
  assert.deepEqual(row.data.lessons, original.lessons);
});

test("HTTP invalid teaching save/import never reaches CAS and leaves prior settings untouched", async (t) => {
  const { row, calls } = backend(t),
    before = structuredClone(row);
  for (const change of [
    (value) => (value.version = 2),
    (value) => (value.lessonTypes[0].enabled = "true"),
    (value) => (value.bellSchedules[0].slots[0].end = "08:00"),
    (value) => (value.extra = "forbidden"),
  ]) {
    const value = defaultTeachingSettings();
    change(value);
    for (const op of ["teaching.save", "import"]) {
      const payload =
        op === "teaching.save"
          ? { settings: value }
          : {
              data: {
                ...structuredClone(row.data),
                siteSettings: { teaching: value },
              },
            };
      const response = await handle(
        request({ action: "mutate", op, payload, revision: 7, token }),
      );
      assert.equal(response.status, 400);
    }
  }
  assert.equal(
    calls.some((c) => c.path === "rpc/uf_commit"),
    false,
  );
  assert.deepEqual(row, before);
});

test("HTTP full draft import applies teaching only when explicitly present and keeps fresh unknown settings", async (t) => {
  const { row } = backend(t);
  row.data.siteSettings.teaching = defaultTeachingSettings();
  const changed = defaultTeachingSettings();
  changed.bellSchedules = [];
  changed.defaultBellScheduleId = "";
  const upload = {
    ...structuredClone(row.data),
    siteSettings: { teaching: changed, unknownInjected: "ignore" },
  };
  const published = await handle(
    request({
      action: "mutate",
      op: "import",
      payload: { data: upload },
      revision: 7,
      token,
    }),
  );
  assert.equal(published.status, 200);
  assert.deepEqual(row.data.siteSettings.teaching, changed);
  assert.equal(row.data.siteSettings.unknownInjected, undefined);
  assert.equal(row.data.siteSettings.privateFuture.retain, "never public");
  const older = structuredClone(row.data);
  delete older.siteSettings;
  const retained = await handle(
    request({
      action: "mutate",
      op: "import",
      payload: { data: older },
      revision: 8,
      token,
    }),
  );
  assert.equal(retained.status, 200);
  assert.deepEqual(row.data.siteSettings.teaching, changed);
});
