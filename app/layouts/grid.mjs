import { el, button } from "../lib/dom.mjs";
import { lessonsForDate, addDays, localDate } from "../lib/time.mjs";
export function render(c) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(c.week, i));
  const columns = days.map((date) => lessonsForDate(c.data, date, c.scope));
  const slots = [...new Set(columns.flat().map((l) => l.start))].sort();
  const title =
    c.t("week") + " · " + c.niceDate(days[0]) + "–" + c.niceDate(days[6]);
  const table = el(
    "table",
    { class: "layout-grid" },
    el("caption", { class: "sr-only" }, title),
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        el("th", { scope: "col" }, c.t("time")),
        days.map((date) =>
          el(
            "th",
            {
              scope: "col",
              "data-date": date,
              "aria-current": date === localDate() ? "date" : null,
            },
            c.niceDate(date, true),
          ),
        ),
      ),
    ),
    el(
      "tbody",
      {},
      slots.map((slot) =>
        el(
          "tr",
          {},
          el("th", { scope: "row" }, slot),
          columns.map((lessons) =>
            el(
              "td",
              {},
              lessons.filter((l) => l.start === slot).length
                ? el(
                    "ul",
                    { class: "rows" },
                    lessons
                      .filter((l) => l.start === slot)
                      .map((l) => c.lessonRow(l)),
                  )
                : "—",
            ),
          ),
        ),
      ),
    ),
  );
  const scroll = el(
    "div",
    {
      class: "layout-grid-scroll",
      role: "region",
      tabindex: "0",
      "aria-label": c.t("week"),
    },
    table,
  );
  queueMicrotask(() => {
    if (!scroll.isConnected) return;
    const selected = table.querySelector('[data-date="' + c.selected + '"]');
    const time = table.querySelector("th");
    if (selected && time)
      scroll.scrollLeft = Math.max(
        0,
        selected.getBoundingClientRect().left -
          table.getBoundingClientRect().left -
          time.getBoundingClientRect().width,
      );
  });
  return [
    el(
      "div",
      { class: "toolbar" },
      button("←", () => c.selectDate(addDays(c.week, -7)), {
        "aria-label": c.t("previous"),
      }),
      button(c.t("currentWeek"), () => c.selectDate(localDate())),
      button("→", () => c.selectDate(addDays(c.week, 7)), {
        "aria-label": c.t("following"),
      }),
    ),
    el("p", { class: "date-line" }, title),
    slots.length ? scroll : el("p", { class: "empty" }, c.t("noLessons")),
  ];
}
