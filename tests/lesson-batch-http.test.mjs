import test from "node:test";
import assert from "node:assert/strict";
import { handle } from "../backend/uniflow-api.mjs";
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

const batch = (ids, change, revision = 7, credential = token) =>
  request({
    action: "mutate",
    op: "lesson.batch",
    payload: { ids, change },
    revision,
    token: credential,
  });

test("HTTP bulk editing rejects forged identity/legacy credentials before platform IO", async (t) => {
  const { calls } = backend(t);
  for (const credential of [null, "a".repeat(64), "eyJ.native.jwt"]) {
    const response = await handle(
      batch(["now-a"], { kind: "type", value: "Семинар" }, 7, credential),
    );
    assert.equal(response.status, 401);
    assert.deepEqual(calls, []);
  }
});

test("HTTP verified owner applies only fixed selected IDs via one CAS and stale replay rejects", async (t) => {
  const { row, calls } = backend(t),
    before = structuredClone(row.data);
  const response = await handle(
    batch(["now-a", "next"], { kind: "type", value: "Семинар" }),
  );
  assert.equal(response.status, 200);
  assert.equal(row.revision, 8);
  assert.equal(row.data.lessons[0].type, "Семинар");
  assert.equal(row.data.lessons[1].type, "Семинар");
  assert.deepEqual(row.data.lessons[2], before.lessons[2]);
  assert.equal(calls.filter((call) => call.path === "rpc/uf_commit").length, 1);
  assert.deepEqual(row.data.tasks, before.tasks);
  assert.deepEqual(row.data.requests, before.requests);
  assert.deepEqual(row.data.attendance, before.attendance);
  const stale = await handle(
    batch(["later-b"], { kind: "type", value: "Другой тип" }),
  );
  assert.equal(stale.status, 409);
  assert.equal(calls.filter((call) => call.path === "rpc/uf_commit").length, 1);
});

test("HTTP bad IDs, no-op and globally conflicting batch leave revision/history/private rows unchanged", async (t) => {
  const { row, calls } = backend(t),
    before = structuredClone(row);
  for (const [ids, change] of [
    [["now-a", "missing"], { kind: "type", value: "Семинар" }],
    [["now-a"], { kind: "type", value: "Практика" }],
    [
      ["now-a", "next", "later-b"],
      { kind: "setTime", start: "08:00", end: "09:00", endDayOffset: 0 },
    ],
  ]) {
    const response = await handle(batch(ids, change));
    assert.equal(response.status, 400);
    assert.deepEqual(row, before);
  }
  assert.equal(
    calls.some((call) => call.path === "rpc/uf_commit"),
    false,
  );
});
