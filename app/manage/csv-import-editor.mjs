import { el, button, field, select } from "../lib/dom.mjs";
import { DAYS } from "../core.mjs";

const PAGE = 40;
export function createCsvImportEditor(
  { data, scope, onPreview, onApply, onInvalidate, onDirty, onClose },
  { workbookReader, template, assistedRead, prepareLocalModel } = {},
) {
  const format = workbookReader ? "XLSX" : "CSV";
  const facultyImport = !!scope.facultyId;
  let plan = null,
    workbook = null,
    page = 0,
    generation = 0,
    pending = false,
    applied = false;
  const root = el("form", { class: "lesson-batch-editor csv-import-editor" });
  const error = el("p", {
    id: "form-error",
    class: "form-error",
    role: "alert",
  });
  const status = el("p", { role: "status" });
  const review = el("section", {
    class: "batch-preview",
    "aria-label": `Предпросмотр импорта ${format}`,
  });
  const file = el("input", {
    type: "file",
    accept: workbookReader
      ? ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : ".csv,text/csv",
  });
  const sheet = select([], "", invalidate);
  const sheetField = field("Лист XLSX", sheet);
  sheetField.hidden = true;
  const assist = el("input", { type: "checkbox" });
  const assistField = field("Подсказать соответствия столбцов", assist);
  const localModel = el("input", { type: "checkbox" });
  const localModelField = field(
    "Использовать локальную модель Bionic",
    localModel,
  );
  assistField.hidden = true;
  localModelField.hidden = true;
  assist.addEventListener("change", invalidate);
  localModel.addEventListener("change", invalidate);
  const mode = select(
    facultyImport
      ? [["replace-scope", "Заменить расписание групп из файла"]]
      : [
          ["append", "Добавить занятия"],
          ["replace-scope", "Заменить выбранную область"],
        ],
    facultyImport ? "replace-scope" : "append",
    invalidate,
  );
  const preview = el(
    "button",
    { type: "submit", class: "btn" },
    workbookReader ? "Прочитать XLSX" : "Предпросмотр CSV",
  );
  const apply = button("Добавить в черновик", save, {
    class: "btn primary",
    disabled: true,
  });
  const name = (collection, id) =>
    data[collection].find((row) => row.id === id)?.name || "Не назначено";
  const subgroup = scope.subgroup === "all" ? "Все подгруппы" : scope.subgroup;
  const groupLabel = (row) =>
    facultyImport
      ? (plan.data.groups.find((group) => group.id === row.groupId)?.name ||
          name("groups", row.groupId)) + " · "
      : "";
  const hasChanges = () => plan?.changes.length || plan?.groupChanges?.length;
  const describe = (row) =>
    `${DAYS[row.day]} · ${row.start}–${row.end}${row.endDayOffset ? " (+1 день)" : ""} · ${name("subjects", row.subjectId)} · ${name("rooms", row.roomId)} · ${name("teachers", row.teacherId)} · ${row.type} · ${row.subgroup === "all" ? "Все подгруппы" : row.subgroup} · ${{ all: "Каждую неделю", odd: "Нечётная", even: "Чётная" }[row.week] || row.week}`;
  function controls() {
    file.disabled = mode.disabled = preview.disabled = pending || applied;
    sheet.disabled = pending || applied;
    assist.disabled = pending || applied;
    localModel.disabled = pending || applied;
    localModelField.hidden = !workbook || !assist.checked;
    preview.textContent =
      workbookReader && !workbook ? "Прочитать XLSX" : `Предпросмотр ${format}`;
    apply.disabled = pending || !hasChanges();
    apply.textContent = applied
      ? "Повторить сохранение"
      : "Добавить в черновик";
  }
  function invalidate() {
    generation++;
    plan = null;
    review.replaceChildren();
    status.textContent = error.textContent = "";
    onInvalidate();
    onDirty();
    controls();
  }
  file.addEventListener("change", () => {
    workbook = null;
    sheet.replaceChildren();
    sheetField.hidden = true;
    assistField.hidden = true;
    invalidate();
  });
  function renderReview() {
    const counts = plan.counts;
    const list = el("div", { class: "batch-list" });
    const totalPages = Math.max(1, Math.ceil(plan.changes.length / PAGE));
    page = Math.min(page, totalPages - 1);
    for (const change of plan.changes.slice(page * PAGE, (page + 1) * PAGE)) {
      list.append(
        el(
          "article",
          {
            class: "batch-change",
            [workbookReader ? "data-xlsx-change" : "data-csv-change"]:
              change.kind,
          },
          el(
            "strong",
            {},
            { added: "Добавить", updated: "Изменить", removed: "Удалить" }[
              change.kind
            ],
          ),
          change.before &&
            el(
              "p",
              {},
              "Было: ",
              groupLabel(change.before),
              describe(change.before),
            ),
          change.after &&
            el(
              "p",
              {},
              "Будет: ",
              groupLabel(change.after),
              describe(change.after),
            ),
        ),
      );
    }
    const previous = button(
      "Предыдущие изменения",
      () => {
        page--;
        renderReview();
      },
      { class: "btn", disabled: page === 0 },
    );
    const next = button(
      "Следующие изменения",
      () => {
        page++;
        renderReview();
      },
      { class: "btn", disabled: page + 1 >= totalPages },
    );
    review.replaceChildren(
      el("h3", { tabindex: "-1" }, "Предпросмотр изменений"),
      ...(plan.columnMapping?.length
        ? [
            el("h4", {}, "Сопоставление столбцов"),
            el(
              "ul",
              {},
              ...plan.columnMapping.map(({ from, to }) =>
                el("li", {}, `«${from}» соответствует полю ${to}`),
              ),
            ),
          ]
        : []),
      el(
        "p",
        { class: "batch-count" },
        `Добавить: ${counts.added}. Изменить: ${counts.updated}. Удалить: ${counts.removed}. Без изменений: ${counts.unchanged}.`,
      ),
      el(
        "p",
        {},
        facultyImport
          ? "Расписание заменяется для всех подгрупп каждой группы из файла. Остальные группы сохраняются."
          : mode.value === "replace-scope"
            ? "Заменяются только собственные занятия выбранной группы/подгруппы. При выборе всех подгрупп — вся группа. Разовые изменения и связанные записи не удаляются автоматически."
            : "Существующие занятия сохраняются. Совпадения и пересечения проверены общей валидацией.",
      ),
      ...(plan.groupChanges?.length
        ? [
            el(
              "ul",
              {},
              ...plan.groupChanges.map(({ name, created }) =>
                el(
                  "li",
                  {},
                  (created
                    ? "Создать группу "
                    : "Назначить факультет группе ") + name,
                ),
              ),
            ),
          ]
        : []),
      list,
      ...(plan.changes.length > PAGE
        ? [
            el(
              "p",
              { role: "status" },
              `Страница ${page + 1} из ${totalPages}. Изменений: ${plan.changes.length}.`,
            ),
            el("div", { class: "row" }, previous, next),
          ]
        : []),
    );
    if (!hasChanges())
      status.textContent = "Изменений нет. Черновик не изменён.";
  }
  root.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (pending || applied) return;
    invalidate();
    const version = generation,
      selected = file.files[0],
      selectedMode = mode.value;
    pending = true;
    controls();
    try {
      if (!selected) throw Error(`Выбери файл ${format}.`);
      if (selected.size > 1_000_000)
        throw Error(`Размер ${format} не должен превышать 1 МБ.`);
      if (workbook && sheet.value && assist.checked && localModel.checked)
        prepareLocalModel?.();
      const bytes = workbook ? null : await selected.arrayBuffer();
      if (!root.isConnected || version !== generation) return;
      if (bytes?.byteLength > 1_000_000)
        throw Error(`Размер ${format} не должен превышать 1 МБ.`);
      if (workbookReader && !workbook) {
        const loaded = await workbookReader(bytes);
        if (!root.isConnected || version !== generation) return;
        workbook = loaded;
        sheet.replaceChildren(
          el("option", { value: "" }, "Выбери лист"),
          ...loaded.sheets.map((s) =>
            el(
              "option",
              { value: s.id, disabled: s.state !== "visible" },
              s.name + (s.state !== "visible" ? " (скрытый)" : ""),
            ),
          ),
        );
        sheet.value = "";
        sheetField.hidden = false;
        assistField.hidden = !assistedRead;
        status.textContent = `Листов: ${loaded.sheets.length}. Выбери видимый лист и выполни предпросмотр. Черновик не изменён.`;
        sheet.disabled = false;
        sheet.focus();
        return;
      }
      let text;
      if (workbook)
        text = assist.checked
          ? await assistedRead(
              workbook,
              sheet.value,
              localModel.checked,
              () => {
                if (root.isConnected && version === generation)
                  status.textContent = "Запускается локальная подсказка…";
              },
            )
          : await workbook.readSheet(sheet.value);
      else
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw Error("Сохрани CSV в кодировке UTF-8 и выбери файл заново.");
        }
      const result = await onPreview(text, selectedMode);
      if (!root.isConnected || version !== generation) return;
      status.textContent = "";
      plan = result;
      if (text.mapping?.length)
        plan = { ...result, columnMapping: text.mapping };
      page = 0;
      renderReview();
      review.querySelector("h3").focus();
      review.scrollIntoView({ block: "start" });
    } catch (problem) {
      if (root.isConnected && version === generation) {
        status.textContent = "";
        error.textContent = problem.message;
      }
    } finally {
      pending = false;
      controls();
    }
  });
  async function save() {
    if (pending || !hasChanges()) return;
    const version = generation;
    pending = true;
    error.textContent = "";
    controls();
    try {
      const result = await onApply(applied);
      if (!root.isConnected || version !== generation) return;
      if (result.saved) onClose();
      else {
        applied = true;
        status.textContent =
          "Изменения в черновике этой вкладки. Локальная копия не сохранена. Повторите сохранение; публикация выполняется отдельно.";
        error.textContent = result.error;
      }
    } catch (problem) {
      if (root.isConnected && version === generation) {
        if (!applied) {
          plan = null;
          review.replaceChildren();
          onInvalidate();
        }
        error.textContent = problem.message;
      }
    } finally {
      pending = false;
      controls();
    }
  }
  root.append(
    el(
      "p",
      { class: "notice-info" },
      `Файл до 1 МБ, до 1000 загружаемых занятий${workbookReader ? " на выбранном листе" : ", UTF-8"}. Предпросмотр ничего не сохраняет. Применение создаёт локальный черновик; публикация выполняется отдельно.`,
    ),
    el(
      "p",
      {},
      facultyImport
        ? name("faculties", scope.facultyId)
        : `${name("groups", scope.groupId)} · ${subgroup}`,
    ),
    ...(facultyImport
      ? [
          el(
            "p",
            {},
            "Столбец group обязателен. Укажите название, код или ID группы. Новые группы будут созданы. Группы без факультета можно привязать при публикации.",
          ),
        ]
      : []),
    el(
      "p",
      { class: "small" },
      `Столбцы: day,start,end,subject,room,teacher,type,subgroup,week,endDayOffset,id. Обязательны day,start,end,subject. День: 0 — понедельник. Названия или ID должны совпадать со справочниками. ${format} с ID из экспорта загружайте в режиме замены области.`,
    ),
    ...(workbookReader
      ? [
          el(
            "p",
            { class: "small" },
            "Таблица с заголовками в строке 1, одно занятие на строку. Время: HH:MM или время Excel без даты и секунд. Формулы, условное форматирование, объединённые и скрытые ячейки, внешние ссылки не принимаются. Исходную сетку расписания сначала приведите к этой таблице.",
          ),
          button("Скачать шаблон XLSX", template, { class: "btn" }),
        ]
      : []),
    field(`Файл ${format}`, file),
    sheetField,
    ...(assistedRead ? [assistField, localModelField] : []),
    field("Режим импорта", mode),
    el(
      "div",
      { class: "batch-actions" },
      preview,
      apply,
      button("Закрыть импорт", onClose, { class: "btn" }),
    ),
    error,
    status,
    review,
  );
  return root;
}
