import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const rootScope = "https://example.test/schedule/";
const manifest = JSON.parse(
  await readFile(new URL("../compatibility.json", import.meta.url), "utf8"),
);
const sources = Object.fromEntries(
  await Promise.all(
    ["sw.js", "retirement-worker.js"].map(async (file) => [
      file,
      await readFile(new URL("../app/" + file, import.meta.url), "utf8"),
    ]),
  ),
);
const retiredScope = new URL(manifest.cacheScopes[0], rootScope).href;
const prefix = (scope) =>
  `uniflow:${encodeURIComponent(new URL(scope).pathname)}:`;

function worker({
  file = "sw.js",
  scope = rootScope,
  names = [],
  clients = [],
  config = manifest,
  active = false,
  offline = false,
} = {}) {
  const events = new Map(),
    deleted = [],
    opened = [],
    skipped = [],
    fetched = [];
  const values = new Map(names.map((name) => [name, new Map()]));
  const state = { clients, claims: 0, unregistered: 0 };
  const requestKey = (key) => String(key.url || key.href || key);
  const entries = (name) => {
    if (!values.has(name)) values.set(name, new Map());
    return values.get(name);
  };
  const cacheFor = (name) => ({
    match: async (key) => entries(name).get(requestKey(key))?.clone(),
    put: async (key, response) =>
      entries(name).set(requestKey(key), response.clone()),
    keys: async () => [...entries(name).keys()].map((key) => new Request(key)),
    delete: async (key) => entries(name).delete(requestKey(key)),
  });
  const self = {
    registration: {
      scope,
      active: active ? { state: "activated" } : null,
      waiting: null,
      installing: null,
      unregister: async () => {
        state.unregistered++;
        return true;
      },
    },
    location: { origin: new URL(scope).origin },
    clients: {
      claim: async () => {
        state.claims++;
      },
      matchAll: async () => state.clients,
    },
    skipWaiting: async () => skipped.push(true),
    addEventListener: (name, handler) => events.set(name, handler),
  };
  const context = {
    URL,
    Request,
    Response,
    self,
    caches: {
      keys: async () => [...values.keys()],
      match: async (key) => {
        for (const records of values.values()) {
          const response = records.get(requestKey(key));
          if (response) return response.clone();
        }
      },
      delete: async (name) => {
        deleted.push(name);
        return values.delete(name);
      },
      open: async (name) => {
        opened.push(name);
        return cacheFor(name);
      },
    },
    fetch: async (request) => {
      const url = requestKey(request);
      fetched.push(url);
      if (offline) throw Error("offline");
      const response = url.endsWith("/compatibility.json")
        ? Response.json(config)
        : new Response("network:" + url);
      Object.defineProperty(response, "type", { value: "basic" });
      return response;
    },
  };
  runInNewContext(
    sources[file] +
      "\nglobalThis.model={previousFiles:typeof PREVIOUS_FILES==='undefined'?[]:PREVIOUS_FILES,current:typeof STATIC==='undefined'?null:STATIC};",
    context,
  );
  const invoke = async (name, extra = {}) => {
    const pending = [];
    events.get(name)({
      ...extra,
      waitUntil: (promise) => pending.push(promise),
    });
    await Promise.all(pending);
  };
  return {
    state,
    self,
    deleted,
    opened,
    skipped,
    fetched,
    values,
    current: context.model.current,
    async seed(name, asset, body) {
      await cacheFor(name).put(new URL(asset, scope), new Response(body));
    },
    async seedComplete(name) {
      for (const asset of context.model.previousFiles)
        await this.seed(name, asset, "previous:" + asset);
    },
    install: () => invoke("install"),
    activate: () => invoke("activate"),
    message: (source, data = { type: "SKIP_WAITING" }) =>
      invoke("message", { source, data }),
    async intercept(
      relative,
      {
        mode = "navigate",
        method = "GET",
        clientId = "",
        resultingClientId = "",
      } = {},
    ) {
      let response;
      const pending = [];
      events.get("fetch")({
        request: { url: new URL(relative, scope).href, mode, method },
        clientId,
        resultingClientId,
        respondWith: (value) => {
          response = value;
        },
        waitUntil: (value) => pending.push(value),
      });
      const intercepted = response !== undefined;
      const settled = await Promise.allSettled([
        Promise.resolve(response),
        ...pending,
      ]);
      const failed = settled.find((item) => item.status === "rejected");
      if (failed) throw failed.reason;
      const result = settled[0].value;
      return {
        intercepted,
        response: result,
        body: result && (await result.clone().text()),
      };
    },
  };
}

