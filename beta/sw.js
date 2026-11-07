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
const FILES = [
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
                  FILES.map((path) => candidate.match(new URL(path, SCOPE))),
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
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
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
  const sharedModel = new URL("../backend/core.mjs", self.registration.scope)
    .href;
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    (!url.href.startsWith(self.registration.scope) && url.href !== sharedModel)
  )
    return;
  const relative = url.pathname.slice(SCOPE.pathname.length);
  // A root-scope installation must not take over the independently deployed
  // /beta/ alias or staff workspace. Those documents and assets use the network
  // or their own more specific worker.
  if (
    url.href !== sharedModel &&
    relative.includes("/") &&
    !["lib", "icons"].includes(relative.split("/")[0])
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
    url.pathname.endsWith("/bootstrap.json")
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
