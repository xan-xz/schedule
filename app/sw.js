/* Each deployed scope owns its cache. Authenticated POST responses are never cached. */
const SCOPE = new URL(self.registration.scope);
const PREFIX = `uniflow:${encodeURIComponent(SCOPE.pathname)}:`;
const VERSION = "v2";
const STATIC = `${PREFIX}${VERSION}-static`;
const META = `${PREFIX}clients`;
const ACTIVE_KEY = new URL(".uniflow-worker/active", SCOPE);
const INSTALL_KEY = new URL(".uniflow-worker/install/" + VERSION, SCOPE);
const clientKey = (id) =>
  new URL(".uniflow-worker/client/" + encodeURIComponent(id), SCOPE);
const belongsToShell = (client) => {
  try {
    const url = new URL(client.url);
    return (
      url.origin === SCOPE.origin &&
      (url.pathname === SCOPE.pathname ||
        url.pathname === new URL("index.html", SCOPE).pathname)
    );
  } catch {
    return false;
  }
};
async function cachedName(metadata, key) {
  try {
    return (await (await metadata.match(key))?.text()) || null;
  } catch {
    return null;
  }
}
async function requestCache(event) {
  if (!event.clientId) return STATIC;
  const metadata = await caches.open(META);
  return (await cachedName(metadata, clientKey(event.clientId))) || STATIC;
}
async function pruneInactive() {
  const metadata = await caches.open(META);
  const clients = (
    await self.clients.matchAll({ type: "window", includeUncontrolled: true })
  ).filter(belongsToShell);
  const keep = new Set([STATIC]);
  for (const client of clients) {
    const pin = await cachedName(metadata, clientKey(client.id));
    if (pin?.startsWith(PREFIX) && pin.endsWith("-static")) keep.add(pin);
  }
  await Promise.all(
    (await caches.keys())
      .filter(
        (name) =>
          name.startsWith(PREFIX) &&
          name.endsWith("-static") &&
          !keep.has(name),
      )
      .map((name) => caches.delete(name)),
  );
}
const FILES = [
  "./",
  "./index.html",
  "./app.mjs",
  "./styles.css",
  "./appearance-init.js",
  "./appearance-policy.mjs",
  "./backend/appearance-policy.mjs",
  "./group-state.mjs",
  "./backend/group-state.mjs",
  "./public-data.mjs",
  "./backend/public-data.mjs",
  "./lib/personalization.mjs",
  "./lib/appearance-tokens.mjs",
  "./lib/layout-loader.mjs",
  "./layouts/timeline.mjs",
  "./layouts/grid.mjs",
  "./layouts/cards.mjs",
  "./owner-route.js",
  "./lib/dom.mjs",
  "./lib/client.mjs",
  "./lib/initial-snapshot.mjs",
  "./lib/i18n.mjs",
  "./lib/time.mjs",
  "./lib/storage.mjs",
  "./lib/calendar.mjs",
  "./lib/compatibility.mjs",
  "./lib/compatibility-policy.mjs",
  "./lib/personal-migration.mjs",
  "./compatibility.json",
  "./bootstrap.json",
  "./seed.json",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];
