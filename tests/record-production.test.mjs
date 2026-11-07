import test from "node:test";
import assert from "node:assert/strict";
import {
  parseGitHubLookup,
  classifyReleaseLookup,
  ensureProductionRelease,
} from "../scripts/record-production.mjs";
const sha = "a".repeat(40);
const existing = () => ({
  status: 200,
  body: {
    target_commitish: sha,
    assets: [{ name: "production-site.tar" }, { name: "production.json" }],
  },
});
const response = (status, body, exit = status === 200 ? 0 : 1) => ({
  status: exit,
  stdout: `HTTP/2.0 ${status} Status\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`,
  stderr: "",
});

test("real gh HTTP 404 JSON is absence, never a source SHA from stdout", async () => {
  const missing = parseGitHubLookup(
    response(404, { message: "Not Found", status: "404" }),
  );
  assert.equal(classifyReleaseLookup(missing, sha), "create");
  let created = 0;
  assert.equal(
    await ensureProductionRelease({
      sourceRef: sha,
      lookup: async () => missing,
      create: async () => {
        created++;
      },
    }),
    "created",
  );
  assert.equal(created, 1);
});

test("lookup rejects 403, 5xx, malformed JSON and network/command errors before writes", async () => {
  for (const raw of [
    response(403, { message: "Forbidden" }),
    response(500, { message: "server error" }),
    { ...response(200, {}), stdout: "garbage" },
    { ...response(200, {}), stdout: "HTTP/2.0 200 OK\n\nnot-json" },
    { ...response(200, {}), status: 1 },
    { ...response(404, { message: "Not Found" }), status: 0 },
    response(404, {}),
    response(404, { message: "no", status: "403" }),
    { status: null, signal: "SIGTERM", stdout: "" },
    { status: 1, error: Error("network"), stdout: "" },
  ]) {
    let created = 0;
    await assert.rejects(
      ensureProductionRelease({
        sourceRef: sha,
        lookup: async () => parseGitHubLookup(raw),
        create: async () => {
          created++;
        },
      }),
    );
    assert.equal(created, 0);
  }
});

test("existing same-source complete releases make repeated recording idempotent", async () => {
  const current = parseGitHubLookup(response(200, existing().body));
  let created = 0;
  assert.equal(
    await ensureProductionRelease({
      sourceRef: sha,
      lookup: async () => current,
      create: async () => {
        created++;
      },
    }),
    "existing",
  );
  assert.equal(created, 0);
});

test("different source, missing/duplicate assets and malformed success fail closed", async () => {
  for (const value of [
    {
      status: 200,
      body: { ...existing().body, target_commitish: "b".repeat(40) },
    },
    { status: 200, body: { ...existing().body, assets: [] } },
    {
      status: 200,
      body: { ...existing().body, assets: [{ name: "production.json" }] },
    },
    {
      status: 200,
      body: {
        ...existing().body,
        assets: [...existing().body.assets, { name: "production.json" }],
      },
    },
    { status: 200, body: null },
    { status: 200, body: { ...existing().body, assets: null } },
    { status: 403, body: {} },
  ]) {
    let created = 0;
    await assert.rejects(
      ensureProductionRelease({
        sourceRef: sha,
        lookup: async () => value,
        create: async () => {
          created++;
        },
      }),
    );
    assert.equal(created, 0);
  }
  assert.throws(() => classifyReleaseLookup(existing(), "main"));
});

test("a lost create response is accepted only after a complete same-source recheck", async () => {
  let lookup = 0,
    created = 0;
  const outcome = await ensureProductionRelease({
    sourceRef: sha,
    lookup: async () =>
      ++lookup === 1
        ? { status: 404, body: { message: "Not Found" } }
        : existing(),
    create: async () => {
      created++;
      throw Error("response lost");
    },
  });
  assert.equal(outcome, "existing");
  assert.equal(created, 1);
  assert.equal(lookup, 2);
  for (const after of [
    { status: 404, body: { message: "Not Found" } },
    { status: 200, body: { ...existing().body, assets: [] } },
    { status: 500, body: {} },
  ]) {
    let attempt = 0;
    await assert.rejects(
      ensureProductionRelease({
        sourceRef: sha,
        lookup: async () =>
          ++attempt === 1
            ? { status: 404, body: { message: "Not Found" } }
            : after,
        create: async () => {
          throw Error("create failed");
        },
      }),
    );
  }
});
