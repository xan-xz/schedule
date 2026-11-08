import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  serializeInertSnapshot,
  renderInitialChoice,
} from "../../scripts/inline-release-snapshot.mjs";
import { mockState } from "./fixtures.mjs";

test.skip(
  process.env.PW_SERVER_ROOT !== "dist",
  "Inert data is a compiled artifact optimization",
);
const release = JSON.parse(
  await readFile(new URL("../../app/bootstrap.json", import.meta.url), "utf8"),
);

test("current choice and legacy group/settings start the application without waiting for animation frames", async ({
  browser,
  page,
  baseURL,
}) => {
  for (const key of ["uf.student.choice.v1", "uf.group", "uf.settings.v1"]) {
    const context = await browser.newContext({ viewport: page.viewportSize() });
    try {
      const returning = await context.newPage();
      await mockState(returning, { savedChoice: false, ticking: true });
      await returning.clock.pauseAt(new Date("2026-11-06T04:00:01Z"));
      await returning.addInitScript((key) => {
        localStorage.setItem(
          key,
          key === "uf.group"
            ? JSON.stringify("g-main")
            : JSON.stringify({
                version: 1,
                groupId: "g-main",
                subgroup: "А",
              }),
        );
        globalThis.PerformanceObserver = class {
          static supportedEntryTypes = ["paint"];
          observe() {
            globalThis.returningPaintWaitStarted = true;
          }
          disconnect() {}
        };
      }, key);
      const request = returning.waitForRequest("**/schedule/app.mjs");
      await returning.goto(baseURL + "/schedule/");
      await request;
      await expect(
        returning
          .locator("form[data-group-choice], #navigation button")
          .first(),
      ).toBeVisible();
      expect(
        await returning.evaluate(() => globalThis.returningPaintWaitStarted),
      ).not.toBe(true);
    } finally {
      await context.close();
    }
  }
});

