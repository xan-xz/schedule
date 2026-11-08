import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { mockState } from "./fixtures.mjs";
const axePath = createRequire(import.meta.url).resolve("axe-core/axe.min.js");
const scope = { groupId: "g-main", subgroup: "А" };
const compatibility = JSON.parse(
  await readFile(new URL("../../compatibility.json", import.meta.url), "utf8"),
);
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

test("closing during a delayed save still updates the visible task list when persistence completes", async ({
  page,
}) => {
  await mockState(page, { ticking: true });
  await page.goto("/schedule/");
  await open(page);
  const doc = {
    format: "uniflow-personal-tasks-v1",
    scope,
    tasks: [
      {
        id: "delayed-origin",
        title: "Saved after closing",
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
  await page.clock.pauseAt(new Date("2026-11-06T04:00:30Z"));
  await page.evaluate(() => {
    const proto = globalThis.IDBTransaction.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "oncomplete");
    let gateUsed = false;
    const gate = new Promise((resolve) => {
      globalThis.releaseBackupSave = resolve;
    });
    Object.defineProperty(proto, "oncomplete", {
      configurable: true,
      get: descriptor.get,
      set(callback) {
        if (this.mode === "readwrite" && !gateUsed) {
          gateUsed = true;
          descriptor.set.call(this, function (event) {
            globalThis.backupSaveHeld = true;
            void gate.then(() => callback.call(this, event));
          });
        } else descriptor.set.call(this, callback);
      },
    });
    globalThis.restoreBackupTransaction = () =>
      Object.defineProperty(proto, "oncomplete", descriptor);
  });
  try {
    await page
      .getByRole("button", { name: "Восстановить задания", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => globalThis.backupSaveHeld))
      .toBe(true);
    await page.getByRole("button", { name: "Закрыть", exact: true }).click();
    await page.getByRole("button", { name: "Задания", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Saved after closing", exact: true }),
    ).toHaveCount(0);
    await page.evaluate(() => {
      globalThis.restoreBackupTransaction();
      globalThis.releaseBackupSave();
    });
    await expect(
      page.getByRole("heading", { name: "Saved after closing", exact: true }),
    ).toBeVisible();
  } finally {
    await page.evaluate(() => {
      globalThis.restoreBackupTransaction();
      globalThis.releaseBackupSave();
    });
  }
});

test.describe("backup migration ordering", () => {
  test.use({ serviceWorkers: "block" });
  // Gate the manifest request itself; offline worker coverage runs in the other cases.
  test("an open backup waits for newly started legacy migration before both export and restore", async ({
    page,
  }) => {
    await mockState(page);
    let hold = false,
      release,
      arrived,
      gate,
      requested;
    function holdMigration() {
      hold = true;
      gate = new Promise((resolve) => {
        release = resolve;
      });
      requested = new Promise((resolve) => {
        arrived = resolve;
      });
    }
    await page.route("**/compatibility.json", async (route) => {
      if (hold) {
        arrived();
        await gate;
      }
      await route.fulfill({ json: compatibility });
    });
    await page.goto("/schedule/");
    await open(page);
    const from = compatibility.storage.personalMigrations[0].personalFrom;
    async function stageLegacy(ids) {
      await page.evaluate(
        async ({ from, ids }) => {
          const s = await import("./lib/storage.mjs");
          await s.set(
            from + "g-main:А",
            ids.map((id) => ({
              id,
              title: id,
              due: "2026-11-09",
              groupId: "g-main",
            })),
          );
        },
        { from, ids },
      );
      holdMigration();
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await requested;
      await page.evaluate(() => {
        const proto = globalThis.IDBObjectStore.prototype,
          original = proto.get;
        globalThis.backupReadBeforeMigration = false;
        proto.get = function (key) {
          if (key === "personal:live:g-main:А")
            globalThis.backupReadBeforeMigration = true;
          return original.call(this, key);
        };
        globalThis.restoreBackupGet = () => {
          proto.get = original;
        };
      });
    }
    try {
      await stageLegacy(["legacy-one"]);
      const downloading = page.waitForEvent("download");
      void downloading.catch(() => {});
      await page
        .getByRole("button", { name: "Скачать копию", exact: true })
        .click();
      expect(
        await page.evaluate(() => globalThis.backupReadBeforeMigration),
      ).toBe(false);
      await page.evaluate(() => globalThis.restoreBackupGet());
      hold = false;
      release();
      const dl = await downloading;
      const raw = JSON.parse(await readFile(await dl.path(), "utf8"));
      expect(raw.tasks.map((x) => x.title)).toEqual(["legacy-one"]);
      const doc = {
        format: "uniflow-personal-tasks-v1",
        scope,
        tasks: [
          {
            id: "backup-new",
            title: "Backup new",
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
      await stageLegacy(["legacy-one", "legacy-two"]);
      await page
        .getByRole("button", { name: "Восстановить задания", exact: true })
        .click();
      expect(
        await page.evaluate(() => globalThis.backupReadBeforeMigration),
      ).toBe(false);
      await page.evaluate(() => globalThis.restoreBackupGet());
      hold = false;
      release();
      await expect(
        page.getByText("Сохранено.", { exact: false }),
      ).toBeVisible();
      const stored = await page.evaluate(async () =>
        (await import("./lib/storage.mjs")).get("personal:live:g-main:А"),
      );
      expect(stored.map((x) => x.title).sort()).toEqual(
        ["Backup new", "legacy-one", "legacy-two"].sort(),
      );
    } finally {
      hold = false;
      release?.();
      await page.evaluate(() => globalThis.restoreBackupGet?.());
    }
  });
});
