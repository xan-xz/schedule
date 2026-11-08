import { el, button } from "../lib/dom.mjs";
import { lessonsForDate, addDays, localDate } from "../lib/time.mjs";
export function render(c) {
  const start = c.page === "today" ? c.selected : c.week;
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const cards = days.map((date) => {
    const lessons = lessonsForDate(c.data, date, c.scope),
      tasks = c.tasks.filter((task) => task.due === date);
    return el(
      "section",
      { class: "layout-day-card" },
      el("h2", {}, c.niceDate(date, true)),
      lessons.length
        ? el(
            "ul",
            { class: "rows" },
            lessons.map((l) => c.lessonRow(l)),
          )
        : el("p", { class: "empty" }, c.t("noLessons")),
      el("h3", {}, c.t("tasks")),
      tasks.length
        ? tasks.map((task) =>
            el(
              "article",
              { class: "layout-card-task" },
              el("strong", {}, task.title),
              el("p", {}, task.description || ""),
              el("small", {}, task.dueTime || "23:59"),
            ),
          )
        : el("p", { class: "muted" }, c.t("noTasksForDay")),
    );
  });
  return [
    el(
      "div",
      { class: "toolbar" },
      button(c.t("previous"), () => c.selectDate(addDays(start, -7))),
      button(c.t("currentWeek"), () => c.selectDate(localDate())),
      button(c.t("following"), () => c.selectDate(addDays(start, 7))),
    ),
    el("div", { class: "layout-cards" }, cards),
  ];
}
