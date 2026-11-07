import { test, expect } from "@playwright/test";
import { fixture as sharedFixture, mockState } from "./fixtures.mjs";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const initialGroups = [
  { id: "g-main", code: "MAIN", name: "06-057-25-11", subgroups: ["А", "Б"] },
  { id: "g-other", code: "OTHER", name: "06-057-25-18", subgroups: ["А", "Б"] },
];
const studentPath = "/schedule/";
const groupSelect = (page) =>
  page.getByRole("combobox", { name: "Группа", exact: true });
const subgroupSelect = (page) =>
  page.getByRole("combobox", { name: "Подгруппа", exact: true });
const saveChoice = (page) =>
  page.getByRole("button", {
    name: "Сохранить и открыть расписание",
    exact: true,
  });

async function liveGroups(page, { groups = initialGroups } = {}) {
  await mockState(page, { savedChoice: false });
  let current = structuredClone(groups);
  const calls = [];
  const data = () => ({ ...sharedFixture, groups: current });
  await page.route("**/bootstrap.json", (route) =>
    route.fulfill({
      json: {
        data: data(),
        revision: 7,
        source: "release",
        updatedAt: "2026-11-06T04:00:00Z",
      },
    }),
  );
  await page.route("**/functions/v1/uniflow-api", async (route) => {
    const body = route.request().postDataJSON();
    calls.push(body);
    await route.fulfill({
      json: {
        data: data(),
        revision: 7,
        users: [],
        versions: [],
        user: {
          id: "guest",
          role: "guest",
          groupId: body.groupId,
          subgroup: body.subgroup,
        },
        capabilities: { allSubgroupTasks: true },
      },
    });
  });
  return {
    calls,
    setGroups: (groups) => {
      current = structuredClone(groups);
    },
  };
}
async function choose(page, group = "g-main", subgroup = "А") {
  await groupSelect(page).selectOption(group);
  await subgroupSelect(page).selectOption(subgroup);
  await saveChoice(page).click();
  await expect(
    page.getByRole("heading", { name: "Сегодня", exact: true }),
  ).toBeVisible();
}
async function more(page) {
  await page.getByRole("button", { name: "Ещё", exact: true }).click();
}
async function personal(page, title = "Сохранить мою работу") {
  await page.getByRole("button", { name: "Задания", exact: true }).click();
  await page
    .getByRole("button", { name: "+ Личное задание", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Что нужно сделать", { exact: true }).fill(title);
  await dialog.getByLabel("Срок", { exact: true }).fill("2026-11-08");
  await dialog.getByRole("button", { name: "Добавить", exact: true }).click();
  await page
    .getByRole("combobox", { name: title + " · Статус", exact: true })
    .selectOption("progress");
}

test("first visit requires an explicit searched group and subgroup; a return visit opens Today", async ({
  page,
}, testInfo) => {
  const { calls } = await liveGroups(page);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(studentPath);
  await expect(
    page.getByRole("heading", { name: "Выбери свою группу", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("navigation", { name: "Основные разделы" }),
  ).toBeHidden();
  await expect(saveChoice(page)).toBeDisabled();
  await page
    .getByRole("searchbox", { name: "Найти группу", exact: true })
    .fill("06-057-25-18");
  await expect(groupSelect(page)).toHaveValue("");
  await expect(saveChoice(page)).toBeDisabled();
  const axePath = createRequire(import.meta.url).resolve("axe-core/axe.min.js");
  await page.evaluate(await readFile(axePath, "utf8"));
  expect(
    await page.evaluate(async () =>
      (
        await globalThis.axe.run(document, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
        })
      ).violations.map(({ id }) => id),
    ),
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  if (process.env.ONBOARDING_QA_DIR)
    await page.screenshot({
      path: join(
        process.env.ONBOARDING_QA_DIR,
        `first-group-${testInfo.project.name}.png`,
      ),
      fullPage: true,
    });
  await choose(page, "g-other", "Б");
  await expect(page.locator("#identity")).toContainText("06-057-25-18 · Б");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Сегодня", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Выбери свою группу", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("#identity")).toContainText("06-057-25-18 · Б");
  await more(page);
  await subgroupSelect(page).selectOption("all");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Сегодня", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#identity")).toContainText("06-057-25-18 · Обе");
  expect(calls.every((call) => call.action === "state")).toBe(true);
  expect(errors).toEqual([]);
});

test("a legacy saved choice migrates quietly and a renamed group keeps its stable identity", async ({
  page,
}) => {
  const { setGroups } = await liveGroups(page);
  await page.addInitScript(() => {
    localStorage.setItem("uf.group", JSON.stringify("g-other"));
    localStorage.setItem("uf.subgroup", JSON.stringify("Б"));
  });
  await page.goto(studentPath);
  await expect(
    page.getByRole("heading", { name: "Сегодня", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#identity")).toContainText("06-057-25-18 · Б");
  setGroups([
    initialGroups[0],
    { ...initialGroups[1], name: "Новое название группы" },
  ]);
  await page.locator("#refresh").click();
  await expect(page.locator("#identity")).toContainText(
    "Новое название группы · Б",
  );
  await expect(
    page.getByRole("heading", { name: "Выбери свою группу", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("uf.student.choice.v1"))?.groupId,
    ),
  ).toBe("g-other");
});

test("IDB restores group, subgroup and settings when localStorage is denied", async ({
  page,
}) => {
  await liveGroups(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw Error("Storage denied");
      },
    });
  });
  await page.goto(studentPath);
  await choose(page, "g-other", "Б");
  await more(page);
  await page
    .getByRole("combobox", { name: "Тема", exact: true })
    .selectOption("dark");
  await page.waitForFunction(async () => {
    const storage = await import(
      new URL("./lib/storage.mjs", location.href).href
    );
    return (
      (await storage.get("student-settings:live:v1"))?.settings.theme === "dark"
    );
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Сегодня", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#identity")).toContainText("06-057-25-18 · Б");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("denied persistent stores keep the current visit usable and explain that the choice may be lost", async ({
  page,
}) => {
  await liveGroups(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw Error("Storage denied");
      },
    });
    Object.defineProperty(window, "indexedDB", {
      configurable: true,
      value: undefined,
    });
  });
  await page.goto(studentPath);
  await choose(page, "g-other", "Б");
  await expect(page.locator("#toast")).toContainText(
    "Браузер ограничил хранилище",
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Выбери свою группу", exact: true }),
  ).toBeVisible();
});

