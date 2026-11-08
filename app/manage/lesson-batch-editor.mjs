import { el, button, field, select } from "../lib/dom.mjs";
import { DAYS, isGroupActive } from "../core.mjs";

const PAGE = 40,
  LIMIT = 1000;
const weekName = (value) =>
  ({ all: "Каждую неделю", odd: "Нечётная", even: "Чётная" })[value] || value;
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
/** An in-memory guard only: this raw source comparison never enters local storage. */
export function selectedLessonFingerprint(data, ids) {
  const byId = new Map(data.lessons.map((row) => [row.id, row]));
  return JSON.stringify(
    [...ids].sort().map((id) => [id, canonical(byId.get(id) ?? null)]),
  );
}

export function createLessonBatchEditor({
  data,
  groupId,
  onPreview,
  onApply,
  onClose,
  onInvalidate = () => {},
  onDirty = () => {},
}) {
  const groups = data.groups.filter(isGroupActive),
    groupIds = new Set(groups.map((group) => group.id)),
    filters = {
      groupId: groupIds.has(groupId) ? groupId : "",
      day: "",
      week: "",
      subjectId: "",
      teacherId: "",
      roomId: "",
      type: "",
    };
  let selected = new Set(),
    page = 0,
    previewPage = 0,
    change = { kind: "roomId" },
    plan = null,
    pending = false,
    generation = 0;
  const root = el("form", { class: "lesson-batch-editor" }),
    error = el("p", { id: "form-error", role: "alert", class: "form-error" }),
    status = el("p", { role: "status", class: "small" }),
    count = el("p", { role: "status", class: "batch-count" }),
    list = el("div", {
      class: "batch-list",
      role: "group",
      "aria-label": "Найденные занятия",
    }),
    pager = el("div", {
      class: "row",
      role: "group",
      "aria-label": "Страницы найденных занятий",
    }),
    patch = el("div", { class: "batch-patch" }),
    review = el("section", {
      class: "batch-preview",
      "aria-label": "Предпросмотр массовой правки",
    });
  const name = (kind, id) =>
    !id
      ? "Не назначено"
      : data[kind].find((row) => row.id === id)?.name || "Запись недоступна";
  const describe = (row) =>
    `${row.start}–${row.end}${row.endDayOffset ? " (+1 день)" : ""} · ${name("subjects", row.subjectId)} · ${name("teachers", row.teacherId)} · ${name("rooms", row.roomId)} · ${row.type || "Тип не указан"}`;
  const context = (row) =>
    `${name("groups", row.groupId)} · ${row.subgroup === "all" ? "Все подгруппы" : row.subgroup} · ${DAYS[row.day]} · ${weekName(row.week)}`;
  const filtered = () =>
    data.lessons.filter(
      (row) =>
        groupIds.has(row.groupId) &&
        Object.entries(filters).every(
          ([key, value]) => !value || String(row[key] ?? "") === value,
        ),
    );
  function invalidate() {
    generation++;
    plan = null;
    previewPage = 0;
    review.replaceChildren();
    error.textContent = "";
    status.textContent = "Выбор или правка изменились. Требуется предпросмотр.";
    onInvalidate();
    onDirty();
    updateActions();
  }
  function updateActions() {
    previewButton.disabled = pending || !selected.size;
    applyButton.disabled = pending || !plan?.result.valid;
    count.textContent = `Выбрано: ${selected.size}. Предел одной правки: ${LIMIT}.`;
  }
  function pagination(target, current, total, setPage) {
    const pages = Math.max(1, Math.ceil(total / PAGE));
    target.replaceChildren(
      button("Назад", () => setPage(current - 1), {
        class: "btn tiny",
        disabled: current === 0,
      }),
      el("span", { class: "small" }, `Страница ${current + 1} из ${pages}`),
      button("Далее", () => setPage(current + 1), {
        class: "btn tiny",
        disabled: current + 1 >= pages,
      }),
    );
  }
  function drawList() {
    const rows = filtered();
    page = Math.min(page, Math.max(0, Math.ceil(rows.length / PAGE) - 1));
    all.textContent = `Выбрать все найденные (${rows.length})`;
    list.replaceChildren(
      ...rows.slice(page * PAGE, (page + 1) * PAGE).map((row, index) =>
        el(
          "label",
          { class: "batch-lesson", "data-batch-row": row.id },
          el("input", {
            type: "checkbox",
            checked: selected.has(row.id),
            "aria-label": `Выбрать занятие ${page * PAGE + index + 1}`,
            onchange: (event) => {
              if (event.target.checked && selected.size >= LIMIT) {
                event.target.checked = false;
                error.textContent = `Можно выбрать не более ${LIMIT} занятий.`;
                return;
              }
              event.target.checked
                ? selected.add(row.id)
                : selected.delete(row.id);
              invalidate();
            },
          }),
          el(
            "span",
            {},
            el("strong", {}, describe(row)),
            el("span", { class: "small" }, context(row)),
          ),
        ),
      ),
    );
    if (!rows.length) list.append(el("p", {}, "По этому фильтру занятий нет."));
    pagination(pager, page, rows.length, (value) => {
      page = value;
      drawList();
    });
    updateActions();
  }
  const all = button(
    "Выбрать все найденные",
    () => {
      const rows = filtered();
      invalidate();
      if (rows.length > LIMIT) {
        error.textContent = `Найдено ${rows.length} занятий. Предел — ${LIMIT}. Сузьте фильтр или выберите строки вручную; выбор не обрезан.`;
        return;
      }
      selected = new Set(rows.map((row) => row.id));
      drawList();
    },
    { class: "btn" },
  );
  const clear = button(
    "Очистить выбор",
    () => {
      selected.clear();
      invalidate();
      drawList();
    },
    { class: "btn" },
  );
  const filterBox = el(
    "fieldset",
    { class: "batch-filters" },
    el("legend", {}, "Найти занятия"),
  );
  const types = [
    ...new Set(
      data.lessons
        .map((row) => row.type)
        .filter((value) => typeof value === "string" && value),
    ),
  ];
  for (const [key, label, options] of [
    [
      "groupId",
      "Группа для массовой правки",
      groups.map((row) => [row.id, row.name]),
    ],
    ["day", "День недели", DAYS.map((label, index) => [String(index), label])],
    [
      "week",
      "Чётность",
      ["all", "odd", "even"].map((value) => [value, weekName(value)]),
    ],
    ...[
      ["subjectId", "Предмет", "subjects"],
      ["teacherId", "Преподаватель", "teachers"],
      ["roomId", "Аудитория", "rooms"],
    ].map(([key, label, kind]) => [
      key,
      label,
      data[kind].map((row) => [row.id, row.name]),
    ]),
    ["type", "Тип занятия", types.map((value) => [value, value])],
  ])
    filterBox.append(
      field(
        label,
        select(
          [
            ["", key === "groupId" ? "Все активные группы" : "Любое значение"],
            ...options,
          ],
          filters[key],
          (event) => {
            filters[key] = event.target.value;
            selected.clear();
            page = 0;
            invalidate();
            drawList();
            status.textContent =
              "Фильтр изменён. Выбор и предпросмотр сброшены.";
          },
          { "aria-label": label },
        ),
      ),
    );
  function input(label, type, value, update, attrs = {}) {
    return field(
      label,
      el("input", {
        type,
        value,
        required: true,
        "aria-label": label,
        ...attrs,
        oninput: (event) => {
          update(event.target.value);
          invalidate();
        },
      }),
    );
  }
  function drawPatch() {
    const kind = change.kind;
    if (["roomId", "teacherId", "subjectId"].includes(kind)) {
      const collection = {
          roomId: "rooms",
          teacherId: "teachers",
          subjectId: "subjects",
        }[kind],
        options = [
          ["", "Выберите новое значение"],
          ...(kind !== "subjectId"
            ? [[JSON.stringify(""), "Снять назначение"]]
            : []),
          ...data[collection].map((row) => [JSON.stringify(row.id), row.name]),
        ];
      patch.replaceChildren(
        field(
          "Новое значение",
          select(
            options,
            "",
            (event) => {
              change.value = event.target.value
                ? JSON.parse(event.target.value)
                : undefined;
              invalidate();
            },
            { required: true, "aria-label": "Новое значение" },
          ),
        ),
      );
      if (!data[collection].length)
        patch.append(
          el(
            "p",
            { class: "small" },
            kind === "subjectId"
              ? "Предметов нет. Выберите другую правку."
              : "Справочник пуст. Можно только снять назначение.",
          ),
        );
    } else if (kind === "type")
      patch.replaceChildren(
        input(
          "Новый тип занятия",
          "text",
          "",
          (value) => {
            change.value = value;
          },
          { maxlength: 40 },
        ),
      );
    else if (kind === "setTime") {
      change = { kind, start: "", end: "", endDayOffset: 0 };
      patch.replaceChildren(
        input("Новое начало", "time", "", (value) => {
          change.start = value;
        }),
        input("Новый конец", "time", "", (value) => {
          change.end = value;
        }),
        field(
          "Окончание",
          select(
            [
              ["0", "В тот же день"],
              ["1", "На следующие сутки"],
            ],
            "0",
            (event) => {
              change.endDayOffset = Number(event.target.value);
              invalidate();
            },
            { "aria-label": "Окончание" },
          ),
        ),
      );
    } else
      patch.replaceChildren(
        input(
          "Сдвиг в минутах",
          "number",
          "",
          (value) => {
            change.minutes = Number(value);
          },
          { min: -1439, max: 1439, step: 1 },
        ),
        el(
          "p",
          { class: "small" },
          "Начало останется в исходном дне, длительность сохранится. Для смены дня откройте отдельное занятие; массовый сдвиг не переносит начало на другую дату.",
        ),
      );
  }
  function drawPreview() {
    const result = plan?.result;
    if (!result) return;
    const dayCounts = new Map(),
      weekCounts = new Map();
    for (const item of result.changes) {
      dayCounts.set(item.after.day, (dayCounts.get(item.after.day) || 0) + 1);
      weekCounts.set(
        item.after.week,
        (weekCounts.get(item.after.week) || 0) + 1,
      );
    }
    const rows = el("div", { class: "batch-list" }),
      controls = el("div", {
        class: "row",
        role: "group",
        "aria-label": "Страницы предпросмотра",
      });
    review.replaceChildren(
      el("h3", {}, "Предпросмотр изменений"),
      el(
        "p",
        {},
        `Выбрано: ${result.selectedCount}; изменится: ${result.changedCount}; без изменений: ${result.unchangedCount}.`,
      ),
      el(
        "p",
        { class: "small" },
        result.groups
          .map((group) => `${group.name}: ${group.count}`)
          .join("; "),
      ),
      el(
        "p",
        { class: "small" },
        [...dayCounts]
          .map(([day, count]) => `${DAYS[day]}: ${count}`)
          .join("; ") +
          " · " +
          [...weekCounts]
            .map(([week, count]) => `${weekName(week)}: ${count}`)
            .join("; "),
      ),
      rows,
      controls,
    );
    rows.replaceChildren(
      ...result.changes
        .slice(previewPage * PAGE, (previewPage + 1) * PAGE)
        .map((item) =>
          el(
            "article",
            { class: "batch-change", "data-batch-preview-row": item.id },
            el("strong", {}, context(item.after)),
            el("p", {}, "Было: " + describe(item.before)),
            el("p", {}, "Будет: " + describe(item.after)),
          ),
        ),
    );
    pagination(controls, previewPage, result.changes.length, (value) => {
      previewPage = value;
      drawPreview();
    });
  }
  const previewButton = el(
      "button",
      { type: "submit", class: "btn" },
      "Предпросмотр",
    ),
    applyButton = button(
      "Применить в черновике",
      async () => {
        if (!plan?.result.valid || pending) return;
        pending = true;
        updateActions();
        error.textContent = "";
        try {
          await onApply(structuredClone(plan.payload));
        } catch (problem) {
          error.textContent = problem.message;
          plan = null;
          review.replaceChildren();
          status.textContent =
            "Правка не применена. Требуется новый предпросмотр.";
          onInvalidate();
          error.scrollIntoView({ block: "nearest" });
        } finally {
          pending = false;
          updateActions();
        }
      },
      { class: "btn primary", disabled: true },
    );
  root.append(
    el(
      "div",
      {
        class: "batch-actions",
        role: "group",
        "aria-label": "Действия массовой правки",
      },
      previewButton,
      applyButton,
      button("Отмена", onClose, { class: "btn" }),
    ),
    el(
      "p",
      { class: "notice-info" },
      "Выберите конкретные занятия и одну правку. Меняется постоянное расписание; разовые изменения по датам и исторические снимки не переписываются. Предпросмотр обязателен. Применение сохраняет черновик на устройстве; публикация — отдельным действием.",
    ),
    filterBox,
    el("div", { class: "row" }, all, clear),
    count,
    status,
    list,
    pager,
    field(
      "Что изменить",
      select(
        [
          ["roomId", "Аудитория"],
          ["teacherId", "Преподаватель"],
          ["subjectId", "Предмет"],
          ["type", "Тип занятия"],
          ["setTime", "Начало и конец"],
          ["shiftTime", "Сдвиг времени"],
        ],
        change.kind,
        (event) => {
          change = { kind: event.target.value };
          invalidate();
          drawPatch();
        },
        { "aria-label": "Что изменить" },
      ),
    ),
    patch,
    error,
    review,
  );
  root.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!selected.size || pending) return;
    const payload = { ids: [...selected], change: structuredClone(change) };
    const attempt = generation;
    plan = null;
    pending = true;
    updateActions();
    error.textContent = "";
    review.replaceChildren();
    status.textContent = "Проверяем выбранные занятия…";
    try {
      const result = await onPreview(payload);
      if (attempt !== generation) {
        onInvalidate();
        status.textContent =
          "Выбор или правка изменились. Повторите предпросмотр.";
        return;
      }
      plan = { payload: structuredClone(payload), result };
      error.textContent = result.error || "";
      status.textContent = result.valid
        ? "Предпросмотр готов. Проверьте изменения перед применением."
        : "Проверка завершена. Исправьте ошибку перед применением.";
      drawPreview();
      (result.valid ? review : error).scrollIntoView({ block: "start" });
    } catch (problem) {
      error.textContent = problem.message;
      status.textContent =
        "Предпросмотр не готов. Проверьте данные перед повторной попыткой.";
      error.scrollIntoView({ block: "nearest" });
    } finally {
      pending = false;
      updateActions();
    }
  });
  drawPatch();
  drawList();
  return root;
}

let stylesheet;
export function loadLessonBatchStyles() {
  if (stylesheet) return stylesheet;
  stylesheet = new Promise((resolve, reject) => {
    const link = el("link", {
      rel: "stylesheet",
      href: new URL("./lesson-batch-editor.css", import.meta.url).href,
    });
    link.addEventListener("load", resolve, { once: true });
    link.addEventListener(
      "error",
      () => {
        link.remove();
        stylesheet = null;
        reject(
          Error(
            "Не удалось загрузить оформление массовой правки. Повторите открытие.",
          ),
        );
      },
      { once: true },
    );
    document.head.append(link);
  });
  return stylesheet;
}
