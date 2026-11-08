import { el, button, field, select } from "../lib/dom.mjs";
import {
  PALETTES,
  LAYOUTS,
  appearancePolicy,
  validateAppearancePolicy,
} from "../appearance-policy.mjs";
import { PALETTE_TOKENS } from "../lib/appearance-tokens.mjs";
import { appearanceLabels } from "../lib/personalization.mjs";
import { translator } from "../lib/i18n.mjs";
import { timeline, lessonsForDate, localDate, monday } from "../lib/time.mjs";
const labels = appearanceLabels("ru");
/** Read-only previews receive the already authorized draft model, never a token. */
export function createAppearanceEditor({
  data,
  groupId,
  subgroup,
  onSave,
  onClose,
}) {
  let policy = appearancePolicy(data.siteSettings?.appearance),
    generation = 0,
    previewDate = localDate();
  const root = el("form", { class: "appearance-editor" }),
    error = el("p", { role: "alert", class: "form-error" });
  const preview = el("div", {
    class: "appearance-owner-previews",
    "aria-label": "Предпросмотр интерфейсов на данных выбранной группы",
  });
  const controls = {};
  const options = (ids, text) => ids.map((id, i) => [id, text[i]]);
  for (const [key, title, ids, text] of [
    ["defaultPalette", "Основная палитра", PALETTES, labels.palettes],
    ["defaultLayout", "Основной интерфейс", LAYOUTS, labels.layouts],
    [
      "defaultAppearance",
      "Освещение по умолчанию",
      ["system", "light", "dark"],
      ["Как в системе", "Светлое", "Тёмное"],
    ],
  ]) {
    controls[key] = select(
      options(ids, text),
      policy[key],
      () => void redraw(),
    );
    root.append(field(title, controls[key]));
  }
  for (const [key, title] of [
    ["allowPaletteChoice", "Разрешить студентам менять палитру"],
    ["allowLayoutChoice", "Разрешить студентам менять интерфейс"],
    ["allowCustomAccent", "Разрешить свой акцент с проверкой контраста"],
  ]) {
    controls[key] = el("input", {
      type: "checkbox",
      checked: policy[key],
      onchange: () => void redraw(),
    });
    root.append(field(title, controls[key]));
  }
  for (const [key, title, ids, text] of [
    ["allowedPalettes", "Доступные палитры", PALETTES, labels.palettes],
    ["allowedLayouts", "Доступные интерфейсы", LAYOUTS, labels.layouts],
  ]) {
    controls[key] = ids.map((id) =>
      el("input", {
        type: "checkbox",
        value: id,
        checked: policy[key].includes(id),
        onchange: () => void redraw(),
      }),
    );
    root.append(
      el(
        "fieldset",
        {},
        el("legend", {}, title),
        controls[key].map((input, i) => field(text[i], input)),
      ),
    );
  }
  const previewMode = select(
    [
      ["light", "Светлый предпросмотр"],
      ["dark", "Тёмный предпросмотр"],
    ],
    "light",
    () => void redraw(),
  );
  root.append(
    field("Освещение предпросмотра", previewMode),
    el(
      "p",
      { class: "notice-info" },
      "Предпросмотр использует реальные данные выбранной группы, только чтение. Сохранение меняет черновик; общий сайт изменится после отдельной публикации.",
    ),
    preview,
    error,
    el(
      "div",
      { class: "row section-space" },
      el(
        "button",
        { type: "submit", class: "btn primary" },
        "Сделать основным · сохранить в черновик",
      ),
      button("Закрыть", onClose, { class: "btn" }),
    ),
  );
  function read() {
    return validateAppearancePolicy({
      version: 1,
      ...Object.fromEntries(
        Object.entries(controls).map(([key, control]) => [
          key,
          Array.isArray(control)
            ? control.filter((c) => c.checked).map((c) => c.value)
            : control.type === "checkbox"
              ? control.checked
              : control.value,
        ]),
      ),
    });
  }
  async function redraw() {
    const epoch = ++generation;
    error.textContent = "";
    try {
      policy = read();
      const colors = PALETTE_TOKENS[policy.defaultPalette][previewMode.value];
      const date = previewDate,
        week = monday(date),
        scope = { groupId, subgroup };
      const name = (kind, id) =>
        data[kind]?.find((x) => x.id === id)?.name || "Уточняется";
      const niceDate = (d, long = false) =>
        new Intl.DateTimeFormat("ru-RU", {
          timeZone: "Asia/Almaty",
          day: "numeric",
          month: "short",
          ...(long ? { weekday: "long" } : {}),
        }).format(new Date(d + "T12:00:00+05:00"));
      const lessonRow = (l) =>
        el(
          "li",
          { class: "lesson-row" + (l.cancelled ? " cancelled" : "") },
          el("div", { class: "lesson-time" }, l.start + "–" + l.end),
          el(
            "div",
            { class: "lesson-body" },
            el("h3", {}, name("subjects", l.subjectId)),
            el(
              "p",
              {},
              name("rooms", l.roomId) + " · " + name("teachers", l.teacherId),
            ),
            l.cancelled
              ? el("p", {}, "Отменено")
              : l.exception
                ? el("p", {}, "Изменение · " + (l.exception.note || ""))
                : null,
          ),
        );
      const context = {
        data,
        scope,
        selected: date,
        week,
        niceDate,
        lessonRow,
        tasks: (data.tasks || []).filter(
          (t) =>
            t.groupId === groupId &&
            (subgroup === "all" ||
              t.subgroup === "all" ||
              t.subgroup === subgroup),
        ),
        selectDate: (date) => {
          previewDate = date;
          void redraw();
        },
        t: translator("ru"),
      };
      const results = await Promise.all(
        LAYOUTS.map(async (id, i) => {
          let children;
          if (id === "focus") {
            const line = timeline(data, scope, new Date()),
              current = line.current || line.next;
            children = [
              el(
                "section",
                { class: "hero" },
                el(
                  "p",
                  { class: "eyebrow" },
                  line.current ? "Сейчас" : "Дальше",
                ),
                current
                  ? el("h3", {}, name("subjects", current.subjectId))
                  : el("p", {}, "Занятий нет"),
                current
                  ? el(
                      "p",
                      { class: "room-number" },
                      name("rooms", current.roomId),
                    )
                  : null,
              ),
              el(
                "ul",
                { class: "rows" },
                lessonsForDate(data, date, scope).slice(0, 3).map(lessonRow),
              ),
            ];
          } else {
            const module = await import(
              new URL("../layouts/" + id + ".mjs", import.meta.url).href
            );
            children = module.render(context);
          }
          const panel = el(
            "section",
            { class: "appearance-owner-preview" },
            el("h3", {}, labels.layouts[i]),
            ...children,
          );
          for (const [key, value] of Object.entries(colors))
            panel.style.setProperty("--" + key, value);
          panel.setAttribute("aria-label", labels.layouts[i]);
          return panel;
        }),
      );
      if (epoch !== generation || !root.isConnected) return;
      preview.replaceChildren(...results);
    } catch (e) {
      if (epoch === generation) error.textContent = e.message;
    }
  }
  root.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      onSave(read());
    } catch (e) {
      error.textContent = e.message;
    }
  });
  root.addEventListener("reset", () => {
    generation++;
  });
  queueMicrotask(() => void redraw());
  return root;
}

let stylesheet;
export function loadAppearanceEditorStyles() {
  if (stylesheet) return stylesheet;
  stylesheet = new Promise((resolve, reject) => {
    const link = el("link", {
      rel: "stylesheet",
      href: new URL("./appearance-editor.css", import.meta.url).href,
    });
    link.addEventListener("load", resolve, { once: true });
    link.addEventListener(
      "error",
      () => {
        link.remove();
        stylesheet = null;
        reject(
          Error(
            "Не удалось загрузить оформление предпросмотра. Повтори открытие.",
          ),
        );
      },
      { once: true },
    );
    document.head.append(link);
  });
  return stylesheet;
}