test("offline onboarding uses the cached catalogue and saves a new choice without a network write", async ({
  page,
  context,
}) => {
  await liveGroups(page);
  await page.goto(studentPath);
  await choose(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    for (const key of [
      "uf.group",
      "uf.subgroup",
      "uf.settings.v1",
      "uf.student.choice.v1",
      "uf.student.settings.v1",
    ])
      localStorage.removeItem(key);
    const storage = await import(
      new URL("./lib/storage.mjs", location.href).href
    );
    await storage.del("student-choice:live:v1");
    await storage.del("student-settings:live:v1");
  });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByText("Выбираешь из сохранённого списка.", { exact: false }),
  ).toBeVisible();
  await choose(page, "g-other", "Б");
  await expect(page.locator("#identity")).toContainText("06-057-25-18 · Б");
  await expect(page.locator("#sync-status")).toContainText("Офлайн");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Сегодня", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#identity")).toContainText("06-057-25-18 · Б");
});

test("code and legacy group invitation links require confirmation before replacing a saved choice", async ({
  page,
}) => {
  await liveGroups(page);
  await page.goto(studentPath);
  await choose(page);
  await page.goto(studentPath + "?g=OTHER&subgroup=Б");
  await expect(
    page.getByRole("heading", {
      name: "Открыть группу из ссылки?",
      exact: true,
    }),
  ).toBeVisible();
  await expect(groupSelect(page)).toHaveValue("g-other");
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("uf.student.choice.v1"))?.groupId,
    ),
  ).toBe("g-main");
  await page
    .getByRole("button", { name: "Оставить текущую группу", exact: true })
    .click();
  await expect(page.locator("#identity")).toContainText("06-057-25-11 · А");
  await page.goto(studentPath + "?group=g-other&subgroup=Б");
  await expect(
    page.getByRole("heading", {
      name: "Открыть группу из ссылки?",
      exact: true,
    }),
  ).toBeVisible();
  await saveChoice(page).click();
  await expect(page.locator("#identity")).toContainText("06-057-25-18 · Б");
  await expect(page).toHaveURL(/\/schedule\/$/);
  await page.goto(studentPath + "?g=unknown-group");
  await expect(
    page.getByText("Группа по ссылке не найдена. Выбери группу из списка.", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Оставить текущую группу", exact: true })
    .click();
  await expect(page.locator("#identity")).toContainText("06-057-25-18 · Б");
});

