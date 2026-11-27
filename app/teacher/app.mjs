import { generateIcs } from "../lib/calendar.mjs";
import {
  publicState,
  readPreference,
  writePreference,
} from "../lib/client.mjs";
import { download, el } from "../lib/dom.mjs";
import {
  addDays,
  changesForDate,
  lessonsForDate,
  localDate,
  monday,
} from "../lib/time.mjs";
import { projectPublicData } from "../public-data.mjs";

const $ = (id) => document.getElementById(id);
const choice = $("teacher");
const controls = $("teacher-controls");
const schedule = $("teacher-schedule");
const status = $("teacher-status");
const refresh = $("refresh");
const preferenceKey = "uf.teacher.view";
const collator = new Intl.Collator("ru");
const dayFormat = new Intl.DateTimeFormat("ru-RU", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});
const shortFormat = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const atNoon = (date) => new Date(date + "T12:00:00Z");
const shortDate = (date) => shortFormat.format(atNoon(date));
const empty = (message) => el("p", { class: "empty" }, message);
let data = null;
let day = localDate();
let week = false;

const firstDate = () => (week ? monday(day) : day);
const periodDays = () => (week ? 7 : 1);

function lessonRow(lesson, note = "") {
  const label = (kind, id) => data[kind].find((item) => item.id === id)?.name;
  const group = label("groups", lesson.groupId);
  const room = label("rooms", lesson.roomId);
  const details = [
    group,
    lesson.subgroup !== "all" && lesson.subgroup
      ? "Подгруппа " + lesson.subgroup
      : null,
    room ? "Аудитория " + room : "Аудитория уточняется",
    lesson.type,
  ].filter(Boolean);
  return el(
    "li",
    { class: "lesson-row" + (lesson.cancelled ? " cancelled" : "") },
    el(
      "div",
      { class: "lesson-time" },
      el("time", { datetime: lesson.start }, lesson.start),
      el("small", {}, (lesson.endDayOffset ? "до " : "") + lesson.end),
    ),
    el(
      "div",
      { class: "lesson-body" },
      el("h3", {}, label("subjects", lesson.subjectId) || "Занятие"),
      el("p", {}, details.join(" · ")),
      note ? el("p", { class: "change-note" }, note) : null,
    ),
  );
}

function render() {
  const teacherId = choice.value;
  controls.hidden = !teacherId;
  if (!teacherId) {
    schedule.replaceChildren(
      empty(
        data?.teachers.length
          ? "Выберите преподавателя, чтобы открыть расписание."
          : "В опубликованном расписании пока нет преподавателей.",
      ),
    );
    return;
  }

  const first = firstDate();
  const days = periodDays();
  $("day-mode").setAttribute("aria-pressed", String(!week));
  $("week-mode").setAttribute("aria-pressed", String(week));
  $("previous").setAttribute(
    "aria-label",
    week ? "Предыдущая неделя" : "Предыдущий день",
  );
  $("next").setAttribute(
    "aria-label",
    week ? "Следующая неделя" : "Следующий день",
  );
  $("period-label").textContent = week
    ? shortFormat.formatRange(atNoon(first), atNoon(addDays(first, days - 1)))
    : shortDate(first);

  schedule.replaceChildren(
    ...Array.from({ length: days }, (_, offset) => {
      const date = addDays(first, offset);
      const lessons = lessonsForDate(data, date, { teacherId });
      const changes = changesForDate(data, date).filter(
        (change) =>
          change.original.teacherId === teacherId &&
          change.original.date === date &&
          (change.movedAway || change.teacherId !== teacherId),
      );
      const rows = [
        ...lessons.map((lesson) => ({
          lesson,
          note: lesson.cancelled
            ? "Отменено"
            : lesson.sourceDate !== date
              ? "Перенесено с " + shortDate(lesson.sourceDate)
              : lesson.exception
                ? "Расписание занятия изменилось"
                : "",
        })),
        ...changes.map((change) => ({
          lesson: change.original,
          note: change.movedAway
            ? "Перенесено на " + shortDate(change.date) + ", " + change.start
            : "Занятие передано другому преподавателю",
        })),
      ].sort((a, b) => a.lesson.start.localeCompare(b.lesson.start));
      return el(
        "section",
        { class: "teacher-day" },
        el("h2", {}, dayFormat.format(atNoon(date))),
        rows.length
          ? el(
              "ul",
              { class: "rows" },
              rows.map(({ lesson, note }) => lessonRow(lesson, note)),
            )
          : empty("Занятий нет"),
      );
    }),
  );
}

async function load() {
  refresh.disabled = true;
  schedule.setAttribute("aria-busy", "true");
  try {
    const result = await publicState("", "all");
    data = result.data;
    status.textContent = "Показано опубликованное расписание.";
  } catch {
    status.textContent = "Не удалось обновить расписание.";
    if (!data) {
      try {
        const response = await fetch(
          new URL("../bootstrap.json", import.meta.url),
        );
        if (!response.ok) throw Error("Snapshot unavailable");
        data = projectPublicData((await response.json()).data);
        status.textContent = "Показана резервная опубликованная копия.";
      } catch {
        schedule.replaceChildren(
          empty("Расписание недоступно. Попробуйте обновить."),
        );
      }
    }
  } finally {
    if (data) {
      const selected = choice.value || readPreference(preferenceKey, "");
      const teachers = [...data.teachers].sort((a, b) =>
        collator.compare(a.name, b.name),
      );
      choice.replaceChildren(
        el("option", { value: "" }, "Выберите преподавателя"),
        ...teachers.map(({ id, name }) => el("option", { value: id }, name)),
      );
      choice.value = teachers.some(({ id }) => id === selected) ? selected : "";
      choice.disabled = !teachers.length;
      render();
    }
    schedule.setAttribute("aria-busy", "false");
    refresh.disabled = false;
  }
}

choice.addEventListener("change", () => {
  writePreference(preferenceKey, choice.value);
  render();
});
$("day-mode").addEventListener("click", () => {
  week = false;
  render();
});
$("week-mode").addEventListener("click", () => {
  week = true;
  render();
});
$("previous").addEventListener("click", () => {
  day = addDays(day, -periodDays());
  render();
});
$("next").addEventListener("click", () => {
  day = addDays(day, periodDays());
  render();
});
$("today").addEventListener("click", () => {
  day = localDate();
  render();
});
$("calendar").addEventListener("click", () => {
  const teacherId = choice.value;
  if (!teacherId || !data) return;
  download(
    "uniflow-teacher-" + firstDate() + ".ics",
    generateIcs(
      data,
      { teacherId },
      { startDate: firstDate(), days: periodDays() },
    ),
    "text/calendar;charset=utf-8",
  );
});
refresh.addEventListener("click", load);
load();
