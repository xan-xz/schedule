import test from "node:test";
import assert from "node:assert/strict";
import { handle } from "../backend/uniflow-api.mjs";
import { fixture } from "./e2e/fixtures.mjs";
const token = "ow1a." + "b".repeat(64);
const request = (patch = {}, origin = "https://xan-xz.github.io") =>
  new Request("https://edge.invalid/uniflow-api", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({
      action: "rollback.preview",
      revision: 8,
      target: 7,
      token,
      ...patch,
    }),
  });
function backend(t) {
  const old = globalThis.Deno,
    calls = [],
    row = { revision: 8, data: structuredClone(fixture) },
    version = { revision: 7, data: structuredClone(fixture) },
    accounts = [];
  version.data.lessons[0].roomId = "205";
  version.data.lessons[0].privateFuture = "secret snapshot metadata";
  globalThis.Deno = {
    env: {
      get: (key) =>
        key === "SUPABASE_URL"
          ? "https://test.invalid"
          : key === "SUPABASE_SERVICE_ROLE_KEY"
            ? "test-key"
            : undefined,
    },
  };
  t.after(() => {
    if (old === undefined) delete globalThis.Deno;
    else globalThis.Deno = old;
  });
  let conflict = false;
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
      result =
        Number(path.split("eq.")[1]) === version.revision ? [version] : [];
    else if (path.startsWith("uf_accounts?")) result = accounts;
    else if (path === "rpc/uf_commit") {
      if (conflict) return new Response("version_conflict", { status: 409 });
      assert.equal(body.p_expected, row.revision);
      row.data = body.p_data;
      row.revision++;
      result = row;
    }
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  });
  return {
    row,
    version,
    calls,
    accounts,
    conflict: () => {
      conflict = true;
    },
  };
}
const commits = (calls) => calls.filter((c) => c.path === "rpc/uf_commit");
test("HTTP preview requires opaque verified owner identity and permitted origin before data IO", async (t) => {
  const { calls } = backend(t);
  for (const credential of [null, "a".repeat(64), "eyJ.native.jwt"])
    assert.equal((await handle(request({ token: credential }))).status, 401);
  assert.equal(
    (await handle(request({}, "https://foreign.invalid"))).status,
    403,
  );
  assert.deepEqual(calls, []);
});
test("HTTP preview is read-only and closed; the accepted proof commits once with retained history", async (t) => {
  const { row, calls } = backend(t),
    before = structuredClone(row);
  const response = await handle(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const plan = await response.json();
  assert.equal(plan.totalChanges, 1);
  assert.equal(
    JSON.stringify(plan).includes("secret snapshot metadata"),
    false,
  );
  assert.deepEqual(row, before);
  assert.equal(commits(calls).length, 0);
  const applied = await handle(
    request({ action: "rollback", previewFingerprint: plan.fingerprint }),
  );
  assert.equal(applied.status, 200);
  assert.equal(row.revision, 9);
  assert.equal(row.data.lessons[0].roomId, "205");
  assert.equal(row.data.history[0].action, "rollback");
  assert.deepEqual(row.data.history.slice(1), before.data.history);
  assert.equal(commits(calls).length, 1);
  assert.equal(
    (
      await handle(
        request({ action: "rollback", previewFingerprint: plan.fingerprint }),
      )
    ).status,
    409,
  );
  assert.equal(commits(calls).length, 1);
});
test("HTTP rejects bad revisions/pages, missing targets and invalid target/account references without commit", async (t) => {
  const { version, accounts, calls } = backend(t);
  for (const [patch, status] of [
    [{ revision: 7 }, 409],
    [{ revision: "8" }, 409],
    [{ target: 99 }, 400],
    [{ target: -1 }, 400],
    [{ page: -1 }, 400],
    [{ page: 0.2 }, 400],
  ])
    assert.equal((await handle(request(patch))).status, status);
  version.data.lessons[0].roomId = "missing";
  assert.equal((await handle(request())).status, 400);
  version.data.lessons[0].roomId = "205";
  accounts.push({ role: "student", group_id: "removed", subgroup: "А" });
  assert.equal((await handle(request())).status, 400);
  assert.equal(commits(calls).length, 0);
});
test("HTTP rejects altered target and current hidden metadata, and malformed fingerprints", async (t) => {
  const { row, version, calls } = backend(t);
  const plan = await (await handle(request())).json();
  const saved = structuredClone(version.data);
  version.data.lessons[0].privateFuture = "changed";
  assert.equal(
    (
      await handle(
        request({ action: "rollback", previewFingerprint: plan.fingerprint }),
      )
    ).status,
    409,
  );
  version.data = saved;
  row.data.privateRoot = "changed";
  assert.equal(
    (
      await handle(
        request({ action: "rollback", previewFingerprint: plan.fingerprint }),
      )
    ).status,
    409,
  );
  for (const proof of [null, {}, "a", "A".repeat(64)])
    assert.equal(
      (await handle(request({ action: "rollback", previewFingerprint: proof })))
        .status,
      409,
    );
  assert.equal(commits(calls).length, 0);
});
test("HTTP keeps authenticated older tabs compatible and surfaces final CAS conflicts", async (t) => {
  const { row, calls, conflict } = backend(t);
  const before = structuredClone(row);
  conflict();
  assert.equal((await handle(request({ action: "rollback" }))).status, 409);
  assert.deepEqual(row, before);
  assert.equal(commits(calls).length, 1);
});
test("HTTP authenticated older tabs may restore without the additive preview proof", async (t) => {
  const { row, calls } = backend(t);
  assert.equal((await handle(request({ action: "rollback" }))).status, 200);
  assert.equal(row.revision, 9);
  assert.equal(commits(calls).length, 1);
});