test("changing group and subgroup preserves personal tasks, progress and unrelated settings", async ({
  page,
}) => {
  await liveGroups(page);
  await page.goto(studentPath);
  await choose(page);
  await personal(page);
  await more(page);
  await page
    .getByRole("combobox", { name: "Тема", exact: true })
    .selectOption("dark");
  await groupSelect(page).selectOption("g-other");
  await page.getByRole("button", { name: "Задания", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Сохранить мою работу", exact: true }),
  ).toHaveCount(0);
  await more(page);
  await groupSelect(page).selectOption("g-main");
  await subgroupSelect(page).selectOption("Б");
  await page.getByRole("button", { name: "Задания", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Сохранить мою работу", exact: true }),
  ).toHaveCount(0);
  await more(page);
  await subgroupSelect(page).selectOption("А");
  await page.getByRole("button", { name: "Задания", exact: true }).click();
  await expect(
    page.getByRole("combobox", {
      name: "Сохранить мою работу · Статус",
      exact: true,
    }),
  ).toHaveValue("progress");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("deleted and archived groups require a safe choice and retain the old group's personal data", async ({
  page,
}) => {
  const { setGroups } = await liveGroups(page);
  await page.goto(studentPath);
  await choose(page);
  await personal(page);
  setGroups([initialGroups[1]]);
  await page.locator("#refresh").click();
  await expect(
    page.getByText("Сохранённая группа больше недоступна.", { exact: false }),
  ).toBeVisible();
  await expect(groupSelect(page).locator('option[value="g-main"]')).toHaveCount(
    0,
  );
  await choose(page, "g-other");
  setGroups([
    { ...initialGroups[0], archivedAt: "2026-11-07T00:00:00Z" },
    { ...initialGroups[1], archived: true },
  ]);
  await page.locator("#refresh").click();
  await expect(saveChoice(page)).toBeDisabled();
  await expect(
    page.getByText("Группа не найдена.", { exact: true }),
  ).toBeVisible();
  setGroups(initialGroups);
  await page
    .getByRole("button", { name: "Обновить", exact: true })
    .last()
    .click();
  await expect(
    page.getByRole("heading", { name: "Сегодня", exact: true }),
  ).toBeVisible();
  await more(page);
  await groupSelect(page).selectOption("g-main");
  await page.getByRole("button", { name: "Задания", exact: true }).click();
  await expect(
    page.getByRole("combobox", {
      name: "Сохранить мою работу · Статус",
      exact: true,
    }),
  ).toHaveValue("progress");
});

test("a removed subgroup needs confirmation without silently changing the saved scope", async ({
  page,
}) => {
  const { setGroups } = await liveGroups(page);
  await page.goto(studentPath);
  await choose(page, "g-main", "Б");
  setGroups([{ ...initialGroups[0], subgroups: ["А"] }, initialGroups[1]]);
  await page.locator("#refresh").click();
  await expect(
    page.getByText("Подгруппы изменились. Подтверди свой выбор.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("uf.student.choice.v1"))?.subgroup,
    ),
  ).toBe("Б");
  await expect(subgroupSelect(page).locator('option[value="Б"]')).toHaveCount(
    0,
  );
  await saveChoice(page).click();
  await expect(page.locator("#identity")).toContainText("06-057-25-11 · А");
});

test("searching for a single group never changes the selection until it is explicitly chosen", async ({
  page,
}) => {
  const { calls } = await liveGroups(page);
  await page.addInitScript(() =>
    localStorage.setItem("uf.group", JSON.stringify("g-main")),
  );
  await page.goto(studentPath);
  await page.getByRole("button", { name: "Ещё", exact: true }).click();
  const identity = page.locator("#identity"),
    group = page.getByRole("combobox", { name: "Группа", exact: true });
  await page
    .getByRole("searchbox", { name: "Найти группу", exact: true })
    .fill("06-057-25-18");
  await expect(group).toHaveValue("");
  await expect(identity).toContainText("06-057-25-11");
  await group.selectOption("g-other");
  await expect(identity).toContainText("06-057-25-18");
  await page.reload();
  await expect(identity).toContainText("06-057-25-18");
  await page.getByRole("button", { name: "Ещё", exact: true }).click();
  await page
    .getByRole("searchbox", { name: "Найти группу", exact: true })
    .fill("несуществующая группа");
  await expect(group).toHaveValue("");
  await expect(identity).toContainText("06-057-25-18");
  expect(calls.every((call) => call.action === "state")).toBe(true);
});
