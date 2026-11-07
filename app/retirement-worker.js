/* A waiting replacement for one retired registration. Existing documents keep
 * their cached release until their user deliberately chooses the update. */
const SCOPE = new URL(self.registration.scope);
const ROOT = new URL("../", SCOPE);
const PREFIX = `uniflow:${encodeURIComponent(SCOPE.pathname)}:`;
const META = PREFIX + "clients";
const pins = new Map();
let policy;
async function configuration() {
  if (!policy)
    policy = (async () => {
      const url = new URL("compatibility.json", ROOT);
      const response = await fetch(url, { cache: "no-store" }).catch(() =>
        caches.match(url),
      );
      if (!response?.ok) throw Error("Retirement policy unavailable");
      const config = await response.json();
      if (
        config?.format !== "uniflow-compatibility-v1" ||
        !Array.isArray(config.cacheScopes) ||
        !Array.isArray(config.legacyRoutes) ||
        !Array.isArray(config.retiredQueryParams)
      )
        throw Error("Invalid retirement policy");
      if (
        !config.cacheScopes.some(
          (path) =>
            /^[A-Za-z0-9_-]+\/$/.test(path) &&
            new URL(path, ROOT).href === SCOPE.href &&
            config.legacyRoutes.some(
              (route) =>
                route.path === path &&
                route.worker === true &&
                route.target === "./",
            ),
        )
      )
        throw Error("Unrecognized retirement scope");
      if (
        config.legacyRoutes.some(
          (route) =>
            !/^(?:[A-Za-z0-9_-]+\/)+$/.test(route.path) ||
            !["./", "./admin/"].includes(route.target),
        ) ||
        config.retiredQueryParams.some(
          (key) =>
            typeof key !== "string" ||
            !key ||
            ["g", "group", "subgroup", "date"].includes(key),
        )
      )
        throw Error("Unsafe retirement target");
      return config;
    })().catch((error) => {
      policy = null;
      throw error;
    });
  return policy;
}
const belongs = (client) => {
  try {
    return new URL(client.url).href.startsWith(SCOPE.href);
  } catch {
    return false;
  }
};
async function cleanup() {
  await configuration();
  const clients = (
    await self.clients.matchAll({ type: "window", includeUncontrolled: true })
  ).filter(belongs);
  if (clients.length) return;
  await Promise.all(
    (await caches.keys())
      .filter((name) => name.startsWith(PREFIX))
      .map((name) => caches.delete(name)),
  );
  await self.registration.unregister();
}
self.addEventListener("install", (event) => event.waitUntil(configuration()));
self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      await configuration();
      const names = (await caches.keys()).filter(
        (name) => name.startsWith(PREFIX) && name.endsWith("-static"),
      );
      const metadata = await caches.open(META);
      for (const client of (
        await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        })
      ).filter(belongs)) {
        const previous = await metadata.match(
          new URL(
            ".uniflow-worker/client/" + encodeURIComponent(client.id),
            SCOPE,
          ),
        );
        const pin = previous ? await previous.text() : null;
        pins.set(
          client.id,
          pin?.startsWith(PREFIX) && pin.endsWith("-static")
            ? pin
            : names.at(-1),
        );
      }
      await cleanup();
    })(),
  ),
);
self.addEventListener("message", (event) => {
  if (event.data?.type === "RETIRE_CHECK") {
    event.waitUntil(cleanup());
    return;
  }
  if (event.data?.type !== "SKIP_WAITING") return;
  event.waitUntil(
    (async () => {
      if (
        self.registration.active?.state === "activated" &&
        !self.registration.waiting &&
        !self.registration.installing &&
        belongs(event.source) &&
        event.source?.navigate
      )
        await event.source.navigate(event.source.url);
      else await self.skipWaiting();
    })(),
  );
});
self.addEventListener("fetch", (event) => {
  const request = event.request,
    url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== SCOPE.origin ||
    !url.href.startsWith(SCOPE.href)
  )
    return;
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        const config = await configuration();
        const relative = url.pathname.slice(ROOT.pathname.length);
        const route = [...config.legacyRoutes]
          .sort((a, b) => b.path.length - a.path.length)
          .find((route) => relative.startsWith(route.path));
        const target = new URL(route?.target || "./", ROOT);
        target.search = url.search;
        for (const key of config.retiredQueryParams)
          target.searchParams.delete(key);
        target.hash = url.hash;
        return Response.redirect(target.href, 302);
      })(),
    );
    event.waitUntil(cleanup());
    return;
  }
  event.respondWith(
    (async () => {
      const pin = pins.get(event.clientId);
      const cached = pin && (await caches.open(pin)).match(request);
      return (await cached) || fetch(request);
    })(),
  );
});
