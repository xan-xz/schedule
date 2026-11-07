import * as storage from "./storage.mjs";
import { validateCompatibility } from "./compatibility-policy.mjs";
import { migrateRetiredPersonal } from "./personal-migration.mjs";

/** Retire only the exact public namespaces named by the compatibility manifest. */
export async function retireCompatibility() {
  try {
    // This module is bundled into the root entry in production. Resolve public
    // assets from the document, never from this source module's former folder.
    const root = new URL("./", location.href);
    const response = await fetch(new URL("compatibility.json", root), {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return;
    const config = await response.json();
    if (!validateCompatibility(config)) return;
    const migration = await migrateRetiredPersonal(config.storage);
    if (!migration.ok) return migration;
    const url = new URL(location.href);
    for (const key of config.retiredQueryParams) url.searchParams.delete(key);
    if (url.href !== location.href)
      history.replaceState(null, "", url.pathname + url.search + url.hash);
    try {
      const keys = Array.from({ length: localStorage.length }, (_, index) =>
        localStorage.key(index),
      );
      for (const key of keys)
        if (
          key &&
          (config.storage.localExact.includes(key) ||
            config.storage.localPrefixes.some((prefix) =>
              key.startsWith(prefix),
            ))
        )
          localStorage.removeItem(key);
    } catch {
      /* A restricted store never prevents the public timetable. */
    }
    await storage.retirePrefixes(config.storage.publicPrefixes);
    if ("serviceWorker" in navigator)
      void (async () => {
        for (const registration of await navigator.serviceWorker.getRegistrations()) {
          if (
            !config.cacheScopes.some(
              (path) => new URL(path, root).href === registration.scope,
            )
          )
            continue;
          // Updating may install a waiting retirement worker. Existing open
          // documents still decide when to apply it; no skipWaiting is sent here.
          await registration.update().catch(() => {});
          const worker =
            registration.installing ||
            registration.waiting ||
            registration.active;
          worker?.postMessage({ type: "RETIRE_CHECK" });
          worker?.addEventListener("statechange", () => {
            if (worker.state === "activated")
              worker.postMessage({ type: "RETIRE_CHECK" });
          });
        }
      })().catch(() => {});
    return migration;
  } catch {
    /* Offline clients can complete retirement on their next online visit. */
  }
}
