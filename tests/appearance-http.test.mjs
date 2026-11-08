import test from "node:test";
import assert from "node:assert/strict";
import { handle } from "../backend/uniflow-api.mjs";
import { DEFAULT_APPEARANCE_POLICY } from "../backend/appearance-policy.mjs";
import { fixture } from "./e2e/fixtures.mjs";
const token = "ow1a." + "b".repeat(64);
const policy = () => ({
  ...structuredClone(DEFAULT_APPEARANCE_POLICY),
  defaultPalette: "ocean",
  defaultLayout: "grid",
});
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
test("HTTP forged student/admin policy writes fail before platform IO", async (t) => {
  const { calls } = backend(t);
  for (const forged of [
    { role: "admin", user: { role: "admin" } },
    { token: "a".repeat(64), role: "admin" },
  ]) {
    calls.length = 0;
    const response = await handle(
      request({
        action: "mutate",
        op: "appearance.save",
        payload: { policy: policy() },
        revision: 7,
        ...forged,
      }),
    );
    assert.equal(response.status, 401);
    assert.equal(
      calls.some(
        (c) => c.path.startsWith("uf_platform") || c.path === "rpc/uf_commit",
      ),
      false,
    );
  }
});
test("HTTP owner policy publish uses CAS and guest returns only public policy", async (t) => {
  const { row, calls } = backend(t);
  const response = await handle(
    request({
      action: "mutate",
      op: "appearance.save",
      payload: { policy: policy() },
      revision: 7,
      token,
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(row.revision, 8);
  assert.equal(row.data.siteSettings.privateFuture.retain, "never public");
  assert.equal(calls.filter((c) => c.path === "rpc/uf_commit").length, 1);
  const guest = await handle(
    request({ action: "state", groupId: "g-main", subgroup: "А" }),
  );
  const body = await guest.json();
  assert.deepEqual(body.data.siteSettings, { appearance: policy() });
  assert.deepEqual(body.users, []);
  assert.deepEqual(body.versions, []);
  const stale = await handle(
    request({
      action: "mutate",
      op: "appearance.save",
      payload: { policy: policy() },
      revision: 7,
      token,
    }),
  );
  assert.equal(stale.status, 409);
  assert.equal(row.revision, 8);
  const restored = await handle(
    request({ action: "rollback", revision: 8, target: 7, token }),
  );
  assert.equal(restored.status, 200);
  assert.equal(row.revision, 9);
  assert.equal(row.data.siteSettings.appearance, undefined);
  assert.equal(row.data.siteSettings.privateFuture.retain, "never public");
});
test("HTTP malformed future policies cannot reach commit or change the document", async (t) => {
  const { row, calls } = backend(t),
    before = structuredClone(row);
  for (const bad of [
    { ...policy(), version: 2 },
    { ...policy(), allowedLayouts: [] },
    { ...policy(), allowPaletteChoice: "false" },
  ]) {
    const response = await handle(
      request({
        action: "mutate",
        op: "appearance.save",
        payload: { policy: bad },
        revision: 7,
        token,
      }),
    );
    assert.equal(response.status, 400);
  }
  assert.equal(
    calls.some((c) => c.path === "rpc/uf_commit"),
    false,
  );
  assert.deepEqual(row, before);
});
