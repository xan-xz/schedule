import { el, button, field } from "../lib/dom.mjs";
import { jsonImportPage, JSON_IMPORT_BYTES } from "./json-import-preview.mjs";

const PAGE = 40;
export function createJsonImportEditor({
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
  const root = el("form", { class: "lesson-batch-editor json-import-editor" });
  const error = el("p", {
    id: "form-error",
    class: "form-error",
    role: "alert",
  });
  const status = el("p", { role: "status" });
  const review = el("section", {
    class: "batch-preview",
    "aria-label": "Предпросмотр импорта JSON",
  });
  const file = el("input", { type: "file", accept: ".json,application/json" });
  const acknowledgment = el("input", { type: "checkbox", onchange: controls });
  const preview = el(
    "button",
    { type: "submit", class: "btn" },
    "Предпросмотр JSON",
  );
  const apply = button("Добавить в черновик", save, {
    class: "btn primary",
    disabled: true,
  });
  function controls() {
    file.disabled = preview.disabled = pending || applied;
    acknowledgment.disabled = pending || applied || !plan?.totalChanges;
    apply.disabled =
      pending || !plan?.totalChanges || (!applied && !acknowledgment.checked);
    apply.textContent = applied
      ? "Повторить сохранение"
      : "Добавить в черновик";
  }
  function invalidate() {
    generation++;
    plan = null;
    acknowledgment.checked = false;
    review.replaceChildren();
    status.textContent = error.textContent = "";
    onInvalidate();
    onDirty();
    controls();
  }
  file.addEventListener("change", invalidate);
  function renderReview() {
    const list = el("div", { class: "batch-list" });
    const totalPages = Math.max(1, Math.ceil(plan.totalChanges / PAGE));
    page = Math.min(page, totalPages - 1);
    for (const change of jsonImportPage(plan, page)) {
      list.append(
        el(
          "article",
          { class: "batch-change", "data-json-change": change.kind },
          el(
            "strong",
            {},
            `${{ added: "Добавить", removed: "Удалить", changed: "Изменить" }[change.kind]} · ${change.label}`,
          ),
          el("p", {}, "Сейчас: " + change.beforeText),
          el("p", {}, "После: " + change.afterText),
          change.hiddenChanged &&
            el(
              "p",
              { class: "small" },
              "Дополнительные сведения изменятся; содержимое скрыто.",
            ),
        ),
      );
    }
    const previous = button(
      "Предыдущие изменения",
      () => {
        page--;
        acknowledgment.checked = false;
        renderReview();
        controls();
      },
      { class: "btn", disabled: page === 0 },
    );
    const next = button(
      "Следующие изменения",
      () => {
        page++;
        acknowledgment.checked = false;
        renderReview();
        controls();
      },
      { class: "btn", disabled: page + 1 >= totalPages },
    );
    review.replaceChildren(
      el("h3", { tabindex: "-1" }, "Предпросмотр изменений"),
      el(
        "p",
        { class: "batch-count" },
        `Изменений: ${plan.totalChanges}. Групп: ${plan.summary[0].beforeCount} → ${plan.summary[0].afterCount}.`,
      ),
      el(
        "details",
        {},
        el("summary", {}, "Сравнение разделов"),
        ...plan.summary.map((s) =>
          el(
            "p",
            { class: "small" },
            `${s.label}: ${s.beforeCount} → ${s.afterCount}. ` +
              (s.opaque
                ? s.changed
                  ? "Состав изменится; содержимое скрыто."
                  : "Без изменений."
                : `Добавить: ${s.added}, удалить: ${s.removed}, изменить: ${s.changed}.`),
          ),
        ),
      ),
      list,
      ...(plan.totalChanges
        ? [
            el(
              "p",
              { role: "status" },
              `Страница ${page + 1} из ${totalPages}. Изменений: ${plan.totalChanges}.`,
            ),
            el("div", { class: "row" }, previous, next),
          ]
        : []),
    );
    if (!plan.totalChanges)
      status.textContent = "Изменений нет. Черновик не изменён.";
  }
  root.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (pending || applied) return;
    invalidate();
    const version = generation,
      selected = file.files[0];
    pending = true;
    controls();
    status.textContent = "Читаем и проверяем JSON…";
    try {
      if (!selected || !/\.json$/i.test(selected.name))
        throw Error("Выберите файл экспорта UniFlow 2 (.json).");
      if (selected.size > JSON_IMPORT_BYTES)
        throw Error("Размер JSON не должен превышать 1 МБ.");
      const bytes = await selected.arrayBuffer();
      if (!root.isConnected || version !== generation) return;
      if (bytes.byteLength > JSON_IMPORT_BYTES)
        throw Error("Размер JSON не должен превышать 1 МБ.");
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw Error("Сохрани JSON в кодировке UTF-8 и выбери файл заново.");
      }
      const result = await onPreview(text);
      if (!root.isConnected || version !== generation) return;
      plan = result;
      page = 0;
      status.textContent = "";
      renderReview();
      review.querySelector("h3").focus();
      review.scrollIntoView({ block: "start" });
    } catch (problem) {
      if (root.isConnected && version === generation) {
        error.textContent = problem.message;
        status.textContent = "Файл не применён.";
      }
    } finally {
      pending = false;
      controls();
    }
  });
  async function save() {
    if (apply.disabled) return;
    const version = generation;
    pending = true;
    error.textContent = "";
    controls();
    status.textContent = "Сохраняем локальную копию черновика…";
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
      "JSON экспорта UniFlow 2, UTF-8, до 1 МБ. Импорт заменяет назначения и справочники ВСЕХ групп. Сравнение учитывает текущий черновик. Файл не заменяет задания, объявления, обращения, посещаемость, историю, разрешения исходных конфликтов и настройки доступа. Публикация выполняется отдельно.",
    ),
    field("Файл JSON", file),
    el(
      "label",
      { class: "batch-lesson" },
      acknowledgment,
      el(
        "span",
        {},
        "Подтверждаю замену назначений всех групп в локальном черновике",
      ),
    ),
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
  controls();
  return root;
}
