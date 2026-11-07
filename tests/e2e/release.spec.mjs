import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { mockState } from "./fixtures.mjs";
const compatibility = JSON.parse(
  await readFile(new URL("../../compatibility.json", import.meta.url), "utf8"),
);

test("compiled migration assets stay inside the deployed project subpath", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL).origin;
  const escaped = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin && !url.pathname.startsWith("/schedule/")) {
      escaped.push(url.pathname);
      await route.fulfill({ status: 404, body: "Outside project subpath" });
    } else await route.continue();
  });
  await mockState(page);
  const configResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/compatibility.json"),
  );
  await page.goto("/schedule/");
  const response = await configResponse;
  expect(new URL(response.url()).pathname).toBe("/schedule/compatibility.json");
  expect(response.ok()).toBe(true);
  await expect(
    page.getByRole("navigation", { name: "Основные разделы", exact: true }),
  ).toBeVisible();
  expect(escaped).toEqual([]);
});

test("retired addresses and obsolete query switches resolve to the sole canonical product", async ({
  page,
}) => {
  const requests = await mockState(page);
  for (const route of compatibility.legacyRoutes) {
    const url = new URL("http://fixture.test/schedule/" + route.path);
    for (const param of compatibility.retiredQueryParams)
      url.searchParams.set(param, "admin");
    await page.goto(url.pathname + url.search);
    const target = new URL(route.target, "http://fixture.test/schedule/")
      .pathname;
    await expect(page).toHaveURL(
      new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"),
    );
    if (route.target === "./")
      await expect(
        page.getByRole("heading", { name: "Алгоритмы", exact: true }).first(),
      ).toBeVisible();
    else
      await expect(
        page.getByRole("heading", { name: "Вход владельца", exact: true }),
      ).toBeVisible();
  }
  const query = new URLSearchParams(
    compatibility.retiredQueryParams.map((key) => [key, "student"]),
  );
  await page.goto("/schedule/?" + query);
  await expect(page).toHaveURL(/\/schedule\/$/);
  await expect(
    page.getByRole("navigation", { name: "Основные разделы", exact: true }),
  ).toBeVisible();
  expect(
    requests.every((request) => ["state", "status"].includes(request.action)),
  ).toBe(true);
});

