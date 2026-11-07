import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const source = await readFile(
  new URL("../beta/sw.js", import.meta.url),
  "utf8",
);

function worker(scope, keys = [], clients = []) {
  const events = new Map();
  const deleted = [];
  const opened = [];
  const stored = new Map();
  const cacheFor = (name) => ({
    match: async (key) =>
      name.endsWith("-static")
        ? new Response("cached")
        : stored.get(name + ":" + String(key.url || key))?.clone(),
    put: async (key, response) => {
      stored.set(name + ":" + String(key.url || key), response.clone());
    },
    keys: async () =>
      [...stored.keys()]
        .filter((key) => key.startsWith(name + ":"))
        .map((key) => new Request(key.slice(name.length + 1))),
    delete: async (key) => stored.delete(name + ":" + String(key.url || key)),
  });
  const self = {
    registration: { scope },
    location: { origin: new URL(scope).origin },
    clients: { claim: async () => {}, matchAll: async () => clients },
    addEventListener: (event, handler) => events.set(event, handler),
  };
  runInNewContext(source, {
    URL,
    Request,
    Response,
    self,
    caches: {
      keys: async () => keys,
      delete: async (key) => deleted.push(key),
      open: async (name) => {
        opened.push(name);
        return cacheFor(name);
      },
    },
    fetch: async () => new Response("network"),
  });
  return {
    events,
    deleted,
    opened,
    async intercept(
      path,
      {
        mode = "navigate",
        method = "GET",
        clientId = "",
        resultingClientId = "",
      } = {},
    ) {
      let response;
      const pending = [];
      const request = { url: new URL(path, scope).href, mode, method };
      events.get("fetch")({
        request,
        clientId,
        resultingClientId,
        respondWith: (value) => {
          response = value;
        },
        waitUntil: (value) => pending.push(value),
      });
      const intercepted = response !== undefined;
      if (response) await response;
      await Promise.all(pending);
      return intercepted;
    },
  };
}

test("root worker serves only its own document and never replaces beta or staff navigation", async () => {
  const root = worker("https://example.test/schedule/");
  assert.equal(await root.intercept("./?demo=student"), true);
  assert.equal(await root.intercept("./index.html"), true);
  assert.equal(await root.intercept("./beta/"), false);
  assert.equal(await root.intercept("./beta/?demo=admin"), false);
  assert.equal(await root.intercept("./manage/"), false);
  assert.equal(await root.intercept("./manage"), false);
  assert.equal(await root.intercept("./unknown/"), false);
  assert.equal(await root.intercept("./beta/app.mjs", { mode: "cors" }), false);
  assert.equal(
    await root.intercept("./manage/app.mjs", { mode: "cors" }),
    false,
  );
  assert.equal(await root.intercept("./lib/time.mjs", { mode: "cors" }), true);
});

test("beta worker serves its own shell but never caches protected POST or external resources", async () => {
  const beta = worker("https://example.test/schedule/beta/");
  assert.equal(await beta.intercept("./?demo=teacher"), true);
  assert.equal(await beta.intercept("./manage/"), false);
  assert.equal(
    await beta.intercept("../backend/core.mjs", { mode: "cors" }),
    true,
  );
  assert.equal(
    await beta.intercept("../backend/uniflow-api.mjs", { mode: "cors" }),
    false,
  );
  assert.equal(
    await beta.intercept("./state", { method: "POST", mode: "cors" }),
    false,
  );
  assert.equal(
    await beta.intercept("https://other.test/app.mjs", { mode: "cors" }),
    false,
  );
});

test("activation deletes only older caches belonging to the same deployment scope", async () => {
  const rootOld = "uniflow:%2Fschedule%2F:v1-static";
  const betaOld = "uniflow:%2Fschedule%2Fbeta%2F:v1-static";
  const beta = worker("https://example.test/schedule/beta/", [
    rootOld,
    betaOld,
    "unrelated-cache",
  ]);
  let activation;
  beta.events.get("activate")({
    waitUntil: (value) => {
      activation = value;
    },
  });
  await activation;
  assert.deepEqual(beta.deleted, [betaOld]);
  await beta.intercept("./");
  assert.equal(beta.opened.at(-1), "uniflow:%2Fschedule%2Fbeta%2F:v2-static");
});

test("activation pins existing documents to the previous cache until a full navigation", async () => {
  const scope = "https://example.test/schedule/beta/";
  const previous = "uniflow:%2Fschedule%2Fbeta%2F:v1-static";
  const current = "uniflow:%2Fschedule%2Fbeta%2F:v2-static";
  const beta = worker(
    scope,
    [previous, current],
    [{ id: "old-tab", url: scope }],
  );
  let activation;
  beta.events.get("activate")({
    waitUntil: (value) => {
      activation = value;
    },
  });
  await activation;
  assert.deepEqual(beta.deleted, []);
  await beta.intercept("./lib/calendar.mjs", {
    mode: "cors",
    clientId: "old-tab",
  });
  assert.equal(beta.opened.at(-1), previous);
  await beta.intercept("./", {
    clientId: "old-tab",
    resultingClientId: "new-tab",
  });
  await beta.intercept("./lib/calendar.mjs", {
    mode: "cors",
    clientId: "new-tab",
  });
  assert.equal(beta.opened.at(-1), current);
});

test("a first successful installation never pins a failed partial cache as an active release", async () => {
  const scope = "https://example.test/schedule/beta/";
  const partial = "uniflow:%2Fschedule%2Fbeta%2F:failed-static";
  const current = "uniflow:%2Fschedule%2Fbeta%2F:v2-static";
  const beta = worker(
    scope,
    [partial, current],
    [{ id: "first-tab", url: scope }],
  );
  let pending;
  beta.events.get("install")({
    waitUntil: (value) => {
      pending = value;
    },
  });
  await pending;
  beta.events.get("activate")({
    waitUntil: (value) => {
      pending = value;
    },
  });
  await pending;
  assert.deepEqual(beta.deleted, [partial]);
  await beta.intercept("./lib/calendar.mjs", {
    mode: "cors",
    clientId: "first-tab",
  });
  assert.equal(beta.opened.at(-1), current);
});
