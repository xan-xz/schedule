import { el, button } from "../lib/dom.mjs";
import { lessonsForDate, localDate, addDays, timeline } from "../lib/time.mjs";

/** A day lists its own starts plus the shared current overnight occurrence. */
export function timelineDay(data, date, scope, now = new Date()) {
  const lessons = lessonsForDate(data, date, scope);
  const current =
    date === localDate(now) ? timeline(data, scope, now).current : null;
  if (
    current &&
    !lessons.some(
      (lesson) =>
        lesson.id === current.id && lesson.startAt === current.startAt,
    )
  )
    lessons.unshift(current);
  return { lessons, current };
}
export function render(c) {
  const date = c.selected,
    { lessons, current: active } = timelineDay(c.data, date, c.scope);
  const list = el("ol", { class: "timeline-list" });
  let previous;
  for (const lesson of lessons) {
    if (
      previous &&
      !lesson.cancelled &&
      lesson.startAt - previous.endAt >= 15 * 60000
    )
      list.append(
        el(
          "li",
          { class: "gap" },
          c.t("gap", {
            n: Math.round((lesson.startAt - previous.endAt) / 60000),
          }),
        ),
      );
    const current =
      active?.id === lesson.id && active.startAt === lesson.startAt;
    const row = c.lessonRow(lesson);
    if (current) row.setAttribute("aria-current", "time");
    if (current) row.prepend(el("span", { class: "timeline-now" }, c.t("now")));
    list.append(row);
    if (!lesson.cancelled) previous = lesson;
  }
  return [
    el(
      "div",
      { class: "layout-heading" },
      el("h2", {}, c.niceDate(date, true)),
      el(
        "div",
        { class: "toolbar" },
        button(c.t("previousDay"), () => c.selectDate(addDays(date, -1))),
        button(c.t("today"), () => c.selectDate(localDate())),
        button(c.t("followingDay"), () => c.selectDate(addDays(date, 1))),
      ),
    ),
    lessons.length ? list : el("p", { class: "empty" }, c.t("noLessons")),
  ];
}
