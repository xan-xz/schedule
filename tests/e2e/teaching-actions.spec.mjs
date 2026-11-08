import { test, expect } from "@playwright/test";
import { mockManager } from "./manager-fixture.mjs";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";

test("one teaching action bar stays usable at the start middle and end of all fourteen default slots in both themes", async ({
  page,
}, info) => {
  const issues = [];
  page.on("pageerror", (error) => issues.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()))
      issues.push(message.text());
  });
  const manager = await mockManager(page);
  await manager.login();
  const shots = resolve("../../outputs/teaching-next/polish/screenshots");
  await mkdir(shots, { recursive: true });
  const require = createRequire(import.meta.url);
  await page.evaluate(
    await readFile(require.resolve("axe-core/axe.min.js"), "utf8"),
  );
  const open = async () => {
    await page.locator('[data-page="catalogs"]').click();
    await page
      .getByRole("button", { name: "Звонки и типы", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Звонки и типы", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Название типа 4", { exact: true }),
    ).toHaveCount(1);
    await expect(
      page.getByLabel("Начало интервала 14", { exact: true }),
    ).toHaveValue("21:00");
  };
  const actions = page.getByRole("group", {
      name: "Действия настроек",
      exact: true,
    }),
    save = actions.getByRole("button", {
      name: "Сохранить настройки в черновик",
      exact: true,
    }),
    cancel = actions.getByRole("button", { name: "Отмена", exact: true });
  const check = async (theme, stage) => {
    await expect(actions).toHaveCount(1);
    for (const control of [save, cancel]) {
      await expect(control).toBeInViewport({ ratio: 1 });
      expect(
        await control.evaluate((button) => {
          const box = button.getBoundingClientRect();
          return button.contains(
            document.elementFromPoint(
              box.x + box.width / 2,
              box.y + box.height / 2,
            ),
          );
        }),
      ).toBe(true);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: join(shots, `${info.project.name}-${theme}-${stage}.png`),
    });
  };
  for (const theme of ["light", "dark"]) {
    if (theme === "dark") {
      await page.locator('[data-action="profile"]').first().click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Светлая / тёмная тема", exact: true })
        .click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Закрыть", exact: true })
        .click();
      await expect(page.locator("body")).toHaveClass(/dark/);
    }
    await open();
    await check(theme, "initial");
    const label = page.getByLabel("Предлагать тип 1", { exact: true });
    const geometry = await label.evaluate((input) => {
      const text = input
          .closest("label")
          .querySelector("span")
          .getBoundingClientRect(),
        box = input.getBoundingClientRect();
      return {
        textY: text.y + text.height / 2,
        boxY: box.y + box.height / 2,
        textRight: text.right,
        boxLeft: box.left,
      };
    });
    expect(Math.abs(geometry.textY - geometry.boxY)).toBeLessThan(2);
    expect(geometry.boxLeft).toBeGreaterThan(geometry.textRight);
    await page
      .getByLabel("Название типа 1", { exact: true })
      .fill("Проверочный тип");
    await check(theme, "first-type");
    await page.getByLabel("Начало интервала 8", { exact: true }).fill("15:05");
    await check(theme, "middle");
    await page.getByLabel("Начало интервала 14", { exact: true }).fill("21:00");
    await page.getByLabel("Конец интервала 14", { exact: true }).fill("21:55");
    await check(theme, "end");
    expect(
      await page.evaluate(
        async () =>
          (
            await window.axe.run(document.querySelector("#modal"), {
              runOnly: {
                type: "tag",
                values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
              },
            })
          ).violations,
      ),
    ).toEqual([]);
    if (theme === "light") {
      await save.click();
      await expect(page.getByRole("dialog")).not.toBeVisible();
      await expect(page.locator("#draft-save-status")).toHaveText(
        "Черновик сохранён на этом устройстве. Не опубликован.",
      );
    } else {
      await cancel.click();
      await expect(page.getByRole("dialog")).not.toBeVisible();
    }
  }
  expect(manager.writes()).toEqual([]);
  expect(issues).toEqual([]);
});
