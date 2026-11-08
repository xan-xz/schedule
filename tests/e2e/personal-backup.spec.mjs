import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { mockState } from "./fixtures.mjs";
const axePath = createRequire(import.meta.url).resolve("axe-core/axe.min.js");
const scope = { groupId: "g-main", subgroup: "А" };
const personal = {
  id: "private-original",
  title: "PRIVATE <script>literal</script>",
  due: "2026-11-09",
  subjectId: "",
  description: "Local only",
  secret: "NEVER_EXPORT",
};
async function open(page, dark = false) {
  await page.getByRole("button", { name: "Ещё", exact: true }).click();
  if (dark)
    await page
      .getByRole("combobox", { name: "Тема", exact: true })
      .selectOption("dark");
  await page
    .getByRole("button", { name: "Копия личных заданий", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
}
const upload = (page, value) =>
  page.getByLabel("Выбрать файл копии").setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      typeof value === "string" ? value : JSON.stringify(value),
    ),
  });
async function seed(page) {
  await page.evaluate(async (task) => {
    const s = await import("./lib/storage.mjs");
    await s.set("personal:live:g-main:А", [task]);
    await s.set("statuses:live:g-main:А", { [task.id]: "done" });
  }, personal);
}
test("personal backup round-trip preserves progress, does not overwrite newer tasks and remains private/offline", async ({
  page,
  context,
}) => {
  const calls = await mockState(page);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/schedule/");
  await seed(page);
  await open(page);
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Скачать копию", exact: true })
    .click();
  const dl = await downloading;
  const raw = await readFile(await dl.path(), "utf8");
  expect(raw).not.toContain("NEVER_EXPORT");
  const saved = JSON.parse(raw);
  expect(saved.tasks).toHaveLength(1);
  expect(saved.tasks[0].status).toBe("done");
  await page.getByRole("button", { name: "Закрыть", exact: true }).click();
  await page.evaluate(async () => {
    const s = await import("./lib/storage.mjs");
    await s.del("personal:live:g-main:А");
  });
  // Keep the old status record deliberately: restored IDs must not reuse it.
  await page.reload();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
    .toBe(true);
  await context.setOffline(true);
  await page.reload();
  await open(page);
  await upload(page, raw);
  await expect(
    page.getByText("Будет добавлено: 1. Уже есть: 0.", { exact: false }),
  ).toBeVisible();
  await page.evaluate(await readFile(axePath, "utf8"));
  expect(
    await page.evaluate(async () =>
      (await globalThis.axe.run(document)).violations.map((x) => x.id),
    ),
  ).toEqual([]);
  await page
    .getByRole("button", { name: "Восстановить задания", exact: true })
    .click();
  await expect(
    page.getByText("Сохранено. Добавлено: 1.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Закрыть", exact: true }).click();
  await page.getByRole("button", { name: "Задания", exact: true }).click();
  const row = page.getByRole("article").filter({ hasText: personal.title });
  await expect(row.getByRole("combobox")).toHaveValue("done");
  await row.getByRole("combobox").selectOption("progress");
  await page.reload();
  await open(page);
  await upload(page, raw);
  await expect(
    page.getByText("Будет добавлено: 0. Уже есть: 1.", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Восстановить задания", exact: true })
    .click();
  await page.getByRole("button", { name: "Закрыть", exact: true }).click();
  await page.getByRole("button", { name: "Задания", exact: true }).click();
  await expect(row).toHaveCount(1);
  await expect(row.getByRole("combobox")).toHaveValue("progress");
  expect(calls.every((x) => x.action === "state")).toBe(true);
  expect(errors).toEqual([]);
});

test("backup rejects wrong scope and corrupt files; paginates preview and retries durable storage after quota failure", async ({
  page,
}) => {
  await mockState(page);
  await page.goto("/schedule/");
  await seed(page);
  await open(page, true);
  const doc = {
    format: "uniflow-personal-tasks-v1",
    scope,
    tasks: Array.from({ length: 42 }, (_, n) => ({
      id: "restore-" + n,
      title: "Restore " + n,
      due: "2026-11-09",
      dueTime: "",
      subjectId: "",
      description: "",
      status: "done",
    })),
  };
  await upload(page, { ...doc, scope: { ...scope, subgroup: "Б" } });
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "другой группе",
  );
  await expect(
    page.getByRole("button", { name: "Восстановить задания", exact: true }),
  ).toBeDisabled();
  await upload(page, "{");
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "формат",
  );
  await upload(page, doc);
  await expect(page.getByRole("dialog").getByRole("listitem")).toHaveCount(40);
  await page
    .getByRole("button", { name: "Следующие задания", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("listitem")).toHaveCount(2);
  await page.evaluate(await readFile(axePath, "utf8"));
  expect(
    await page.evaluate(async () =>
      (await globalThis.axe.run(document)).violations.map((x) => x.id),
    ),
  ).toEqual([]);
  await page.screenshot({
    path: `../../outputs/personal-next/preview-${test.info().project.name}.png`,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => {
    globalThis.backupOriginalTransaction =
      globalThis.IDBDatabase.prototype.transaction;
    globalThis.backupOriginalSet = globalThis.Storage.prototype.setItem;
    globalThis.IDBDatabase.prototype.transaction = () => {
      throw Error("quota fixture");
    };
    globalThis.Storage.prototype.setItem = () => {
      throw Error("quota fixture");
    };
  });
  await page
    .getByRole("button", { name: "Восстановить задания", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).not.toHaveText("");
  await expect(
    page.getByRole("button", { name: "Восстановить задания", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    globalThis.IDBDatabase.prototype.transaction =
      globalThis.backupOriginalTransaction;
    globalThis.Storage.prototype.setItem = globalThis.backupOriginalSet;
  });
  await page
    .getByRole("button", { name: "Восстановить задания", exact: true })
    .click();
  await expect(page.getByText("Сохранено.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Закрыть", exact: true }).click();
  await page.reload();
  const stored = await page.evaluate(async () =>
    (await import("./lib/storage.mjs")).get("personal:live:g-main:А"),
  );
  expect(stored).toHaveLength(43);
  expect(stored.filter((x) => x.id === personal.id)).toHaveLength(1);
});

test("scope changes invalidate an open preview before any personal write", async ({
  page,
}) => {
  await mockState(page);
  await page.goto("/schedule/");
  await seed(page);
  await open(page);
  const doc = {
    format: "uniflow-personal-tasks-v1",
    scope,
    tasks: [
      {
        id: "fresh-origin",
        title: "Wrong scope must stay empty",
        due: "2026-11-09",
        dueTime: "",
        subjectId: "",
        description: "",
        status: "done",
      },
    ],
  };
  await upload(page, doc);
  await expect(
    page.getByText("Будет добавлено: 1.", { exact: false }),
  ).toBeVisible();
  // Emulate a concurrent setting change through the same existing UI handler.
  await page
    .getByRole("combobox", { name: "Подгруппа", exact: true })
    .evaluate((select) => {
      select.value = "Б";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  await page
    .getByRole("button", { name: "Восстановить задания", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "выбор изменился",
  );
  const rows = await page.evaluate(async () => {
    const s = await import("./lib/storage.mjs");
    return [
      await s.get("personal:live:g-main:А", []),
      await s.get("personal:live:g-main:Б", []),
    ];
  });
  expect(rows[0]).toHaveLength(1);
  expect(rows[1]).toEqual([]);
});