// Frozen published shell contract: new optional assets cannot invalidate an old complete cache.
const PREVIOUS_FILES = [
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

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const metadata = await caches.open(META);
      await metadata.put(
        INSTALL_KEY,
        new Response(self.registration.active ? "1" : "0"),
      );
      const cache = await caches.open(STATIC);
      await Promise.all(
        FILES.map(async (path) => {
          const request = new Request(new URL(path, self.registration.scope), {
            cache: "reload",
          });
          const response = await fetch(request);
          if (!response.ok)
            throw new Error(`Cannot prepare offline asset: ${path}`);
          await cache.put(request, response);
        }),
      );
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const versions = keys.filter(
        (key) => key.startsWith(PREFIX) && key.endsWith("-static"),
      );
      const metadata = await caches.open(META);
      const active = await cachedName(metadata, ACTIVE_KEY);
      const hadActive = await cachedName(metadata, INSTALL_KEY);
      // Published legacy workers have no version metadata. Choose the latest
      // complete prior shell, ignoring failed/partial installation caches.
      let previous = null;
      if (hadActive !== "0") {
        if (active?.startsWith(PREFIX) && active.endsWith("-static"))
          previous = active;
        else
          for (const name of versions
            .filter((name) => name !== STATIC)
            .reverse()) {
            const candidate = await caches.open(name);
            if (
              (
                await Promise.all(
                  PREVIOUS_FILES.map((path) =>
                    candidate.match(new URL(path, SCOPE)),
                  ),
                )
              ).every(Boolean)
            ) {
              previous = name;
              break;
            }
          }
        // An evicted legacy shell cannot safely use new module bytes. Such a
        // document gets an empty retired pin until the user navigates/reloads.
        previous ||= `${PREFIX}retired-${VERSION}-static`;
      }
      const clients = (
        (await self.clients.matchAll?.({
          type: "window",
          includeUncontrolled: true,
        })) || []
      ).filter(belongsToShell);
      const keep = new Set([STATIC]);
      const liveKeys = new Set();
      for (const client of clients) {
        const key = clientKey(client.id);
        liveKeys.add(key.href);
        const pinned = await cachedName(metadata, key);
        const name =
          pinned?.startsWith(PREFIX) && pinned.endsWith("-static")
            ? pinned
            : previous || STATIC;
        keep.add(name);
        await metadata.put(key, new Response(name));
      }
      for (const key of await metadata.keys()) {
        if (key.url !== ACTIVE_KEY.href && !liveKeys.has(key.url))
          await metadata.delete(key);
      }
      await metadata.put(ACTIVE_KEY, new Response(STATIC));
      await Promise.all(
        versions
          .filter((key) => !keep.has(key))
          .map((key) => caches.delete(key)),
      );
      // Do not disturb another registration or an old open document. Its last
      // cached bytes remain available until that document deliberately reloads.
      try {
        const config = await (
          await caches.open(STATIC)
        )
          .match(new URL("compatibility.json", SCOPE))
          .then((response) => response?.json());
        const allClients = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });
        for (const path of config?.cacheScopes || []) {
          if (
            config?.format !== "uniflow-compatibility-v1" ||
            !/^[A-Za-z0-9_-]+\/$/.test(path) ||
            !config.legacyRoutes?.some(
              (route) =>
                route.path === path &&
                route.worker === true &&
                route.target === "./",
            )
          )
            continue;
          const oldScope = new URL(path, SCOPE);
          if (
            oldScope.origin !== SCOPE.origin ||
            !oldScope.href.startsWith(SCOPE.href) ||
            oldScope.href === SCOPE.href
          )
            continue;
          if (allClients.some((client) => client.url.startsWith(oldScope.href)))
            continue;
          const oldPrefix = `uniflow:${encodeURIComponent(oldScope.pathname)}:`;
          await Promise.all(
            keys
              .filter((key) => key.startsWith(oldPrefix))
              .map((key) => caches.delete(key)),
          );
        }
      } catch {
        /* Retirement retries after a later complete install. */
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "CLEAN_INACTIVE") {
    event.waitUntil(pruneInactive());
    return;
  }
  if (event.data?.type !== "SKIP_WAITING") return;
  event.waitUntil(
    (async () => {
      const metadata = await caches.open(META);
      // An already-open legacy app waits only for controllerchange. If another
      // tab has activated us, that event has already happened. Its explicit
      // update request must navigate this caller, never every open document.
      if (
        (await cachedName(metadata, ACTIVE_KEY)) === STATIC &&
        event.source?.type === "window" &&
        belongsToShell(event.source) &&
        typeof event.source.navigate === "function"
      ) {
        await event.source.navigate(event.source.url);
        return;
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  const sharedModel = new URL("./backend/core.mjs", self.registration.scope)
    .href;
  const sharedPolicy = new URL(
    "./backend/appearance-policy.mjs",
    self.registration.scope,
  ).href;
  const sharedGroupState = new URL(
    "./backend/group-state.mjs",
    self.registration.scope,
  ).href;
  const sharedPublicData = new URL(
    "./backend/public-data.mjs",
    self.registration.scope,
  ).href;
  const sharedAsset =
    url.href === sharedModel ||
    url.href === sharedPolicy ||
    url.href === sharedGroupState ||
    url.href === sharedPublicData;
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    (!url.href.startsWith(self.registration.scope) && !sharedAsset)
  )
    return;
  const relative = url.pathname.slice(SCOPE.pathname.length);
  // A root-scope installation must not take over the independently deployed
  // Retired aliases and the private workspace use the network
  // or their own more specific worker.
  if (
    !sharedAsset &&
    relative.includes("/") &&
    !["lib", "icons", "layouts"].includes(relative.split("/")[0])
  )
    return;
  if (request.mode === "navigate") {
    if (
      url.pathname !== SCOPE.pathname &&
      url.pathname !== new URL("index.html", SCOPE).pathname
    )
      return;
    event.respondWith(
      (async () => {
        const cache = await caches.open(STATIC);
        // A navigation starts a complete release. Existing documents keep their
        // old cache pin until they navigate, so a lazy import cannot mix versions.
        if (event.resultingClientId) {
          const metadata = await caches.open(META);
          await metadata.put(
            clientKey(event.resultingClientId),
            new Response(STATIC),
          );
        }
        return (
          (await cache.match(new URL("index.html", self.registration.scope))) ||
          fetch(request)
        );
      })(),
    );
    return;
  }
  if (
    url.pathname.endsWith("/seed.json") ||
    url.pathname.endsWith("/bootstrap.json") ||
    url.pathname.endsWith("/compatibility.json")
  ) {
    event.respondWith(
      (async () => {
        const name = await requestCache(event);
        const cache = await caches.open(name);
        const cached = await cache.match(request);
        if (name !== STATIC && cached) return cached;
        if (name !== STATIC)
          return new Response(
            "This release is no longer cached. Reload to update.",
            { status: 503 },
          );
        const fresh = fetch(request).then(async (response) => {
          if (response.ok) await cache.put(request, response.clone());
          return response;
        });
        if (cached) {
          event.waitUntil(fresh.catch(() => {}));
          return cached;
        }
        return fresh;
      })(),
    );
    return;
  }
  if (
    /\.(?:mjs|js|css|png|svg|webmanifest)$/.test(url.pathname) &&
    !url.pathname.endsWith("/sw.js")
  ) {
    event.respondWith(
      (async () => {
        const name = await requestCache(event);
        const cache = await caches.open(name);
        const cached = await cache.match(request);
        if (cached) return cached;
        if (name !== STATIC)
          return new Response(
            "This release is no longer cached. Reload to update.",
            { status: 503 },
          );
        const response = await fetch(request);
        if (response.ok && response.type === "basic")
          await cache.put(request, response.clone());
        return response;
      })(),
    );
  }
});