test("canonical worker owns only its shell and public assets", async () => {
  const instance = worker();
  for (const route of ["./", "./?g=g-main", "./index.html"])
    assert.equal((await instance.intercept(route)).intercepted, true);
  for (const route of [
    manifest.legacyRoutes[0].path,
    "admin/",
    "manage/",
    "unknown/",
    "https://other.test/schedule/",
    "https://example.test/schedule-neighbor/",
  ])
    assert.equal((await instance.intercept(route)).intercepted, false, route);
  for (const route of [
    "admin/app.mjs",
    "manage/app.mjs",
    manifest.legacyRoutes[0].path + "app.mjs",
    "backend/uniflow-api.mjs",
  ])
    assert.equal(
      (await instance.intercept(route, { mode: "cors" })).intercepted,
      false,
      route,
    );
  for (const route of ["lib/time.mjs", "backend/core.mjs"])
    assert.equal(
      (await instance.intercept(route, { mode: "cors" })).intercepted,
      true,
    );
  assert.equal(
    (await instance.intercept("state", { mode: "cors", method: "POST" }))
      .intercepted,
    false,
  );
  assert.equal(
    (await instance.intercept("https://other.test/app.mjs", { mode: "cors" }))
      .intercepted,
    false,
  );
});

test("activation deletes only unpinned old caches of its own deployment", async () => {
  const previous = prefix(rootScope) + "v1-static",
    other = prefix(retiredScope) + "v1-static",
    neighbor = prefix("https://example.test/neighbor/") + "v1-static";
  const instance = worker({
    names: [previous, other, neighbor, "unrelated-cache"],
  });
  await instance.activate();
  assert.deepEqual(instance.deleted, [previous]);
  assert.equal(instance.state.claims, 1);
  assert.equal(instance.values.has(other), true);
  assert.equal(instance.values.has(neighbor), true);
});

test("an old open document keeps its release while a new navigation uses the new cache", async () => {
  const previous = prefix(rootScope) + "v1-static";
  const instance = worker({
    names: [previous],
    clients: [{ id: "old-tab", url: rootScope }],
  });
  await instance.seedComplete(previous);
  await instance.seed(instance.current, "index.html", "current shell");
  await instance.seed(instance.current, "lib/calendar.mjs", "current module");
  await instance.activate();
  assert.deepEqual(instance.deleted, []);
  assert.equal(
    (
      await instance.intercept("lib/calendar.mjs", {
        mode: "cors",
        clientId: "old-tab",
      })
    ).body,
    "previous:./lib/calendar.mjs",
  );
  assert.equal(
    (
      await instance.intercept("./", {
        clientId: "old-tab",
        resultingClientId: "new-tab",
      })
    ).body,
    "current shell",
  );
  assert.equal(
    (
      await instance.intercept("lib/calendar.mjs", {
        mode: "cors",
        clientId: "new-tab",
      })
    ).body,
    "current module",
  );
  assert.equal(
    (
      await instance.intercept("lib/calendar.mjs", {
        mode: "cors",
        clientId: "old-tab",
      })
    ).body,
    "previous:./lib/calendar.mjs",
  );
});

test("a first complete installation never pins a failed partial cache", async () => {
  const partial = prefix(rootScope) + "failed-static";
  const instance = worker({
    names: [partial],
    clients: [{ id: "first-tab", url: rootScope }],
  });
  await instance.install();
  await instance.activate();
  assert.deepEqual(instance.deleted, [partial]);
  assert.equal(
    (
      await instance.intercept("lib/calendar.mjs", {
        mode: "cors",
        clientId: "first-tab",
      })
    ).body,
    "network:" + new URL("lib/calendar.mjs", rootScope).href,
  );
});

