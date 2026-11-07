import { test, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mockState } from "./fixtures.mjs";

test.describe("compiled inline student entry", () => {
  test.skip(
    process.env.PW_SERVER_ROOT !== "dist",
    "Requires the built artifact; the source development entry stays modular.",
  );

  test("the strict CSP authorizes exact inline bytes and no external critical modules", async ({
    page,
  }) => {
    const runtimeErrors = [];
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    await page.addInitScript(() => {
      globalThis.compiledCspViolations = [];
      document.addEventListener("securitypolicyviolation", (event) => {
        globalThis.compiledCspViolations.push({
          directive: event.effectiveDirective,
          blocked: event.blockedURI,
        });
      });
    });
    await mockState(page);
    await page.goto("/schedule/beta/");
    await expect(
      page.getByRole("heading", { name: "Алгоритмы", exact: true }).first(),
    ).toBeVisible();
    await expect(page.locator(".room-number")).toHaveText("204");
    await expect(
      page.getByRole("heading", {
        name: "Операционные системы",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator("script[type=module][src]")).toHaveCount(0);
    await expect(page.locator('link[rel="stylesheet"]')).toHaveCount(0);
    await expect(page.locator('link[rel="modulepreload"]')).toHaveCount(0);

    const policy = await page.evaluate(async () => {
      const csp = document.querySelector(
        'meta[http-equiv="Content-Security-Policy"]',
      ).content;
      const hash = async (text) => {
        const bytes = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(text),
        );
        return (
          "'sha256-" + btoa(String.fromCharCode(...new Uint8Array(bytes))) + "'"
        );
      };
      const entry = document.querySelector('script[type="module"]');
      const style = document.querySelector("style");
      return {
        csp,
        scriptHash: await hash(entry.textContent),
        styleHash: await hash(style.textContent),
        background: window.getComputedStyle(document.documentElement)
          .backgroundColor,
        violations: globalThis.compiledCspViolations,
        width: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        title: document.title,
      };
    });
    expect(policy.csp).toContain(policy.scriptHash);
    expect(policy.csp).toContain(policy.styleHash);
    expect(policy.csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(policy.csp).toContain("object-src 'none'");
    expect(policy.background).toBe("rgb(245, 244, 250)");
    expect(policy.scrollWidth).toBeLessThanOrEqual(policy.width);
    expect(policy.title).toContain("UniFlow");
    expect(policy.violations).toEqual([]);
    expect(runtimeErrors).toEqual([]);
    if (!process.env.CI && page.viewportSize().width === 390) {
      const screenshot = fileURLToPath(
        new URL(
          "../../../../outputs/screenshots/followup-compiled-390.png",
          import.meta.url,
        ),
      );
      await mkdir(dirname(screenshot), { recursive: true });
      await page.screenshot({ path: screenshot });
    }
  });

  test("bundled calendar export remains a real scoped ICS download", async ({
    page,
  }) => {
    const requests = await mockState(page);
    await page.goto("/schedule/beta/");
    await expect(page.locator(".room-number")).toHaveText("204");
    await page.getByRole("button", { name: "Ещё", exact: true }).click();
    const calendar = page.locator(".settings-section").filter({
      has: page.getByRole("heading", {
        name: "Экспорт календаря",
        exact: true,
      }),
    });
    const downloaded = page.waitForEvent("download");
    await calendar.getByRole("button", { name: "Неделя", exact: true }).click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe("uniflow-week.ics");
    const contents = await readFile(await download.path(), "utf8");
    expect(contents).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(contents).toContain("SUMMARY:Алгоритмы\r\n");
    expect(contents).toContain("LOCATION:204\r\n");
    expect(contents).toContain("DTSTART:20261106T030000Z\r\n");
    expect(contents).not.toMatch(/ATTENDEE|password|apikey|token/i);
    expect(contents).toMatch(/END:VCALENDAR\r\n$/);
    expect(requests.every((request) => request.action === "state")).toBe(true);
  });

  test("a short Saturday keeps the synchronization footer outside the first viewport", async ({
    page,
  }) => {
    // The first Lighthouse run found a shift on Saturday, not on the longer
    // Friday fixture. Read the real public bootstrap, with no production POST.
    await page.clock.setFixedTime(new Date("2026-11-07T04:00:00Z"));
    await page.goto("/schedule/beta/?demo=student");
    await expect(page.locator(".hero")).toBeVisible();
    await expect(page.locator("#navigation button")).toHaveCount(4);
    await expect(page.locator("#identity")).toContainText("Демо");
    const position = await page.locator(".statusbar").boundingBox();
    expect(position.y).toBeGreaterThanOrEqual(page.viewportSize().height);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });

  test("the compiled shell and literal personal task survive a genuinely offline reload", async ({
    page,
    context,
  }) => {
    const runtimeErrors = [];
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    const requests = await mockState(page);
    await page.goto("/schedule/beta/");
    await expect(page.locator(".room-number")).toHaveText("204");
    await page.getByRole("button", { name: "Задания", exact: true }).click();
    await page
      .getByRole("button", { name: "+ Личное задание", exact: true })
      .click();
    const text = '<img src=x onerror="globalThis.compiledXss=true">';
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Что нужно сделать", { exact: true }).fill(text);
    await dialog.getByRole("button", { name: "Добавить", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: text, exact: true }),
    ).toBeVisible();
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.waitForFunction(
      () => navigator.serviceWorker.controller !== null,
    );
    // A route.fulfill can otherwise make a mocked API appear available offline.
    await page.unroute("https://anfwdrcazwbkkayczkxg.supabase.co/**");
    await context.setOffline(true);
    try {
      await page.reload();
      await expect(page.locator(".room-number")).toHaveText("204");
      await expect(page.getByText(/Офлайн/).first()).toBeVisible();
      await page.getByRole("button", { name: "Задания", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: text, exact: true }),
      ).toBeVisible();
      await expect(page.locator("main img")).toHaveCount(0);
      expect(await page.evaluate(() => globalThis.compiledXss)).toBeUndefined();
      expect(runtimeErrors).toEqual([]);
      expect(requests.every((request) => request.action === "state")).toBe(
        true,
      );
    } finally {
      await context.setOffline(false);
    }
  });
});
