import { test, expect } from "@playwright/test";
import { mockManager } from "./manager-fixture.mjs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const health = new WeakMap();
test.beforeEach(({ page }) => {
  const issues = [];
  health.set(page, issues);
  page.on("pageerror", (e) => issues.push(e.message));
  page.on("console", (m) => {
    if (["error", "warning"].includes(m.type())) issues.push(m.text());
  });
});
test.afterEach(({ page }) => expect(health.get(page)).toEqual([]));
const unfold = (text) => text.replace(/\r\n[ \t]/g, "");
const count = (text) => (text.match(/BEGIN:VEVENT/g) || []).length;
async function downloadCalendar(page) {
  const waiting = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Календарь .ics", exact: true })
    .click();
  const download = await waiting;
  expect(download.suggestedFilename()).toBe("uniflow.ics");
  return readFile(await download.path(), "utf8");
}

test("management calendar keeps the overnight end after its start and a moved occurrence's original UID", async ({
  page,
}, info) => {
  const manager = await mockManager(page, {
    prepareData(data) {
      data.lessons = [
        {
          ...data.lessons[0],
          id: "overnight",
          day: 4,
          start: "23:30",
          end: "00:20",
          endDayOffset: 1,
        },
      ];
      data.exceptions = [
        {
          lessonId: "overnight",
          date: "2026-11-13",
          targetDate: "2026-11-14",
          status: "moved",
          start: "23:40",
          end: "00:30",
          endDayOffset: 1,
        },
        { lessonId: "overnight", date: "2026-11-20", status: "cancelled" },
      ];
    },
  });
  await manager.login();
  await page.locator('[data-page="schedule"]').click();
  const waiting = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Календарь .ics", exact: true })
    .click();
  const download = await waiting;
  const text = await readFile(await download.path(), "utf8");
  expect(text).toContain("DTSTART:20261106T183000Z\r\nDTEND:20261106T192000Z");
  expect(text).toContain("UID:overnight-2026-11-13@uniflow");
  expect(text).not.toContain("UID:overnight-2026-11-14@uniflow");
  expect(text).toContain("DTSTART:20261114T184000Z\r\nDTEND:20261114T193000Z");
  expect(count(text)).toBe(3);
  expect(text).not.toContain("UID:overnight-2026-11-20");
  for (const event of text.split("BEGIN:VEVENT").slice(1)) {
    const start = event.match(/DTSTART:(\d+T\d+Z)/)[1],
      end = event.match(/DTEND:(\d+T\d+Z)/)[1];
    expect(end > start).toBe(true);
  }
  await expect(page.locator("#toast")).toContainText("28 дней");
  await mkdir(resolve("../../outputs/calendar-next"), { recursive: true });
  await writeFile(
    resolve(`../../outputs/calendar-next/overnight-${info.project.name}.ics`),
    text,
  );
  await page.screenshot({
    path: resolve(
      `../../outputs/calendar-next/export-${info.project.name}.png`,
    ),
  });
  expect(manager.writes()).toEqual([]);
});

test("calendar export follows subgroup, search and teacher filters without changing the model", async ({
  page,
}) => {
  const manager = await mockManager(page, {
    prepareData(data) {
      data.groups.push({
        id: "other-group",
        name: "Другая группа",
        subgroups: ["А", "Б"],
      });
      data.teachers.push({
        id: "teacher-2",
        name: "Второй преподаватель",
        subjects: ["math", "systems"],
      });
      data.lessons.push({
        ...data.lessons[0],
        id: "other-teacher",
        day: 1,
        groupId: "other-group",
        subgroup: "all",
        teacherId: "teacher-2",
        roomId: "",
      });
    },
  });
  await manager.login();
  await page.locator('[data-page="schedule"]').click();
  const before = manager.state();
  let text = await downloadCalendar(page);
  expect(count(text)).toBe(12);
  expect(text).not.toContain("UID:later-b");
  expect(text).not.toContain("UID:other-teacher");
  await page.locator('[data-filter="subgroup"]').last().selectOption("Б");
  text = await downloadCalendar(page);
  expect(count(text)).toBe(8);
  expect(text).not.toContain("UID:now-a");
  expect(text).toContain("UID:later-b");
  await page.locator("#global-search").fill("Операционные системы");
  text = await downloadCalendar(page);
  expect(count(text)).toBe(4);
  expect(text).toContain("UID:next");
  expect(text).not.toContain("UID:later-b");
  await page.locator("#global-search").fill("");
  await page.locator('[data-filter="scope"]').selectOption("teacher");
  await page.locator('[data-filter="teacherId"]').selectOption("teacher-2");
  text = await downloadCalendar(page);
  expect(count(text)).toBe(4);
  expect(text).toContain("UID:other-teacher");
  expect(text).not.toContain("UID:now-a");
  expect(manager.state()).toEqual(before);
  expect(manager.writes()).toEqual([]);
});

