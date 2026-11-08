import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { fixture } from "./fixtures.mjs";

const repository = resolve(import.meta.dirname, "../..");
const compatibility = JSON.parse(
  await readFile(new URL("../../compatibility.json", import.meta.url), "utf8"),
);
const retiredPath = "/schedule/" + compatibility.cacheScopes[0];
const mime = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
};

/** A real HTTP origin and real worker, with two independently deployed scopes.
 * The fixture rewrites only the public API host to itself; production is never
 * contacted, and no active repository files are modified between releases.
 */
async function releaseOrigin() {
  const versions = {
    root: "root-v1",
    foreign: "foreign-v1",
    retired: "retired-v1",
  };
  const legacy = { root: false, foreign: false, retired: true };
  const legacySource = await readFile(
    new URL("./fixtures/legacy-worker.js", import.meta.url),
    "utf8",
  );
  const actions = [];
  let retiring = false;
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://localhost").pathname;
      if (pathname === "/functions/v1/uniflow-api") {
        let body = "";
        for await (const part of request) body += part;
        const parsed = JSON.parse(body);
        actions.push(parsed.action);
        if (parsed.action !== "state") {
          response.writeHead(405).end();
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            data: fixture,
            revision: 1,
            user: {
              id: "guest",
              role: "guest",
              groupId: "g-main",
              subgroup: parsed.subgroup || "А",
            },
            users: [],
            versions: [],
          }),
        );
        return;
      }
      const scope = pathname.startsWith(retiredPath)
        ? "retired"
        : pathname.startsWith("/other/")
          ? "foreign"
          : "root";
      const prefix =
        scope === "retired"
          ? retiredPath
          : scope === "foreign"
            ? "/other/"
            : "/schedule/";
      if (!pathname.startsWith(prefix)) {
        response.writeHead(404).end();
        return;
      }
      const relative =
        decodeURIComponent(pathname.slice(prefix.length)) || "index.html";
      if (scope === "retired" && retiring) {
        if (relative === "sw.js") {
          response.writeHead(200, { "Content-Type": "text/javascript" });
          response.end('importScripts("../retirement-worker.js");');
          return;
        }
        if (relative === "index.html") {
          response.writeHead(302, { Location: "/schedule/" });
          response.end();
          return;
        }
        response.writeHead(404).end();
        return;
      }
      const shared = {
        "appearance-policy.mjs": "backend/appearance-policy.mjs",
        "backend/appearance-policy.mjs": "backend/appearance-policy.mjs",
        "group-state.mjs": "backend/group-state.mjs",
        "backend/group-state.mjs": "backend/group-state.mjs",
        "backend/core.mjs": "backend/core.mjs",
        "compatibility.json": "compatibility.json",
      };
      const isShared = Object.hasOwn(shared, relative);
      const root = isShared ? repository : resolve(repository, "app");
      const file = resolve(root, isShared ? shared[relative] : relative);
      if (!file.startsWith(root + sep)) {
        response.writeHead(403).end();
        return;
      }
      let body = await readFile(file);
      const version = versions[scope];
      if (relative === "sw.js") {
        if (legacy[scope]) body = Buffer.from(legacySource);
        body = Buffer.from(
          body
            .toString()
            .replace(
              /^const VERSION\s*=\s*["'][^"']+["'];$/m,
              `const VERSION = '${version}';`,
            ),
        );
      } else if (relative === "app.mjs") {
        body = Buffer.from(
          body.toString() +
            `\nglobalThis.__updateFixtureVersion = ${JSON.stringify(version)};\n`,
        );
      } else if (relative === "lib/calendar.mjs") {
        body = Buffer.from(
          body.toString() +
            `\nexport const updateFixtureVersion = ${JSON.stringify(version)};\n`,
        );
      } else if (relative === "lib/client.mjs") {
        const origin = `http://127.0.0.1:${server.address().port}`;
        body = Buffer.from(
          body
            .toString()
            .replaceAll("https://anfwdrcazwbkkayczkxg.supabase.co", origin),
        );
      } else if (relative === "bootstrap.json") {
        body = Buffer.from(
          JSON.stringify({
            data: fixture,
            revision: 1,
            updatedAt: "2026-11-06T04:00:00Z",
            source: "release-snapshot",
          }),
        );
      }
      response.writeHead(200, {
        "Content-Type": mime[extname(file)] || "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    versions,
    legacy,
    actions,
    retire: () => {
      retiring = true;
    },
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}

async function ready(page, version) {
  await expect
    .poll(() =>
      page.evaluate(() => globalThis.__updateFixtureVersion).catch(() => null),
    )
    .toBe(version);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
    .toBe(true);
  // The worker fixture is historically exact; its current test UI imports
  // additional modules. Warm those through the real worker before offline QA.
  await page.evaluate(async () => {
    if (navigator.onLine)
      await Promise.all(
        [
          "./lib/compatibility.mjs",
          "./lib/compatibility-policy.mjs",
          "./lib/personal-migration.mjs",
          "./lib/initial-snapshot.mjs",
          "./owner-route.js",
          "./appearance-init.js",
          "./appearance-policy.mjs",
          "./backend/appearance-policy.mjs",
          "./group-state.mjs",
          "./backend/group-state.mjs",
          "./lib/personalization.mjs",
          "./lib/appearance-tokens.mjs",
          "./lib/layout-loader.mjs",
          "./layouts/timeline.mjs",
          "./layouts/grid.mjs",
          "./layouts/cards.mjs",
        ].map(async (path) => {
          const response = await fetch(path);
          if (!response.ok) throw Error("Cannot warm offline module: " + path);
          await response.arrayBuffer();
        }),
      );
  });
}

async function update(page, version) {
  await page.bringToFront();
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration.update();
  });
  await expect(
    page.getByRole("button", { name: "Обновить приложение", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Обновить приложение", exact: true })
    .click();
  await ready(page, version);
}

test("installed PWA updates atomically across tabs while unrelated caches stay independent", async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
  const origin = await releaseOrigin();
  const second = await context.newPage();
  const retained = await context.newPage();
  const foreign = await context.newPage();
  try {
    await page.goto(origin.url + "/schedule/");
    await ready(page, "root-v1");
    await second.goto(origin.url + "/schedule/");
    await ready(second, "root-v1");
    await retained.goto(origin.url + "/schedule/");
    await ready(retained, "root-v1");
    await foreign.goto(origin.url + "/other/");
    await ready(foreign, "foreign-v1");
    origin.versions.root = "root-v2";
    await update(page, "root-v2");
    expect(await second.evaluate(() => globalThis.__updateFixtureVersion)).toBe(
      "root-v1",
    );
    // This module was precached, but has never been imported by either page.
    // An old document must receive its old bytes after another tab updates.
    expect(
      await second.evaluate(
        async () => (await import("./lib/calendar.mjs")).updateFixtureVersion,
      ),
    ).toBe("root-v1");
    expect(
      await page.evaluate(
        async () => (await import("./lib/calendar.mjs")).updateFixtureVersion,
      ),
    ).toBe("root-v2");
    expect(
      await foreign.evaluate(() => globalThis.__updateFixtureVersion),
    ).toBe("foreign-v1");
    // The waiting worker may already be active because the first tab accepted.
    // Accepting from the second tab must still reload it, without waiting for a
    // controllerchange event which has already occurred.
    await expect(
      second.getByRole("button", { name: "Обновить приложение", exact: true }),
    ).toBeVisible();
    await second
      .getByRole("button", { name: "Обновить приложение", exact: true })
      .click();
    await ready(second, "root-v2");
    await second.close();
    origin.versions.root = "root-v3";
    await update(page, "root-v3");
    // A document can outlive several accepted releases. Its pinned cache must
    // survive the new worker instance, not merely the first activation.
    expect(
      await retained.evaluate(() => globalThis.__updateFixtureVersion),
    ).toBe("root-v1");
    expect(
      await retained.evaluate(
        async () => (await import("./lib/calendar.mjs")).updateFixtureVersion,
      ),
    ).toBe("root-v1");
    await retained.close();
    origin.versions.root = "root-v4";
    await update(page, "root-v4");
    const names = await page.evaluate(() => caches.keys());
    expect(names).not.toContain("uniflow:%2Fschedule%2F:root-v1-static");
    expect(names).toContain("uniflow:%2Fother%2F:foreign-v1-static");
    await context.setOffline(true);
    await page.reload();
    await ready(page, "root-v4");
    await foreign.reload();
    await ready(foreign, "foreign-v1");
    expect(origin.actions.every((action) => action === "state")).toBe(true);
  } finally {
    await context.setOffline(false);
    await second.close().catch(() => {});
    await retained.close().catch(() => {});
    await foreign.close();
    await origin.close();
  }
});

test("the currently published legacy worker upgrades without losing its old-tab module cache", async ({
  page,
  context,
}) => {
  test.setTimeout(45000);
  const origin = await releaseOrigin();
  origin.legacy.root = true;
  origin.legacy.foreign = true;
  const old = await context.newPage();
  const untouched = await context.newPage();
  const foreign = await context.newPage();
  try {
    await page.goto(origin.url + "/schedule/");
    await ready(page, "root-v1");
    await old.goto(origin.url + "/schedule/");
    await ready(old, "root-v1");
    await untouched.goto(origin.url + "/schedule/");
    await ready(untouched, "root-v1");
    await foreign.goto(origin.url + "/other/");
    await ready(foreign, "foreign-v1");
    expect(
      (await page.evaluate(() => caches.keys())).filter((name) =>
        name.endsWith(":clients"),
      ),
    ).toEqual([]);
    origin.legacy.root = false;
    origin.versions.root = "root-v2";
    await update(page, "root-v2");
    expect(await old.evaluate(() => globalThis.__updateFixtureVersion)).toBe(
      "root-v1",
    );
    expect(
      await old.evaluate(
        async () => (await import("./lib/calendar.mjs")).updateFixtureVersion,
      ),
    ).toBe("root-v1");
    expect(
      await page.evaluate(
        async () => (await import("./lib/calendar.mjs")).updateFixtureVersion,
      ),
    ).toBe("root-v2");
    const names = await page.evaluate(() => caches.keys());
    expect(names).toContain("uniflow:%2Fschedule%2F:root-v1-static");
    expect(names).toContain("uniflow:%2Fother%2F:foreign-v1-static");
    expect(names).toContain("uniflow:%2Fschedule%2F:clients");
    // Exact legacy-button behaviour: it blindly posts to the worker reference
    // and waits for controllerchange, which already fired in this old tab.
    // No new-app guard and no external page.reload() may rescue this request.
    await old.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        () => location.reload(),
        { once: true },
      );
      registration.active.postMessage({ type: "SKIP_WAITING" });
    });
    await ready(old, "root-v2");
    expect(
      await untouched.evaluate(() => globalThis.__updateFixtureVersion),
    ).toBe("root-v1");
    expect(
      await foreign.evaluate(() => globalThis.__updateFixtureVersion),
    ).toBe("foreign-v1");
    await context.setOffline(true);
    await foreign.reload();
    await ready(foreign, "foreign-v1");
    expect(origin.actions.every((action) => action === "state")).toBe(true);
  } finally {
    await context.setOffline(false);
    await old.close();
    await untouched.close();
    await foreign.close();
    await origin.close();
  }
});