test("the early chooser searches and preserves selection while the application bundle is delayed", async ({
  page,
}) => {
  await mockState(page, { savedChoice: false, time: null });
  let unblock;
  const gate = new Promise((resolve) => {
    unblock = resolve;
  });
  await page.route("**/schedule/app.mjs", async (route) => {
    await gate;
    await route.continue();
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const bundleRequested = page.waitForRequest("**/schedule/app.mjs");
  try {
    await page.goto("/schedule/", { waitUntil: "commit" });
    const form = page.locator("[data-initial-choice]");
    await expect(form).toHaveAttribute("data-choice-guard", "native");
    await bundleRequested;
    expect(
      await page.evaluate(
        () => performance.getEntriesByName("first-contentful-paint").length,
      ),
    ).toBe(1);
    const search = page.getByRole("searchbox", {
      name: "Найти группу",
      exact: true,
    });
    const group = page.getByRole("combobox", { name: "Группа", exact: true });
    await search.fill("06-057-25-11");
    await group.selectOption("g-main");
    await expect(
      group.locator('option:not([value=""]):not([hidden])'),
    ).toHaveCount(1);
    await page
      .getByRole("combobox", { name: "Подгруппа", exact: true })
      .selectOption("Б");
    await search.focus();
    expect(
      await page.evaluate(() => localStorage.getItem("uf.student.choice.v1")),
    ).toBeNull();
    unblock();
    await expect(page.locator("form[data-group-choice]")).toBeVisible();
    await expect(search).toHaveValue("06-057-25-11");
    await expect(group).toHaveValue("g-main");
    await expect(
      page.getByRole("combobox", { name: "Подгруппа", exact: true }),
    ).toHaveValue("Б");
    await expect(search).toBeFocused();
    await page
      .getByRole("button", {
        name: "Сохранить и открыть расписание",
        exact: true,
      })
      .click();
    await expect(page.locator("#navigation button")).toHaveCount(4);
    expect(
      JSON.parse(
        await page.evaluate(() => localStorage.getItem("uf.student.choice.v1")),
      ),
    ).toMatchObject({ groupId: "g-main", subgroup: "Б" });
    expect(errors).toEqual([]);
  } finally {
    unblock();
  }
});

test("moving a fresh visit to the background while frames are pending starts the application without a frame", async ({
  page,
}) => {
  await mockState(page, { savedChoice: false, ticking: true });
  await page.addInitScript(() => {
    const NativeObserver = globalThis.PerformanceObserver;
    window.PerformanceObserver = class extends NativeObserver {
      observe(options) {
        if (options.type === "paint") {
          document.documentElement.dataset.paintGate = "waiting";
          return;
        }
        super.observe(options);
      }
      disconnect() {
        globalThis.paintObserverDisconnected = true;
        super.disconnect();
      }
    };
  });
  await page.clock.pauseAt(new Date("2026-11-06T04:00:01Z"));
  const bundleRequested = page.waitForRequest("**/schedule/app.mjs");
  await page.goto("/schedule/");
  await expect(page.locator("html")).toHaveAttribute(
    "data-paint-gate",
    "waiting",
  );
  await expect(page.locator("[data-initial-choice]")).toHaveAttribute(
    "data-choice-guard",
    "native",
  );
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await bundleRequested;
  await expect(page.locator("form[data-group-choice]")).toBeVisible();
  expect(await page.evaluate(() => globalThis.paintObserverDisconnected)).toBe(
    true,
  );
});

for (const mode of ["unsupported", "observe throws"])
  test(`Paint Timing ${mode} still loads the application and preserves native choice`, async ({
    page,
  }) => {
    await mockState(page, { savedChoice: false });
    await page.addInitScript((mode) => {
      if (mode === "unsupported")
        Object.defineProperty(
          globalThis.PerformanceObserver,
          "supportedEntryTypes",
          { value: [] },
        );
      else
        globalThis.PerformanceObserver = class {
          static supportedEntryTypes = ["paint"];
          observe() {
            throw Error("Paint observation unavailable");
          }
          disconnect() {}
        };
    }, mode);
    await page.goto("/schedule/");
    await expect(page.locator("form[data-group-choice]")).toBeVisible();
    await page
      .getByRole("combobox", { name: "Группа", exact: true })
      .selectOption("g-main");
    await page
      .getByRole("button", {
        name: "Сохранить и открыть расписание",
        exact: true,
      })
      .click();
    await expect(page.locator("#navigation button")).toHaveCount(4);
  });

test("a failed application bundle gives a visible retry instruction and leaves the chooser usable", async ({
  page,
}) => {
  await mockState(page, { savedChoice: false });
  await page.route("**/schedule/app.mjs", (route) => route.abort());
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/schedule/");
  await expect(page.getByRole("alert")).toHaveText(
    "Не удалось загрузить приложение. Выбери группу и отправь форму, чтобы повторить.",
  );
  await page
    .getByRole("searchbox", { name: "Найти группу", exact: true })
    .fill("06-057-25-11");
  await page
    .getByRole("combobox", { name: "Группа", exact: true })
    .selectOption("g-main");
  await page
    .getByRole("combobox", { name: "Подгруппа", exact: true })
    .selectOption("Б");
  await page
    .getByRole("button", {
      name: "Сохранить и открыть расписание",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/\?g=g-main&subgroup=%D0%91$/);
  expect(
    await page.evaluate(() => localStorage.getItem("uf.student.choice.v1")),
  ).toBeNull();
  expect(errors).toEqual([]);
});

test("the early chooser keeps native navigation available before the application bundle arrives", async ({
  page,
}) => {
  await mockState(page, { savedChoice: false });
  let unblock;
  const gate = new Promise((resolve) => {
    unblock = resolve;
  });
  await page.route("**/schedule/app.mjs", async (route) => {
    await gate;
    await route.abort();
  });
  try {
    await page.goto("/schedule/", { waitUntil: "commit" });
    await expect(page.locator("[data-initial-choice]")).toHaveAttribute(
      "data-choice-guard",
      "native",
    );
    await page
      .getByRole("combobox", { name: "Группа", exact: true })
      .selectOption("g-main");
    await page
      .getByRole("combobox", { name: "Подгруппа", exact: true })
      .selectOption("Б");
    await page
      .getByRole("button", {
        name: "Сохранить и открыть расписание",
        exact: true,
      })
      .click({ noWaitAfter: true });
    await expect(page).toHaveURL(/\?g=g-main&subgroup=%D0%91$/);
    expect(
      await page.evaluate(() => localStorage.getItem("uf.student.choice.v1")),
    ).toBeNull();
  } finally {
    unblock();
  }
});

test("compiled useful chooser is interactive before either snapshot fetch or live API completes", async ({
  page,
}) => {
  await mockState(page, { savedChoice: false });
  let unblock;
  const gate = new Promise((resolve) => {
    unblock = resolve;
  });
  await page.route("**/bootstrap.json", async (route) => {
    await gate;
    await route.fulfill({ json: release });
  });
  await page.route("**/functions/v1/uniflow-api", async (route) => {
    await gate;
    await route.abort();
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto("/schedule/", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Выбери свою группу", exact: true }),
    ).toBeVisible();
    const group = page.getByRole("combobox", { name: "Группа", exact: true });
    await expect(group.locator("option")).toHaveCount(
      release.data.groups.length + 1,
    );
    await group.selectOption("g-main");
    await expect(
      page.getByRole("combobox", { name: "Подгруппа", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Сохранить и открыть расписание",
        exact: true,
      }),
    ).toBeEnabled();
    expect(errors).toEqual([]);
  } finally {
    unblock();
  }
});

test("inert HTML-looking labels remain exact text with strict CSP, no HTML nodes or execution", async ({
  page,
}) => {
  await mockState(page, { savedChoice: false });
  const candidate = structuredClone(release);
  const text =
    '</script><img src=x onerror="globalThis.initialXss=1">&lt;&#x3c;';
  candidate.data.groups.find((group) => group.id === "g-main").name = text;
  await page.route("**/schedule/", async (route) => {
    const response = await route.fetch();
    const html = (await response.text())
      .replace(
        /(<script type="application\/json" id="uniflow-public-snapshot">)[\s\S]*?(<\/script>)/,
        (_all, start, end) => start + serializeInertSnapshot(candidate) + end,
      )
      .replace(
        /(<main\b[^>]*\bid="main"[^>]*>)[\s\S]*?(<\/main>)/,
        (_all, start, end) => start + renderInitialChoice(candidate) + end,
      );
    await route.fulfill({ response, body: html });
  });
  await page.route("**/functions/v1/uniflow-api", (route) => route.abort());
  await page.addInitScript(() => {
    globalThis.initialCsp = [];
    document.addEventListener("securitypolicyviolation", (event) =>
      globalThis.initialCsp.push(event.violatedDirective),
    );
  });
  await page.goto("/schedule/");
  await expect(
    page
      .getByRole("combobox", { name: "Группа", exact: true })
      .locator('option[value="g-main"]'),
  ).toHaveText(text);
  expect(await page.locator("main img, main script").count()).toBe(0);
  expect(await page.evaluate(() => globalThis.initialXss)).toBeUndefined();
  expect(await page.evaluate(() => globalThis.initialCsp)).toEqual([]);
});

test("live catalogue updates preserve focused search, renamed selection and subgroup; removal requires a new explicit choice", async ({
  page,
}) => {
  await mockState(page, { savedChoice: false });
  let unblock;
  const gate = new Promise((resolve) => {
    unblock = resolve;
  });
  let groups = release.data.groups.map((group) => ({
    ...group,
    name: group.id === "g-main" ? "Renamed live group" : group.name,
  }));
  await page.route("**/functions/v1/uniflow-api", async (route) => {
    await gate;
    await route.fulfill({
      json: {
        data: { ...release.data, groups },
        revision: 8,
        user: { role: "guest", subgroup: "А" },
        users: [],
        versions: [],
        capabilities: { allSubgroupTasks: true },
      },
    });
  });
  try {
    await page.goto("/schedule/", { waitUntil: "domcontentloaded" });
    const search = page.getByRole("searchbox", {
      name: "Найти группу",
      exact: true,
    });
    const group = page.getByRole("combobox", { name: "Группа", exact: true });
    await expect(group).toBeVisible();
    await search.fill("06-057-25-11");
    await group.selectOption("g-main");
    await page
      .getByRole("combobox", { name: "Подгруппа", exact: true })
      .selectOption("Б");
    await search.focus();
    unblock();
    await expect(group.locator('option[value="g-main"]')).toHaveText(
      "Renamed live group",
    );
    await expect(group).toHaveValue("g-main");
    await expect(search).toHaveValue("06-057-25-11");
    await expect(search).toBeFocused();
    await expect(
      page.getByRole("combobox", { name: "Подгруппа", exact: true }),
    ).toHaveValue("Б");
    groups = groups.filter((item) => item.id !== "g-main");
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(group).toHaveValue("");
    await expect(
      page.getByRole("button", {
        name: "Сохранить и открыть расписание",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(page.locator("#navigation")).toBeHidden();
    expect(
      await page.evaluate(() => localStorage.getItem("uf.student.choice.v1")),
    ).toBeNull();
  } finally {
    unblock();
  }
});

test("typed native choice and queued confirmation survive settings hydration without losing the heading", async ({
  page,
}) => {
  await mockState(page, { savedChoice: false });
  await page.addInitScript(() => {
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args) => {
      const request = open(...args);
      request.addEventListener(
        "success",
        (event) => {
          event.stopImmediatePropagation();
          globalThis.releaseInitialSettings = () =>
            request.dispatchEvent(new Event("success"));
        },
        { capture: true, once: true },
      );
      return request;
    };
  });
  await page.goto("/schedule/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => typeof globalThis.releaseInitialSettings === "function",
  );
  await page.evaluate(() => {
    globalThis.originalInitialHeading = document.querySelector("main > h1");
  });
  const search = page.getByRole("searchbox", {
    name: "Найти группу",
    exact: true,
  });
  const group = page.getByRole("combobox", { name: "Группа", exact: true });
  await search.fill("06-057-25-11");
  await expect(group).toHaveValue("");
  await group.selectOption("g-main");
  await expect(
    page.getByRole("combobox", { name: "Подгруппа", exact: true }),
  ).toHaveValue("А");
  await page
    .getByRole("combobox", { name: "Подгруппа", exact: true })
    .selectOption("Б");
  await search.focus();
  await page.evaluate(() => globalThis.releaseInitialSettings());
  await expect(page.locator("form[data-group-choice]")).toBeVisible();
  await expect(search).toHaveValue("06-057-25-11");
  await expect(search).toBeFocused();
  await expect(group).toHaveValue("g-main");
  await expect(
    page.getByRole("combobox", { name: "Подгруппа", exact: true }),
  ).toHaveValue("Б");
  expect(
    await page.evaluate(
      () =>
        document.querySelector("main > h1") ===
        globalThis.originalInitialHeading,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => localStorage.getItem("uf.student.choice.v1")),
  ).toBeNull();
});

test("an early native submit queues explicit subgroup confirmation until IDB/settings are ready", async ({
  page,
}) => {
  await mockState(page, { savedChoice: false });
  await page.addInitScript(() => {
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args) => {
      const request = open(...args);
      request.addEventListener(
        "success",
        (event) => {
          event.stopImmediatePropagation();
          globalThis.releaseInitialSettings = () =>
            request.dispatchEvent(new Event("success"));
        },
        { capture: true, once: true },
      );
      return request;
    };
  });
  await page.goto("/schedule/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => typeof globalThis.releaseInitialSettings === "function",
  );
  await page
    .getByRole("combobox", { name: "Группа", exact: true })
    .selectOption("g-main");
  await page
    .getByRole("combobox", { name: "Подгруппа", exact: true })
    .selectOption("Б");
  await page
    .getByRole("button", {
      name: "Сохранить и открыть расписание",
      exact: true,
    })
    .click();
  await expect(page.locator("form[data-initial-choice]")).toHaveAttribute(
    "data-submit-requested",
    "true",
  );
  expect(
    await page.evaluate(() => localStorage.getItem("uf.student.choice.v1")),
  ).toBeNull();
  await page.evaluate(() => globalThis.releaseInitialSettings());
  await expect(page.locator("#identity")).toHaveText("06-057-25-11 · Б");
  await expect(page.locator("#navigation")).toBeVisible();
});

test("without JavaScript the real released form creates an invitation URL, never an implicit preference write", async ({
  browser,
  baseURL,
  page,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: page.viewportSize(),
  });
  try {
    const native = await context.newPage();
    await native.goto(baseURL + "/schedule/");
    await native
      .getByRole("combobox", { name: "Группа", exact: true })
      .selectOption("g-main");
    await native
      .getByRole("combobox", { name: "Подгруппа", exact: true })
      .selectOption("Б");
    await native
      .getByRole("button", {
        name: "Сохранить и открыть расписание",
        exact: true,
      })
      .click();
    const invitation = new URL(native.url());
    expect(invitation.pathname).toBe("/schedule/");
    expect(invitation.searchParams.get("g")).toBe("g-main");
    expect(invitation.searchParams.get("subgroup")).toBe("Б");
  } finally {
    await context.close();
  }
});

test("native callbacks route to the private entry before public snapshot or IDB startup", async ({
  page,
}) => {
  const calls = await mockState(page, { savedChoice: false });
  await page.route("**/bootstrap.json", (route) => route.abort());
  await page.route("**/compatibility.json", (route) => route.abort());
  await page.addInitScript(() => {
    Object.defineProperty(window, "indexedDB", {
      configurable: true,
      get() {
        throw Error("Public IDB must not run on a native callback");
      },
    });
    globalThis.callbackCsp = [];
    document.addEventListener("securitypolicyviolation", (event) =>
      globalThis.callbackCsp.push(event.violatedDirective),
    );
  });
  const proof = ["a".repeat(40), "b".repeat(40), "c".repeat(40)].join(".");
  for (const hash of ["#/admin", "#access_token=" + proof + "&type=invite"]) {
    await page.goto("/schedule/" + hash, { waitUntil: "commit" });
    await expect(page).toHaveURL(/\/schedule\/admin\/$/);
    await expect(
      page.getByRole("heading", { name: "Вход владельца", exact: true }),
    ).toBeVisible();
    expect(await page.locator("body").innerText()).not.toContain(proof);
    expect(
      await page.evaluate(() => JSON.stringify(Object.entries(localStorage))),
    ).not.toContain(proof);
    expect(await page.evaluate(() => globalThis.callbackCsp)).toEqual([]);
  }
  expect(calls.filter((call) => call.action === "state")).toEqual([]);
});
