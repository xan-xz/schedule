import { test, expect } from "@playwright/test";
import { join } from "node:path";
import { fixture } from "./fixtures.mjs";

const mainTeacher = "А. Преподаватель";
const otherTeacher = "Б. Преподаватель";

test("public teacher view shows only the selected teacher and dated changes", async ({
  page,
}, info) => {
  const data = structuredClone(fixture);
  data.teachers.push({
    id: "other",
    name: otherTeacher,
    subjects: ["math", "systems"],
  });
  data.subjects.push({ id: "statistics", name: "Статистика" });
  data.lessons[2].teacherId = "other";
  data.lessons[2].subjectId = "statistics";
  data.exceptions = [
    {
      lessonId: "now-a",
      date: "2026-11-27",
      targetDate: "2026-11-28",
      status: "moved",
      start: "09:00",
      end: "10:50",
    },
    { lessonId: "next", date: "2026-11-27", status: "cancelled" },
  ];
  const calls = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.setFixedTime(new Date("2026-11-27T12:00:00+05:00"));
  await page.route("**/functions/v1/uniflow-api", async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
        },
      });
      return;
    }
    calls.push(request.postDataJSON());
    await route.fulfill({
      json: {
        data,
        revision: 12,
        user: { role: "guest", groupId: "g-main", subgroup: "all" },
        capabilities: { allSubgroupTasks: true },
      },
    });
  });

  await page.goto("/schedule/");
  await page.getByRole("link", { name: "Расписание преподавателя" }).click();
  await expect(page).toHaveURL(/\/schedule\/teacher\/$/);
  await expect(page).toHaveTitle("Расписание преподавателя — UniFlow");
  const picker = page.getByRole("combobox", { name: "Преподаватель" });
  const day = page.getByRole("button", { name: "День", exact: true });
  const week = page.getByRole("button", { name: "Неделя", exact: true });
  const schedule = page.locator("#teacher-schedule");
  await expect(picker).toBeEnabled();
  await expect(schedule).toContainText("Выберите преподавателя");
  await expect(day).toBeHidden();
  await picker.selectOption({ label: mainTeacher });
  await expect(day).toHaveAttribute("aria-pressed", "true");
  await expect(schedule).toContainText("Перенесено на 28 нояб.");
  await expect(schedule).toContainText("Отменено");
  await expect(schedule).not.toContainText("Статистика");
  await expect(schedule).toContainText("Аудитория 204");
  await expect(schedule).toContainText("06-057-25-11");
  if (process.env.QA_EVIDENCE_DIR)
    await page.screenshot({
      path: join(
        process.env.QA_EVIDENCE_DIR,
        `teacher-${info.project.name}.png`,
      ),
    });

  await page.getByRole("button", { name: "Следующий день" }).click();
  await expect(schedule).toContainText("суббота, 28 ноября");
  await expect(schedule).toContainText("Перенесено с 27 нояб.");
  await expect(schedule).toContainText("09:00");
  await expect(schedule).not.toContainText("Отменено");

  await week.click();
  await expect(week).toHaveAttribute("aria-pressed", "true");
  await expect(schedule.getByRole("heading", { level: 2 })).toHaveCount(7);
  await expect(schedule).toContainText("Перенесено с 27 нояб.");
  await expect(schedule).toContainText("Перенесено на 28 нояб.");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Скачать календарь (.ics)" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("uniflow-teacher-2026-11-23.ics");
  await page.getByRole("button", { name: "Следующая неделя" }).click();
  await expect(schedule).not.toContainText("Перенесено с");
  await page.getByRole("button", { name: "К сегодня" }).click();
  await picker.selectOption({ label: otherTeacher });
  await expect(schedule).toContainText("Статистика");
  await expect(schedule).not.toContainText("Алгоритмы");
  await expect(schedule).not.toContainText("Перенесено");
  await expect(page.getByText("Опубликовать", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(picker).toHaveValue("other");
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every(({ action, token }) => action === "state" && !token)).toBe(
    true,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("teacher view labels the released fallback when live published data is unavailable", async ({
  page,
}) => {
  await page.route("**/functions/v1/uniflow-api", (route) =>
    route.fulfill({ status: 503, json: { error: "Unavailable" } }),
  );
  await page.goto("/schedule/teacher/");
  await expect(page.getByRole("status")).toHaveText(
    "Показана резервная опубликованная копия.",
  );
  await expect(
    page.getByRole("combobox", { name: "Преподаватель" }),
  ).toBeEnabled();
});