test("an evicted prior release fails closed rather than mixing new module bytes", async () => {
  const partial = prefix(rootScope) + "partial-static";
  const instance = worker({
    names: [partial],
    clients: [{ id: "old-tab", url: rootScope }],
  });
  await instance.seed(partial, "index.html", "incomplete old shell");
  await instance.activate();
  assert.equal(
    (
      await instance.intercept("lib/calendar.mjs", {
        mode: "cors",
        clientId: "old-tab",
      })
    ).response.status,
    503,
  );
  assert.deepEqual(instance.fetched, []);
});

test("inactive-root cleanup waits for old documents, then removes only their retired static release", async () => {
  const previous = prefix(rootScope) + "v1-static",
    foreign = prefix(retiredScope) + "v1-static",
    navigated = [];
  const oldClient = {
    id: "old-tab",
    type: "window",
    url: rootScope,
    navigate: async (url) => navigated.push(url),
  };
  const instance = worker({
    names: [previous, foreign, "unrelated-cache"],
    clients: [oldClient],
  });
  await instance.seedComplete(previous);
  await instance.seed(instance.current, "index.html", "current shell");
  await instance.activate();
  await instance.intercept("./", { resultingClientId: "new-tab" });
  const newClient = { ...oldClient, id: "new-tab" };
  instance.state.clients = [oldClient, newClient];
  await instance.message(newClient, { type: "CLEAN_INACTIVE" });
  assert.equal(instance.values.has(previous), true);
  instance.state.clients = [newClient];
  await instance.message(newClient, { type: "CLEAN_INACTIVE" });
  assert.equal(instance.values.has(previous), false);
  assert.equal(instance.values.has(instance.current), true);
  assert.equal(instance.values.has(prefix(rootScope) + "clients"), true);
  assert.equal(instance.values.has(foreign), true);
  assert.equal(instance.values.has("unrelated-cache"), true);
  assert.deepEqual(navigated, []);
});

test("canonical activation retires declared caches only after the last old client leaves", async () => {
  const old = prefix(retiredScope) + "v1-static",
    neighbor = prefix("https://example.test/neighbor/") + "v1-static";
  const instance = worker({
    names: [old, neighbor],
    clients: [{ id: "old-tab", url: retiredScope }],
  });
  await instance.seed(
    instance.current,
    "compatibility.json",
    JSON.stringify(manifest),
  );
  await instance.activate();
  assert.deepEqual(instance.deleted, []);
  instance.state.clients = [{ id: "current-tab", url: rootScope }];
  await instance.activate();
  assert.deepEqual(instance.deleted, [old]);
  assert.equal(instance.values.has(neighbor), true);
});

test("untrusted cleanup scopes never delete current or neighboring caches", async () => {
  for (const scope of ["./", "../neighbor/", "https://other.test/schedule/"]) {
    const config = structuredClone(manifest);
    config.cacheScopes = [scope];
    const neighbor = prefix("https://example.test/neighbor/") + "v1-static",
      instance = worker({ names: [neighbor], config });
    await instance.seed(
      instance.current,
      "compatibility.json",
      JSON.stringify(config),
    );
    await instance.activate();
    assert.equal(instance.deleted.includes(instance.current), false, scope);
    assert.equal(instance.deleted.includes(neighbor), false, scope);
  }
});

test("an active update button navigates only its own shell caller", async () => {
  const instance = worker(),
    navigated = [];
  const caller = {
    id: "old-tab",
    type: "window",
    url: rootScope + "?g=g-main",
    navigate: async (url) => navigated.push(url),
  };
  await instance.message(caller);
  assert.equal(instance.skipped.length, 1);
  assert.deepEqual(navigated, []);
  await instance.activate();
  await instance.message(caller);
  assert.deepEqual(navigated, [caller.url]);
  for (const url of [
    retiredScope,
    rootScope + "admin/",
    "https://other.test/schedule/",
  ])
    await instance.message({ ...caller, url });
  await instance.message(caller, { type: "UNRELATED" });
  assert.deepEqual(navigated, [caller.url]);
});