test("retiring an installed address waits for explicit updates, preserves live tasks and clears only its own caches", async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
  const origin = await releaseOrigin();
  const retained = await context.newPage(),
    canonical = await context.newPage();
  const oldCache = `uniflow:${encodeURIComponent(retiredPath)}:retired-v1-static`;
  const oldPrefix = `uniflow:${encodeURIComponent(retiredPath)}:`;
  await context.addInitScript(() => {
    localStorage.setItem("uf.group", JSON.stringify("g-main"));
    localStorage.setItem("uf.subgroup", JSON.stringify("А"));
  });
  try {
    await page.goto(origin.url + retiredPath);
    await ready(page, "retired-v1");
    await retained.goto(origin.url + retiredPath);
    await ready(retained, "retired-v1");
    await retained.evaluate(() => {
      window.unpublishedDraft = "keep until my explicit update";
    });
    await page.evaluate(async () => {
      const storage = await import("./lib/storage.mjs");
      await storage.set("personal:live:g-main:А", [
        {
          id: "retained-personal",
          title: "Личное задание после перехода",
          due: "2026-11-08",
          groupId: "g-main",
        },
      ]);
      await (
        await caches.open("unrelated-owner-cache")
      ).put(new URL("/unrelated-proof", location.origin), new Response("keep"));
    });
    origin.retire();
    await canonical.goto(origin.url + "/schedule/");
    await ready(canonical, "root-v1");
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration()).update();
    });
    await expect(
      page.getByRole("button", { name: "Обновить приложение", exact: true }),
    ).toBeVisible();
    expect(await retained.evaluate(() => window.unpublishedDraft)).toBe(
      "keep until my explicit update",
    );
    expect(await page.evaluate(() => caches.keys())).toContain(oldCache);
    await page
      .getByRole("button", { name: "Обновить приложение", exact: true })
      .click();
    await ready(page, "root-v1");
    await expect(page).toHaveURL(origin.url + "/schedule/");
    expect(await retained.evaluate(() => window.unpublishedDraft)).toBe(
      "keep until my explicit update",
    );
    expect(
      await retained.evaluate(
        async () => (await import("./lib/calendar.mjs")).updateFixtureVersion,
      ),
    ).toBe("retired-v1");
    // The genuine old update-button protocol waits only for controllerchange.
    // The already-active retirement worker must navigate this caller itself.
    await retained.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        () => location.reload(),
        { once: true },
      );
      registration.active.postMessage({ type: "SKIP_WAITING" });
    });
    await ready(retained, "root-v1");
    await expect
      .poll(async () =>
        (await page.evaluate(() => caches.keys())).some((name) =>
          name.startsWith(oldPrefix),
        ),
      )
      .toBe(false);
    expect(await page.evaluate(() => caches.keys())).toContain(
      "unrelated-owner-cache",
    );
    await expect
      .poll(async () =>
        page.evaluate(
          async (scope) =>
            (await navigator.serviceWorker.getRegistrations()).some(
              (registration) => registration.scope === scope,
            ),
          origin.url + retiredPath,
        ),
      )
      .toBe(false);
    await context.setOffline(true);
    await page.reload();
    await ready(page, "root-v1");
    await page.getByRole("button", { name: "Задания", exact: true }).click();
    await expect(
      page.getByRole("heading", {
        name: "Личное задание после перехода",
        exact: true,
      }),
    ).toBeVisible();
    expect(origin.actions.every((action) => action === "state")).toBe(true);
  } finally {
    await context.setOffline(false);
    await retained.close();
    await canonical.close();
    await origin.close();
  }
});
