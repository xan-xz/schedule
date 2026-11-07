import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { fixture } from "./fixtures.mjs";

const repository = resolve(import.meta.dirname, "../..");
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
  const versions = { root: "root-v1", beta: "beta-v1" };
  const legacy = { root: false, beta: false };
  const legacySource = await readFile(
    new URL("./fixtures/legacy-worker.js", import.meta.url),
    "utf8",
  );
  const actions = [];
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
      const scope = pathname.startsWith("/schedule/beta/") ? "beta" : "root";
      const prefix = scope === "beta" ? "/schedule/beta/" : "/schedule/";
      if (!pathname.startsWith(prefix)) {
        response.writeHead(404).end();
        return;
      }
      const relative =
        decodeURIComponent(pathname.slice(prefix.length)) || "index.html";
      const root =
        relative === "backend/core.mjs"
          ? repository
          : resolve(repository, "beta");
      const file = resolve(root, relative);
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
}

async function update(page, version) {
  await page.evaluate(async () =>
    (await navigator.serviceWorker.getRegistration()).update(),
  );
  await expect(
    page.getByRole("button", { name: "Обновить приложение", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Обновить приложение", exact: true })
    .click();
  await ready(page, version);
}

test("installed PWA updates atomically across tabs while root and beta caches stay independent", async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
  const origin = await releaseOrigin();
  const second = await context.newPage();
  const retained = await context.newPage();
  const beta = await context.newPage();
  try {
    await page.goto(origin.url + "/schedule/");
    await ready(page, "root-v1");
    await second.goto(origin.url + "/schedule/");
    await ready(second, "root-v1");
    await retained.goto(origin.url + "/schedule/");
    await ready(retained, "root-v1");
    await beta.goto(origin.url + "/schedule/beta/?demo=student");
    await ready(beta, "beta-v1");
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
    expect(await beta.evaluate(() => globalThis.__updateFixtureVersion)).toBe(
      "beta-v1",
    );
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
    expect(names).toContain("uniflow:%2Fschedule%2Fbeta%2F:beta-v1-static");
    await context.setOffline(true);
    await page.reload();
    await ready(page, "root-v4");
    await beta.reload();
    await ready(beta, "beta-v1");
    expect(origin.actions.every((action) => action === "state")).toBe(true);
  } finally {
    await context.setOffline(false);
    await second.close().catch(() => {});
    await retained.close().catch(() => {});
    await beta.close();
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
  origin.legacy.beta = true;
  const old = await context.newPage();
  const untouched = await context.newPage();
  const beta = await context.newPage();
  try {
    await page.goto(origin.url + "/schedule/");
    await ready(page, "root-v1");
    await old.goto(origin.url + "/schedule/");
    await ready(old, "root-v1");
    await untouched.goto(origin.url + "/schedule/");
    await ready(untouched, "root-v1");
    await beta.goto(origin.url + "/schedule/beta/?demo=student");
    await ready(beta, "beta-v1");
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
    expect(names).toContain("uniflow:%2Fschedule%2Fbeta%2F:beta-v1-static");
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
    expect(await beta.evaluate(() => globalThis.__updateFixtureVersion)).toBe(
      "beta-v1",
    );
    await context.setOffline(true);
    await beta.reload();
    await ready(beta, "beta-v1");
    expect(origin.actions.every((action) => action === "state")).toBe(true);
  } finally {
    await context.setOffline(false);
    await old.close();
    await untouched.close();
    await beta.close();
    await origin.close();
  }
});
