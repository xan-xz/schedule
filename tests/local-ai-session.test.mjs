import assert from "node:assert/strict";
import test from "node:test";
import { startLocalAiSession } from "../scripts/local-ai-session.mjs";

const route = "/schedule/local-ai/columns";
const origin = "https://xan-xz.github.io";

function fixture({ shared = false, failure = false } = {}) {
  const calls = [];
  const daemon = { status: "running", pid: 521, isDaemon: true };
  let running = shared;
  return {
    calls,
    runLms: async (...command) => {
      calls.push(command.join(" "));
      switch (command.slice(0, 2).join(" ")) {
        case "daemon status":
          return JSON.stringify(running ? daemon : { status: "not-running" });
        case "daemon up":
          running = true;
          return JSON.stringify(daemon);
        case "server start":
          assert.deepEqual(command, [
            "server",
            "start",
            "--bind",
            "127.0.0.1",
            "--port",
            "1234",
          ]);
          return "";
        case "server status":
          return JSON.stringify({ running, port: 1234 });
        case "daemon down":
          running = false;
          return "";
        default:
          throw Error("Unexpected CLI command");
      }
    },
    fetcher: async (url, init) => {
      calls.push("inference");
      assert.equal(url, "http://127.0.0.1:1234/v1/chat/completions");
      const content = JSON.parse(JSON.parse(init.body).messages.at(-1).content);
      assert.deepEqual(content, {
        headers: ["Кабинет занятий"],
        allowed: ["room"],
      });
      return failure
        ? new Response(null, { status: 503 })
        : Response.json({
            choices: [{ message: { content: '{"columns":["room"]}' } }],
          });
    },
  };
}

function request(port, body, requestOrigin = origin) {
  return fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: { Origin: requestOrigin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("preflight, unauthorized requests and invalid headers do not start LM Studio", async () => {
  const fake = fixture();
  const { port, closed } = await startLocalAiSession({
    ...fake,
    port: 0,
    idleMs: 350,
    model: "fixture",
  });
  const preflight = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: "OPTIONS",
    headers: { Origin: origin },
  });
  assert.equal(preflight.status, 204);
  const data = { headers: ["Кабинет занятий"], allowed: ["room"] };
  assert.equal(
    (await request(port, data, "https://other.invalid")).status,
    403,
  );
  assert.equal(
    (await request(port, { ...data, allowed: ["invented_field"] })).status,
    503,
  );
  await closed;
  assert.deepEqual(fake.calls, []);
  await assert.rejects(fetch(`http://127.0.0.1:${port}${route}`));
});

for (const failure of [false, true]) {
  test(`a single preview shuts down its own model ${failure ? "after inference failure" : "before returning its result"}`, async () => {
    const fake = fixture({ failure });
    const { port, closed } = await startLocalAiSession({
      ...fake,
      port: 0,
      model: "fixture",
    });
    const response = await request(port, {
      headers: ["Кабинет занятий"],
      allowed: ["room"],
    });
    if (failure) assert.equal(response.status, 503);
    else assert.deepEqual(await response.json(), { columns: ["room"] });
    await closed;
    assert.deepEqual(fake.calls, [
      "daemon status --json",
      "daemon up --json",
      "server start --bind 127.0.0.1 --port 1234",
      "inference",
      "daemon status --json",
      "daemon down",
    ]);
  });
}

test("a preview leaves a previously running model service available", async () => {
  const fake = fixture({ shared: true });
  const { port, closed } = await startLocalAiSession({
    ...fake,
    port: 0,
    model: "fixture",
  });
  const response = await request(port, {
    headers: ["Кабинет занятий"],
    allowed: ["room"],
  });
  assert.equal(response.status, 200);
  await closed;
  assert.deepEqual(fake.calls, [
    "daemon status --json",
    "server status --json --quiet",
    "inference",
  ]);
});
