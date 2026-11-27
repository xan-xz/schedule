import { planFacultySchedule, proposeLessonMoves } from "../ai-planner.mjs";
import { DAYS, occurrences } from "../core.mjs";
import {
  facultyChoices,
  groupFaculty,
  isGroupActive,
} from "../group-state.mjs";
import { button, el, field, select } from "../lib/dom.mjs";
import { localDate, validDate } from "../lib/time.mjs";
import { teachingSettings } from "../teaching-settings.mjs";

function bellStarts(data) {
  const settings = teachingSettings(data);
  const chosen =
    settings.bellSchedules.find(
      (row) => row.id === settings.defaultBellScheduleId,
    ) || settings.bellSchedules.find((row) => row.enabled);
  return (
    chosen?.slots
      .slice(0, 16)
      .map((slot) => slot.start)
      .join(", ") || ""
  );
}

export function createAiPlannerEditor({
  data,
  date,
  groupId,
  onApply,
  onClose,
}) {
  const today = validDate(date) ? date : localDate();
  const groups = data.groups.filter(isGroupActive);
  const initialGroup = groups.find((group) => group.id === groupId);
  const faculties = facultyChoices(data, "Без факультета");
  const root = el("form", { class: "lesson-batch-editor transfer-editor" });
  const error = el("p", { class: "form-error", role: "alert" });
  const review = el("section", {
    class: "batch-preview",
    "aria-label": "Предпросмотр плана",
  });
  const status = el("p", { class: "small", role: "status" });
  const mode = select(
    [
      ["move", "Разовый перенос"],
      ["faculty", "План факультета"],
    ],
    "move",
    updateMode,
  );
  const moveGroup = select(
    groups.map((group) => [group.id, group.name]),
    initialGroup?.id || groups[0]?.id || "",
    refreshLessons,
  );
  const sourceDate = el("input", {
    type: "date",
    value: today,
    onchange: refreshLessons,
  });
  const targetDate = el("input", { type: "date", value: today });
  const moveLesson = select([], "");
  const moveFields = el(
    "div",
    { class: "batch-filters" },
    field("Группа занятия", moveGroup),
    field("Дата занятия", sourceDate),
    field("Пара для переноса", moveLesson),
    field("Дата переноса", targetDate),
  );
  const faculty = select(
    faculties.map((row) => [row.id, row.name]),
    initialGroup ? groupFaculty(initialGroup) : faculties[0]?.id || "",
    refreshFacultyGroups,
  );
  const facultyGroup = select([], "");
  const weekdayInputs = DAYS.map((day, i) => [
    day,
    el("input", { type: "checkbox", value: String(i), checked: i < 5 }),
  ]);
  const days = el(
    "fieldset",
    { class: "batch-filters" },
    el("legend", {}, "Дни недели"),
    weekdayInputs.map(([day, input]) =>
      el("label", { class: "batch-lesson" }, input, el("span", {}, day)),
    ),
  );
  const facultyFields = el(
    "div",
    { hidden: true },
    el(
      "div",
      { class: "batch-filters" },
      field("Факультет", faculty),
      field("Группа для расчёта", facultyGroup),
    ),
    days,
  );
  const startTimes = el("input", {
    type: "text",
    value: bellStarts(data),
    maxlength: 120,
    placeholder: "08:00, 09:00, 10:00",
  });
  const room = select(
    [
      ["", "Текущая аудитория"],
      ...data.rooms.map((item) => [item.id, item.name]),
    ],
    "",
  );
  const capacity = el("input", {
    type: "number",
    min: 0,
    max: 500,
    step: 1,
    value: 0,
  });
  const form = el(
    "div",
    {},
    field("Режим планирования", mode),
    moveFields,
    facultyFields,
    el(
      "div",
      { class: "batch-filters" },
      field("Время начала", startTimes),
      field("Аудитория", room),
      field("Минимум мест", capacity),
    ),
    el(
      "p",
      { class: "small" },
      "Укажите до 16 вариантов начала через запятую. Исходные значения взяты из сетки звонков. Вместимость 0 означает поиск без ограничения по числу мест.",
    ),
  );
  const preview = el(
    "button",
    { type: "submit", class: "btn" },
    "Рассчитать варианты",
  );
  const close = button("Закрыть помощник", onClose, { class: "btn" });
  let datedRows = [];
  let saving = false;
  const idName = (key, id) =>
    data[key].find((row) => row.id === id)?.name || "Не назначено";
  const interval = (row) =>
    `${row.start}–${row.end}${row.endDayOffset ? " (+1 день)" : ""}`;
  const describe = (row) => `${interval(row)} · ${idName("rooms", row.roomId)}`;
  const lessonName = (row) =>
    `${idName("subjects", row.subjectId)} · ${idName("groups", row.groupId)}${row.subgroup === "all" ? ", все подгруппы" : `, ${row.subgroup}`}`;

  function updatePreviewButton() {
    preview.disabled =
      saving || (mode.value === "move" ? !moveLesson.value : !faculty.value);
  }

  function clear() {
    review.replaceChildren();
    error.textContent = status.textContent = "";
    updatePreviewButton();
  }

  function refreshLessons() {
    datedRows = validDate(sourceDate.value)
      ? occurrences(data, sourceDate.value, { activeOnly: true }).filter(
          (row) => row.groupId === moveGroup.value && !row.cancelled,
        )
      : [];
    moveLesson.replaceChildren(
      ...datedRows.map((row, i) =>
        el(
          "option",
          { value: String(i + 1) },
          `${interval(row)} · ${idName("subjects", row.subjectId)} · ${row.subgroup === "all" ? "Все подгруппы" : row.subgroup}`,
        ),
      ),
    );
    if (!datedRows.length)
      moveLesson.append(
        el("option", { value: "" }, "На эту дату нет действующих занятий"),
      );
    clear();
  }

  function refreshFacultyGroups(useInitial = false) {
    const members = groups.filter(
      (group) => groupFaculty(group) === faculty.value,
    );
    facultyGroup.replaceChildren(
      el("option", { value: "" }, "Все группы факультета"),
      ...members.map((group) => el("option", { value: group.id }, group.name)),
    );
    facultyGroup.value =
      useInitial === true && members.includes(initialGroup) ? groupId : "";
    clear();
  }

  function updateMode() {
    moveFields.hidden = mode.value !== "move";
    facultyFields.hidden = mode.value !== "faculty";
    clear();
  }

  async function apply(payload) {
    if (saving) return;
    saving = true;
    const controls = [...root.querySelectorAll("input, select, button")].filter(
      (item) => !item.disabled,
    );
    for (const control of controls) control.disabled = true;
    status.textContent = "Сохраняем в черновике…";
    error.textContent = "";
    try {
      await onApply(payload);
      if (root.isConnected) onClose();
    } catch (problem) {
      if (root.isConnected) error.textContent = problem.message;
    } finally {
      saving = false;
      status.textContent = "";
      for (const control of controls) control.disabled = false;
      updatePreviewButton();
    }
  }

  function renderMoves(result, row) {
    if (!result.suggestions.length) {
      status.textContent = result.reason;
      return;
    }
    review.append(
      el("h3", { tabindex: -1 }, `Варианты переноса · ${lessonName(row)}`),
      el("p", {}, `Текущая пара: ${sourceDate.value} · ${describe(row)}`),
      ...result.suggestions.map((item) =>
        el(
          "article",
          { class: "batch-change", "data-ai-move": "" },
          el("strong", {}, `${item.date} · ${describe(item)}`),
          el("p", {}, item.reasons.join(" · ")),
          button(
            "Добавить этот перенос в черновик",
            () => apply({ move: item.payload }),
            { class: "btn primary" },
          ),
        ),
      ),
    );
  }

  function renderFaculty(result) {
    const locked = result.lockedLessonIds.length;
    review.append(el("h3", { tabindex: -1 }, "Предпросмотр плана факультета"));
    if (locked)
      review.append(
        el(
          "p",
          { class: "notice-info" },
          `Связанные записи: ${locked}. К ним относятся общие занятия, заявки, посещаемость и разовые изменения.`,
        ),
      );
    if (result.status !== "planned") {
      status.textContent =
        result.reason ||
        "Текущее расписание уже подходит под выбранные условия.";
      return;
    }
    review.append(
      el(
        "p",
        { class: "batch-count" },
        `Предлагаемых изменений: ${result.changes.length}.`,
      ),
      ...result.changes.map(({ before, after, reasons }) =>
        el(
          "article",
          { class: "batch-change", "data-ai-change": "" },
          el("strong", {}, lessonName(before)),
          el("p", {}, `Сейчас: ${DAYS[before.day]} · ${describe(before)}`),
          el("p", {}, `В плане: ${DAYS[after.day]} · ${describe(after)}`),
          el("small", {}, reasons.join(" · ")),
        ),
      ),
      button(
        "Добавить план в черновик",
        () => apply({ changes: result.changes }),
        { class: "btn primary" },
      ),
    );
  }

  form.addEventListener("input", clear);
  form.addEventListener("change", clear);
  root.addEventListener("submit", (event) => {
    event.preventDefault();
    if (preview.disabled) return;
    clear();
    try {
      const options = {
        starts: startTimes.value.split(/[\s,;]+/).filter(Boolean),
        roomIds: room.value ? [room.value] : undefined,
        minimumCapacity: Number(capacity.value || 0),
      };
      if (mode.value === "move") {
        const row = datedRows[Number(moveLesson.value) - 1];
        renderMoves(
          proposeLessonMoves(data, {
            ...options,
            lessonId: row.id,
            date: row.exception?.date || sourceDate.value,
            dates: [targetDate.value],
          }),
          row,
        );
      } else {
        renderFaculty(
          planFacultySchedule(data, {
            ...options,
            facultyId: faculty.value,
            days: weekdayInputs.flatMap(([, input]) =>
              input.checked ? [Number(input.value)] : [],
            ),
            lessonIds: facultyGroup.value
              ? data.lessons
                  .filter((row) => row.groupId === facultyGroup.value)
                  .map((row) => row.id)
              : undefined,
          }),
        );
      }
      review.querySelector("h3")?.focus();
    } catch (problem) {
      error.textContent = problem.message;
    }
  });
  root.append(
    el(
      "p",
      { class: "notice-info" },
      "Помощник проверяет занятость группы, преподавателя и аудитории по данным UniFlow. Выбранное предложение добавляется в черновик. Его можно проверить перед отдельной публикацией.",
    ),
    form,
    el("div", { class: "batch-actions" }, preview, close),
    error,
    status,
    review,
  );
  refreshLessons();
  refreshFacultyGroups(true);
  return root;
}
