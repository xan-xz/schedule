/* Scope is beta only. Authenticated POST responses are intentionally never cached. */
const VERSION = 'uniflow-beta-v1';
const STATIC = `${VERSION}-static`;
const FILES = [
  './', './index.html', './app.mjs', './styles.css',
  './lib/dom.mjs', './lib/client.mjs', './lib/i18n.mjs',
  './lib/time.mjs', './lib/storage.mjs', './lib/calendar.mjs',
  './bootstrap.json', './seed.json', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC);
    await Promise.all(FILES.map(async path => {
      const request = new Request(new URL(path, self.registration.scope), { cache: 'reload' });
      const response = await fetch(request);
      if (!response.ok) throw new Error(`Cannot prepare offline asset: ${path}`);
      await cache.put(request, response);
    }));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('uniflow-beta-') && key !== STATIC).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  const sharedModel = new URL('../backend/core.mjs', self.registration.scope).href;
  if (request.method !== 'GET' || url.origin !== self.location.origin
    || (!url.href.startsWith(self.registration.scope) && url.href !== sharedModel)) return;
  if (request.mode === 'navigate') {
    // Staff has its own document and online-only authorization. Never replace it
    // with the student shell when navigating from an already controlled page.
    if (url.pathname.startsWith(new URL('manage/', self.registration.scope).pathname)) return;
    event.respondWith((async () => {
      const cache = await caches.open(STATIC);
      // Cache-first shell opens instantly; worker byte changes govern application updates.
      return await cache.match(new URL('index.html', self.registration.scope)) || fetch(request);
    })());
    return;
  }
  if (url.pathname.endsWith('/seed.json') || url.pathname.endsWith('/bootstrap.json')) {
    event.respondWith((async () => {
      const cache = await caches.open(STATIC);
      const cached = await cache.match(request);
      const fresh = fetch(request).then(async response => {
        if (response.ok) await cache.put(request, response.clone());
        return response;
      });
      if (cached) {
        event.waitUntil(fresh.catch(() => {}));
        return cached;
      }
      return fresh;
    })());
    return;
  }
  if (/\.(?:mjs|js|css|png|svg|webmanifest)$/.test(url.pathname) && !url.pathname.endsWith('/sw.js')) {
    event.respondWith((async () => {
      const cache = await caches.open(STATIC);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
      return response;
    })());
  }
});
