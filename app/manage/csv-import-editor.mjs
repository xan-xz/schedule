import { el, button, field, select } from "../lib/dom.mjs";
import { DAYS } from "../core.mjs";

const PAGE = 40;
export function createCsvImportEditor({
  data,
  scope,
  onPreview,
  onApply,
  onInvalidate,
  onDirty,
  onClose,
}) {
  let plan = null,
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
    "aria-label": "Предпросмотр импорта CSV",
  });
  const file = el("input", { type: "file", accept: ".csv,text/csv" });
  const mode = select(
    [
      ["append", "Добавить занятия"],
      ["replace-scope", "Заменить выбранную область"],
    ],
    "append",
    invalidate,
  );
  const preview = el(
    "button",
    { type: "submit", class: "btn" },
    "Предпросмотр CSV",
  );
  const apply = button("Добавить в черновик", save, {
    class: "btn primary",
    disabled: true,
  });
  const name = (collection, id) =>
    data[collection].find((row) => row.id === id)?.name || "Не назначено";
  const subgroup = scope.subgroup === "all" ? "Все подгруппы" : scope.subgroup;
  const describe = (row) =>
    `${DAYS[row.day]} · ${row.start}–${row.end}${row.endDayOffset ? " (+1 день)" : ""} · ${name("subjects", row.subjectId)} · ${name("rooms", row.roomId)} · ${name("teachers", row.teacherId)} · ${row.type} · ${row.subgroup === "all" ? "Все подгруппы" : row.subgroup} · ${{ all: "Каждую неделю", odd: "Нечётная", even: "Чётная" }[row.week] || row.week}`;
  function controls() {
    file.disabled = mode.disabled = preview.disabled = pending || applied;
    apply.disabled = pending || !plan?.changes.length;
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
  file.addEventListener("change", invalidate);
  function renderReview() {
    const counts = plan.counts;
    const list = el("div", { class: "batch-list" });
    const totalPages = Math.max(1, Math.ceil(plan.changes.length / PAGE));
    page = Math.min(page, totalPages - 1);
    for (const change of plan.changes.slice(page * PAGE, (page + 1) * PAGE)) {
      list.append(
        el(
          "article",
          { class: "batch-change", "data-csv-change": change.kind },
          el(
            "strong",
            {},
            { added: "Добавить", updated: "Изменить", removed: "Удалить" }[
              change.kind
            ],
          ),
          change.before && el("p", {}, "Было: ", describe(change.before)),
          change.after && el("p", {}, "Будет: ", describe(change.after)),
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
      el(
        "p",
        { class: "batch-count" },
        `Добавить: ${counts.added}. Изменить: ${counts.updated}. Удалить: ${counts.removed}. Без изменений: ${counts.unchanged}.`,
      ),
      el(
        "p",
        {},
        mode.value === "replace-scope"
          ? "Заменяются только собственные занятия выбранной группы/подгруппы. При выборе всех подгрупп — вся группа. Разовые изменения и связанные записи не удаляются автоматически."
          : "Существующие занятия сохраняются. Совпадения и пересечения проверены общей валидацией.",
      ),
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
    if (!plan.changes.length)
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
      if (!selected) throw Error("Выбери файл CSV.");
      if (selected.size > 1_000_000)
        throw Error("Размер CSV не должен превышать 1 МБ.");
      const bytes = await selected.arrayBuffer();
      if (!root.isConnected || version !== generation) return;
      if (bytes.byteLength > 1_000_000)
        throw Error("Размер CSV не должен превышать 1 МБ.");
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw Error("Сохрани CSV в кодировке UTF-8 и выбери файл заново.");
      }
      const result = await onPreview(text, selectedMode);
      if (!root.isConnected || version !== generation) return;
      plan = result;
      page = 0;
      renderReview();
      review.querySelector("h3").focus();
      review.scrollIntoView({ block: "start" });
    } catch (problem) {
      if (root.isConnected && version === generation)
        error.textContent = problem.message;
    } finally {
      pending = false;
      controls();
    }
  });
  async function save() {
    if (pending || !plan?.changes.length) return;
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
      "Файл до 1 МБ, до 1000 загружаемых занятий, UTF-8. Предпросмотр ничего не сохраняет. Применение создаёт локальный черновик; публикация выполняется отдельно.",
    ),
    el("p", {}, `${name("groups", scope.groupId)} · ${subgroup}`),
    el(
      "p",
      { class: "small" },
      "Столбцы: day,start,end,subject,room,teacher,type,subgroup,week,endDayOffset,id. Обязательны day,start,end,subject. День: 0 — понедельник. Названия или ID должны совпадать со справочниками. CSV с ID из экспорта загружайте в режиме замены области.",
    ),
    field("Файл CSV", file),
    field("Режим импорта", mode),
    el("div", { class: "batch-actions" }, preview, apply),
    error,
    status,
    review,
  );
  return root;
}