test("the offline public shell stays available while the owner workspace requires verification", async ({
  page,
  context,
}) => {
  await mockState(page);
  await page.goto("/schedule/");
  await expect(
    page.getByRole("heading", { name: "Алгоритмы", exact: true }).first(),
  ).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Алгоритмы", exact: true }).first(),
  ).toBeVisible();
  await context.setOffline(false);
  await page.goto("/schedule/manage/");
  await expect(page).toHaveURL(/\/admin\/$/);
  await expect(
    page.getByRole("heading", { name: "Вход владельца", exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-page="schedule"]')).toHaveCount(0);
  const privateCache = await page.evaluate(async () => {
    for (const name of await caches.keys()) {
      if (
        (await (await caches.open(name)).keys()).some((request) =>
          new URL(request.url).pathname.includes("/admin/"),
        )
      )
        return true;
    }
    return false;
  });
  expect(privateCache).toBe(false);
});

test("the static-host 404 document safely resolves a deep retired bookmark", async ({
  page,
}) => {
  await mockState(page);
  await page.goto(
    "/schedule/" + compatibility.legacyRoutes[0].path + "previous-bookmark/",
  );
  await expect(page).toHaveURL(/\/schedule\/$/);
  await expect(
    page.getByRole("navigation", { name: "Основные разделы", exact: true }),
  ).toBeVisible();
});

test("human personal entries migrate durably while canonical collisions and unrelated progress stay isolated", async ({
  page,
}) => {
  await mockState(page);
  await page.goto("/schedule/");
  await expect(
    page.getByRole("heading", { name: "Сегодня", exact: true }),
  ).toBeVisible();
  const migration = compatibility.storage.personalMigrations[0];
  await page.evaluate(
    async ({ migration, completionPrefix }) => {
      const storage = await import(
          new URL("./lib/storage.mjs", location.href).href
        ),
        scope = "g-main:А";
      const task = (id, title) => ({
        id,
        title,
        due: "2026-11-08",
        groupId: "g-main",
      });
      const rawKey = "uf.public.v1.personal:live:" + scope;
      localStorage.setItem(
        rawKey,
        JSON.stringify([task("stale", "Прежняя копия")]),
      );
      const remove = window.Storage.prototype.removeItem;
      window.Storage.prototype.removeItem = function (key) {
        if (key === rawKey) throw Error("remove denied");
        return remove.call(this, key);
      };
      try {
        await storage.set("personal:live:" + scope, [
          task("same", "Каноническое задание"),
        ]);
        await Promise.all(
          ["one", "two"].map((id) =>
            storage.update(
              "personal:live:" + scope,
              (current) => [...current, task(id, "Новое параллельное " + id)],
              [],
            ),
          ),
        );
      } finally {
        window.Storage.prototype.removeItem = remove;
      }
      await storage.set("statuses:live:" + scope, { same: "new" });
      await storage.set(migration.personalFrom + scope, [
        task("same", "Старый конфликтующий текст"),
        task("human", "Личное задание из прежнего контекста"),
      ]);
      await storage.set(migration.statusesFrom + scope, {
        same: "done",
        human: "progress",
        "unmatched-global": "done",
      });
      localStorage.setItem(
        completionPrefix + "older-profile",
        JSON.stringify(["human", "unmatched-global"]),
      );
    },
    {
      migration,
      completionPrefix: compatibility.storage.legacyCompletionPrefixes[0],
    },
  );
  await page.reload();
  await page.getByRole("button", { name: "Задания", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Личное задание из прежнего контекста",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", {
      name: "Личное задание из прежнего контекста · Статус",
      exact: true,
    }),
  ).toHaveValue("progress");
  await expect(
    page.getByRole("heading", { name: "Каноническое задание", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Старый конфликтующий текст",
      exact: true,
    }),
  ).toHaveCount(0);
  const result = await page.evaluate(async (migration) => {
    const storage = await import(
        new URL("./lib/storage.mjs", location.href).href
      ),
      scope = "g-main:А";
    return {
      tasks: await storage.get("personal:live:" + scope),
      statuses: await storage.get("statuses:live:" + scope),
      old: await storage.get(migration.personalFrom + scope),
      history: await storage.get("personal-history:live:" + scope),
    };
  }, migration);
  expect(result.tasks.map((task) => task.id).sort()).toEqual([
    "human",
    "one",
    "same",
    "two",
  ]);
  expect(result.statuses).toEqual({ same: "new", human: "progress" });
  expect(result.old).toBeNull();
  expect(result.history.copies[0].personal[0].title).toBe(
    "Старый конфликтующий текст",
  );
});

test("an older-tab source change prevents an atomic source-pair deletion without removing its sibling statuses", async ({
  page,
}) => {
  await mockState(page);
  await page.goto("/schedule/");
  const result = await page.evaluate(async () => {
    const storage = await import("./lib/storage.mjs");
    const key = "migration-test:personal",
      status = "migration-test:statuses";
    const earlier = [{ id: "human", title: "First text" }],
      changed = [...earlier, { id: "later", title: "Older tab's latest edit" }],
      statuses = { human: "done" };
    await storage.set(key, earlier);
    await storage.set(status, statuses);
    await storage.set(key, changed);
    const refused = await storage.deleteIfUnchanged([
      [key, earlier],
      [status, statuses],
    ]);
    const retained = [await storage.get(key), await storage.get(status)];
    const removed = await storage.deleteIfUnchanged([
      [key, changed],
      [status, statuses],
    ]);
    return {
      refused,
      retained,
      removed,
      after: [await storage.get(key), await storage.get(status)],
    };
  });
  expect(result.refused).toBe(false);
  expect(result.retained).toEqual([
    [
      { id: "human", title: "First text" },
      { id: "later", title: "Older tab's latest edit" },
    ],
    { human: "done" },
  ]);
  expect(result.removed).toBe(true);
  expect(result.after).toEqual([null, null]);
});

test("a quota failure keeps the old human copy and a later verified retry recovers it without unsafe local deletion", async ({
  page,
}) => {
  await mockState(page);
  await page.goto("/schedule/");
  await expect(
    page.getByRole("heading", { name: "Сегодня", exact: true }),
  ).toBeVisible();
  const migration = compatibility.storage.personalMigrations[0],
    oldKey = "uf.public.v1." + migration.personalFrom + "g-main:А";
  await page.evaluate(
    ({ oldKey }) => {
      localStorage.setItem(
        oldKey,
        JSON.stringify([
          {
            id: "quota-personal",
            title: "Не терять при переполнении",
            due: "2026-11-08",
            groupId: "g-main",
          },
        ]),
      );
      localStorage.setItem("qa.storageQuota", "1");
    },
    { oldKey },
  );
  await page.addInitScript(() => {
    Object.defineProperty(window, "indexedDB", {
      configurable: true,
      value: undefined,
    });
    const original = window.Storage.prototype.setItem;
    window.Storage.prototype.setItem = function (key, value) {
      if (
        localStorage.getItem("qa.storageQuota") === "1" &&
        String(key).startsWith("uf.public.v1.")
      )
        throw Error("quota");
      return original.call(this, key, value);
    };
  });
  await page.reload();
  await expect(page.locator("#toast")).toContainText(
    "Браузер ограничил хранилище",
  );
  expect(
    await page.evaluate((key) => localStorage.getItem(key), oldKey),
  ).toContain("quota-personal");
  await page.evaluate(() => localStorage.setItem("qa.storageQuota", "0"));
  await page.reload();
  await page.getByRole("button", { name: "Задания", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Не терять при переполнении",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await page.evaluate((key) => localStorage.getItem(key), oldKey),
  ).toContain("quota-personal");
});
