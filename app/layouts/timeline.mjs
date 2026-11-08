import { el, button } from "../lib/dom.mjs";
import { lessonsForDate, localDate, addDays } from "../lib/time.mjs";
export function render(c) {
  const date = c.selected,
    lessons = lessonsForDate(c.data, date, c.scope),
    now = Date.now();
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
      !lesson.cancelled && lesson.startAt <= now && lesson.endAt > now;
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
