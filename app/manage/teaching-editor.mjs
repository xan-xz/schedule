import { el, button, field, select } from "../lib/dom.mjs";
import {
  teachingSettings,
  validateTeachingSettings,
} from "../teaching-settings.mjs";

/** Read only the authored preset subtree; never retain a session or response envelope. */
export function createTeachingEditor({
  data,
  onSave,
  onClose,
  onDirty = () => {},
}) {
  const settings = teachingSettings(data);
  let selected =
    settings.defaultBellScheduleId || settings.bellSchedules[0]?.id || "";
  const root = el("form", { class: "teaching-editor" }),
    error = el("p", { id: "form-error", role: "alert", class: "form-error" }),
    typeList = el("div", { class: "teaching-list" }),
    schemeBody = el("div", { class: "teaching-scheme" });
  const dirty = () => {
    error.textContent = "";
    onDirty();
  };
  const text = (label, value, max, update, type = "text") =>
    field(
      label,
      el("input", {
        type,
        value,
        required: true,
        maxlength: max,
        "aria-label": label,
        oninput: (event) => {
          update(event.target.value);
          dirty();
        },
      }),
    );
  const enabled = (label, value, update) =>
    field(
      label,
      el("input", {
        type: "checkbox",
        checked: value,
        "aria-label": label,
        onchange: (event) => {
          update(event.target.checked);
          dirty();
        },
      }),
    );
  const defaultScheme = select(
    [],
    "",
    (event) => {
      settings.defaultBellScheduleId = event.target.value;
      dirty();
    },
    { "aria-label": "Основная схема звонков" },
  );
  const schemePicker = select(
    [],
    "",
    (event) => {
      selected = event.target.value;
      drawScheme();
    },
    { "aria-label": "Редактировать схему звонков" },
  );
  function schemeOptions() {
    defaultScheme.replaceChildren(
      el("option", { value: "" }, "Без основной схемы"),
      ...settings.bellSchedules
        .filter((scheme) => scheme.enabled)
        .map((scheme) => el("option", { value: scheme.id }, scheme.name)),
    );
    defaultScheme.value = settings.defaultBellScheduleId;
    schemePicker.replaceChildren(
      ...settings.bellSchedules.map((scheme) =>
        el(
          "option",
          { value: scheme.id },
          scheme.name + (scheme.enabled ? "" : " · отключена"),
        ),
      ),
    );
    schemePicker.value = selected;
  }
  function nameFor(rows, prefix) {
    let index = rows.length + 1;
    while (
      rows.some(
        (row) =>
          row.name.toLocaleLowerCase("ru") ===
          (prefix + index).toLocaleLowerCase("ru"),
      )
    )
      index++;
    return prefix + index;
  }
  function move(rows, index, shift, redraw) {
    [rows[index], rows[index + shift]] = [rows[index + shift], rows[index]];
    dirty();
    redraw();
  }
  function rowActions(rows, index, prefix, redraw, min = 0) {
    return el(
      "div",
      { class: "row" },
      button("Выше", () => move(rows, index, -1, redraw), {
        class: "btn tiny",
        "aria-label": `${prefix} ${index + 1} выше`,
        disabled: index === 0,
      }),
      button("Ниже", () => move(rows, index, 1, redraw), {
        class: "btn tiny",
        "aria-label": `${prefix} ${index + 1} ниже`,
        disabled: index === rows.length - 1,
      }),
      button(
        "Убрать",
        () => {
          rows.splice(index, 1);
          dirty();
          redraw();
        },
        {
          class: "btn tiny danger",
          "aria-label": `Убрать ${prefix.toLocaleLowerCase("ru")} ${index + 1}`,
          disabled: rows.length <= min,
        },
      ),
    );
  }
  function drawTypes() {
    typeList.replaceChildren(
      ...settings.lessonTypes.map((item, index) =>
        el(
          "fieldset",
          { class: "teaching-row" },
          el("legend", {}, `Тип ${index + 1}`),
          text(`Название типа ${index + 1}`, item.name, 40, (value) => {
            item.name = value;
          }),
          enabled(`Предлагать тип ${index + 1}`, item.enabled, (value) => {
            item.enabled = value;
          }),
          rowActions(settings.lessonTypes, index, "Тип", drawTypes),
        ),
      ),
    );
    addType.disabled = settings.lessonTypes.length >= 64;
  }
  function drawScheme() {
    schemeOptions();
    addScheme.disabled = settings.bellSchedules.length >= 16;
    const scheme = settings.bellSchedules.find((item) => item.id === selected);
    if (!scheme) {
      schemeBody.replaceChildren(
        el("p", {}, "Схем пока нет. Время занятий можно задавать вручную."),
      );
      return;
    }
    const slots = el("div", { class: "teaching-list" });
    function drawSlots() {
      slots.replaceChildren(
        ...scheme.slots.map((slot, index) =>
          el(
            "fieldset",
            { class: "teaching-row teaching-slot" },
            el("legend", {}, `Интервал ${index + 1}`),
            text(`Название интервала ${index + 1}`, slot.name, 80, (value) => {
              slot.name = value;
            }),
            el(
              "div",
              { class: "teaching-time" },
              text(
                `Начало интервала ${index + 1}`,
                slot.start,
                5,
                (value) => {
                  slot.start = value;
                },
                "time",
              ),
              text(
                `Конец интервала ${index + 1}`,
                slot.end,
                5,
                (value) => {
                  slot.end = value;
                },
                "time",
              ),
              field(
                `Окончание интервала ${index + 1}`,
                select(
                  [
                    ["0", "В тот же день"],
                    ["1", "На следующие сутки"],
                  ],
                  String(slot.endDayOffset),
                  (event) => {
                    slot.endDayOffset = Number(event.target.value);
                    dirty();
                  },
                  { "aria-label": `Окончание интервала ${index + 1}` },
                ),
              ),
            ),
            rowActions(scheme.slots, index, "Интервал", drawSlots, 1),
          ),
        ),
      );
      addSlot.disabled = scheme.slots.length >= 32;
    }
    const addSlot = button(
      "Добавить интервал",
      () => {
        scheme.slots.push({
          id: crypto.randomUUID(),
          name: nameFor(scheme.slots, "Интервал "),
          start: "",
          end: "",
          endDayOffset: 0,
        });
        dirty();
        drawSlots();
        slots.lastElementChild.querySelector("input").focus();
      },
      { class: "btn" },
    );
    schemeBody.replaceChildren(
      text("Название схемы", scheme.name, 80, (value) => {
        scheme.name = value;
        schemeOptions();
      }),
      enabled("Предлагать эту схему", scheme.enabled, (value) => {
        scheme.enabled = value;
        if (!value && settings.defaultBellScheduleId === scheme.id)
          settings.defaultBellScheduleId = "";
        schemeOptions();
      }),
      button(
        "Убрать схему",
        () => {
          settings.bellSchedules = settings.bellSchedules.filter(
            (item) => item.id !== scheme.id,
          );
          if (settings.defaultBellScheduleId === scheme.id)
            settings.defaultBellScheduleId = "";
          selected = settings.bellSchedules[0]?.id || "";
          dirty();
          drawScheme();
        },
        { class: "btn tiny danger" },
      ),
      slots,
      addSlot,
    );
    drawSlots();
  }
  const addType = button(
    "Добавить тип",
    () => {
      settings.lessonTypes.push({
        id: crypto.randomUUID(),
        name: nameFor(settings.lessonTypes, "Тип "),
        enabled: true,
      });
      dirty();
      drawTypes();
      typeList.lastElementChild.querySelector("input").focus();
    },
    { class: "btn" },
  );
  const addScheme = button(
    "Добавить схему",
    () => {
      const scheme = {
        id: crypto.randomUUID(),
        name: nameFor(settings.bellSchedules, "Схема "),
        enabled: true,
        slots: [
          {
            id: crypto.randomUUID(),
            name: "Интервал 1",
            start: "09:00",
            end: "09:50",
            endDayOffset: 0,
          },
        ],
      };
      settings.bellSchedules.push(scheme);
      selected = scheme.id;
      dirty();
      drawScheme();
      schemeBody.querySelector("input").focus();
    },
    { class: "btn" },
  );
  root.append(
    el(
      "p",
      { class: "notice-info" },
      "Эти настройки меняют варианты в формах. Время и строковые типы существующих занятий не пересчитываются и не переименовываются.",
    ),
    el(
      "section",
      {},
      el("h3", {}, "Типы занятий"),
      el(
        "p",
        { class: "small" },
        "Отключение или удаление убирает только подсказку. Сохранённые и импортированные значения остаются допустимыми.",
      ),
      typeList,
      addType,
    ),
    el(
      "section",
      {},
      el("h3", {}, "Схемы звонков"),
      field("Основная схема звонков", defaultScheme),
      field("Редактировать схему звонков", schemePicker),
      schemeBody,
      addScheme,
    ),
    error,
    el(
      "div",
      { class: "row section-space" },
      el(
        "button",
        { class: "btn primary", type: "submit" },
        "Сохранить настройки в черновик",
      ),
      button("Отмена", onClose, { class: "btn" }),
    ),
  );
  root.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await onSave(validateTeachingSettings(settings));
    } catch (problem) {
      error.textContent = problem.message;
      error.scrollIntoView({ block: "nearest" });
    }
  });
  drawTypes();
  drawScheme();
  return root;
}

let stylesheet;
export function loadTeachingEditorStyles() {
  if (stylesheet) return stylesheet;
  stylesheet = new Promise((resolve, reject) => {
    const link = el("link", {
      rel: "stylesheet",
      href: new URL("./teaching-editor.css", import.meta.url).href,
    });
    link.addEventListener("load", resolve, { once: true });
    link.addEventListener(
      "error",
      () => {
        link.remove();
        stylesheet = null;
        reject(
          Error(
            "Не удалось загрузить оформление настроек. Повторите открытие.",
          ),
        );
      },
      { once: true },
    );
    document.head.append(link);
  });
  return stylesheet;
}