test("retirement waits for explicit activation and keeps old tabs without claiming others", async () => {
  const old = prefix(retiredScope) + "v1-static",
    instance = worker({
      file: "retirement-worker.js",
      scope: retiredScope,
      names: [old],
      clients: [{ id: "old-tab", url: retiredScope }],
      active: true,
    });
  instance.self.registration.waiting = { state: "installed" };
  await instance.install();
  assert.deepEqual(instance.skipped, []);
  await instance.activate();
  assert.deepEqual(instance.deleted, []);
  assert.equal(instance.state.claims, 0);
  assert.equal(instance.state.unregistered, 0);
  await instance.message({ type: "window", url: retiredScope });
  assert.equal(instance.skipped.length, 1);
});

test("retired navigation uses the longest route and strips only retired parameters", async () => {
  const instance = worker({
    file: "retirement-worker.js",
    scope: retiredScope,
  });
  for (const route of manifest.legacyRoutes) {
    const url = new URL(route.path, rootScope);
    url.searchParams.set(manifest.retiredQueryParams[0], "owner");
    url.searchParams.set("g", "g-main");
    url.hash = "#today";
    const result = await instance.intercept(url.href),
      target = new URL(result.response.headers.get("Location"));
    assert.equal(result.response.status, 302);
    assert.equal(target.pathname, new URL(route.target, rootScope).pathname);
    assert.equal(target.searchParams.get("g"), "g-main");
    assert.equal(
      target.searchParams.has(manifest.retiredQueryParams[0]),
      false,
    );
    assert.equal(target.hash, "#today");
  }
});

test("retirement serves each old document's pinned bytes without outside-cache access", async () => {
  const old = prefix(retiredScope) + "v1-static",
    instance = worker({
      file: "retirement-worker.js",
      scope: retiredScope,
      names: [old, "unrelated-cache"],
      clients: [{ id: "old-tab", url: retiredScope }],
      offline: true,
    });
  await instance.seed(old, "lib/time.mjs", "old pinned module");
  await instance.seed(
    prefix(rootScope) + "current-static",
    new URL("compatibility.json", rootScope).href,
    JSON.stringify(manifest),
  );
  await instance.seed(
    "unrelated-cache",
    "lib/time.mjs",
    "unrelated private bytes",
  );
  await instance.activate();
  assert.equal(
    (
      await instance.intercept("lib/time.mjs", {
        mode: "cors",
        clientId: "old-tab",
      })
    ).body,
    "old pinned module",
  );
  assert.equal(instance.opened.includes("unrelated-cache"), false);
});

test("a foreign metadata pin cannot open another deployment's cache", async () => {
  const old = prefix(retiredScope) + "v1-static",
    instance = worker({
      file: "retirement-worker.js",
      scope: retiredScope,
      names: [old, "unrelated-cache"],
      clients: [{ id: "old-tab", url: retiredScope }],
    });
  await instance.seed(
    prefix(retiredScope) + "clients",
    ".uniflow-worker/client/old-tab",
    "unrelated-cache",
  );
  await instance.seed(
    "unrelated-cache",
    "lib/time.mjs",
    "unrelated private bytes",
  );
  await instance.seed(old, "lib/time.mjs", "own old module");
  await instance.activate();
  assert.notEqual(
    (
      await instance.intercept("lib/time.mjs", {
        mode: "cors",
        clientId: "old-tab",
      })
    ).body,
    "unrelated private bytes",
  );
  assert.equal(instance.opened.includes("unrelated-cache"), false);
});