test("download folds Unicode text, rejects property injection and excludes private notes and metadata", async ({
  page,
}) => {
  const manager = await mockManager(page, {
    prepareData(data) {
      data.subjects[0].name = "Қ".repeat(25) + "\rATTENDEE:bad\nEND:VEVENT";
      data.rooms[0].name = "Room, 1;2\\3";
      data.rooms[0].note = "PRIVATE_ROOM_NOTE";
      data.lessons[0].futurePrivate = "PRIVATE_SOURCE_METADATA";
    },
  });
  await manager.login();
  await page.locator('[data-page="schedule"]').click();
  const text = await downloadCalendar(page),
    flat = unfold(text);
  expect(count(flat)).toBe(12);
  expect(flat).not.toContain("\r\nATTENDEE:");
  expect(flat).toContain("LOCATION:Room\\, 1\\;2\\\\3");
  for (const line of text.split("\r\n"))
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
  expect(flat).not.toContain("PRIVATE_ROOM_NOTE");
  expect(flat).not.toContain("PRIVATE_SOURCE_METADATA");
  expect(manager.writes()).toEqual([]);
});

test("export includes a saved local draft's night lessons without publishing or rewriting that draft", async ({
  page,
}) => {
  const manager = await mockManager(page);
  await manager.login();
  await page.locator('[data-page="schedule"]').click();
  await page.getByRole("button", { name: "Импорт CSV", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Файл CSV", { exact: true }).setInputFiles({
    name: "night.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "day,start,end,subject,room,teacher,type,subgroup,week,endDayOffset\n1,23:30,00:20,math,204,teacher,Ночная,А,all,1",
    ),
  });
  await dialog
    .getByRole("button", { name: "Предпросмотр CSV", exact: true })
    .click();
  await expect(dialog.locator(".batch-count")).toContainText("Добавить: 1.");
  await dialog
    .getByRole("button", { name: "Добавить в черновик", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator("#draft-save-status")).toHaveText(
    "Черновик сохранён на этом устройстве. Не опубликован.",
  );
  const journal = () =>
    page.evaluate(async () =>
      (await import("/schedule/manage/drafts.mjs"))
        .createDraftJournal()
        .list("11111111-1111-4111-8111-111111111111"),
    );
  const before = await journal();
  const text = await downloadCalendar(page);
  expect(count(text)).toBe(16);
  expect(text).toContain("DTSTART:20261110T183000Z\r\nDTEND:20261110T192000Z");
  expect(await journal()).toEqual(before);
  expect(manager.writes()).toEqual([]);
  expect(manager.state().data.lessons).toHaveLength(4);
});

for (const changed of ["scope", "data"])
  test(`changing ${changed} during lazy loading cannot download a stale calendar`, async ({
    page,
  }) => {
    const manager = await mockManager(page);
    await manager.login();
    await page.locator('[data-page="schedule"]').click();
    let release, observed;
    const gate = new Promise((resolve) => (release = resolve)),
      requested = new Promise((resolve) => (observed = resolve));
    await page.route("**/manage/calendar-export.mjs", async (route) => {
      observed();
      await gate;
      await route.continue();
    });
    const downloads = [];
    page.on("download", (d) => downloads.push(d.suggestedFilename()));
    await page
      .getByRole("button", { name: "Календарь .ics", exact: true })
      .click();
    await requested;
    if (changed === "scope")
      await page.locator('[data-filter="subgroup"]').last().selectOption("Б");
    else {
      manager.advance("lesson.save", {
        ...manager.state().data.lessons[0],
        start: "08:10",
      });
      const refreshed = page.waitForResponse(
        (r) =>
          r.url().endsWith("/uniflow-api") &&
          r.request().postDataJSON().action === "state",
      );
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await refreshed;
      await expect(page.locator("#app")).toContainText("08:10");
    }
    release();
    await expect(page.locator("#toast")).toContainText(
      "Повторите экспорт календаря",
    );
    expect(downloads).toEqual([]);
    const text = await downloadCalendar(page);
    if (changed === "scope") {
      expect(count(text)).toBe(8);
      expect(text).not.toContain("UID:now-a");
    } else expect(text).toContain("DTSTART:20261106T031000Z");
    expect(manager.writes()).toEqual([]);
  });