test("retirement deletes only its own prefix after old clients close", async () => {
  const old = prefix(retiredScope) + "v1-static",
    ownMeta = prefix(retiredScope) + "clients",
    current = prefix(rootScope) + "current-static",
    neighbor = prefix("https://example.test/neighbor/") + "v1-static";
  const instance = worker({
    file: "retirement-worker.js",
    scope: retiredScope,
    names: [old, ownMeta, current, neighbor, "unrelated-cache"],
    clients: [{ id: "old-tab", url: retiredScope }],
  });
  await instance.activate();
  assert.deepEqual(instance.deleted, []);
  instance.state.clients = [{ id: "root-tab", url: rootScope }];
  await instance.message(null, { type: "RETIRE_CHECK" });
  assert.deepEqual(instance.deleted.sort(), [old, ownMeta].sort());
  assert.equal(instance.state.unregistered, 1);
  for (const name of [current, neighbor, "unrelated-cache"])
    assert.equal(instance.values.has(name), true);
});

test("an active retirement worker refreshes only the explicit old caller", async () => {
  const navigated = [],
    instance = worker({
      file: "retirement-worker.js",
      scope: retiredScope,
      active: true,
      clients: [{ id: "old-tab", url: retiredScope }],
    });
  const caller = {
    type: "window",
    url: retiredScope + "?g=g-main",
    navigate: async (url) => navigated.push(url),
  };
  await instance.activate();
  await instance.message(caller);
  assert.deepEqual(navigated, [caller.url]);
  await instance.message({ ...caller, url: rootScope });
  await instance.message(caller, { type: "UNRELATED" });
  assert.deepEqual(navigated, [caller.url]);
});

test("retirement never intercepts POST, another origin or another registration", async () => {
  const instance = worker({
    file: "retirement-worker.js",
    scope: retiredScope,
  });
  for (const [url, options] of [
    ["state", { method: "POST", mode: "cors" }],
    [rootScope, {}],
    ["https://other.test/", {}],
  ])
    assert.equal((await instance.intercept(url, options)).intercepted, false);
  assert.deepEqual(instance.opened, []);
  assert.deepEqual(instance.fetched, []);
});

test("retirement cannot redirect through external or escaping manifest targets", async () => {
  for (const target of ["https://other.test/", "../neighbor/"]) {
    const config = structuredClone(manifest);
    config.legacyRoutes[0].target = target;
    const instance = worker({
      file: "retirement-worker.js",
      scope: retiredScope,
      config,
    });
    try {
      const result = await instance.intercept("./"),
        location = result.response.headers.get("Location");
      if (location)
        assert.equal(new URL(location).href.startsWith(rootScope), true);
      else assert.ok(result.response.status >= 400);
    } catch (error) {
      assert.match(
        error.message,
        /config|manifest|policy|compatibility|route|scope/iu,
      );
    }
  }
});

test("a complete metadata-less published cache remains usable after adding presentation assets", async () => {
  const old = prefix(rootScope) + "v4-static";
  const instance = worker({
    names: [old],
    clients: [{ id: "old-tab", url: rootScope }],
    active: true,
  });
  // This fixed published fixture is independent of the current worker FILES/PREVIOUS_FILES.
  const publishedAssets = [
    "./",
    "./index.html",
    "./app.mjs",
    "./styles.css",
    "./lib/dom.mjs",
    "./lib/client.mjs",
    "./lib/i18n.mjs",
    "./lib/time.mjs",
    "./lib/storage.mjs",
    "./lib/calendar.mjs",
    "./bootstrap.json",
    "./seed.json",
    "./manifest.webmanifest",
    "./icons/icon-192.png",
    "./icons/icon-512.png",
  ];
  for (const asset of publishedAssets)
    await instance.seed(old, asset, "published-before-presentation:" + asset);
  await instance.install();
  await instance.activate();
  const pinned = await instance.intercept("lib/calendar.mjs", {
    mode: "cors",
    clientId: "old-tab",
  });
  assert.equal(pinned.response.status, 200);
  assert.equal(
    await pinned.response.text(),
    "published-before-presentation:./lib/calendar.mjs",
  );
  assert.equal(instance.deleted.includes(old), false);
  const missing = await instance.intercept("layouts/grid.mjs", {
    mode: "cors",
    clientId: "old-tab",
  });
  assert.equal(missing.response.status, 503);
});
