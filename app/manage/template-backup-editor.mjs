import { el, button, field } from "../lib/dom.mjs";
import { TEMPLATE_BACKUP_BYTES } from "./templates.mjs";

export function createTemplateBackupEditor({
  onPreview,
  onApply,
  onClose,
  onDirty,
}) {
  let plan = null,
    pending = false,
    generation = 0;
  const root = el("form", {
      class: "lesson-batch-editor template-backup-editor",
    }),
    file = el("input", { type: "file", accept: ".json,application/json" }),
    error = el("p", { id: "form-error", role: "alert", class: "form-error" }),
    status = el("p", { role: "status", class: "small" }),
    review = el("section", {
      class: "batch-preview",
      "aria-label": "Предпросмотр копии шаблонов",
    }),
    ack = el("input", { type: "checkbox", onchange: controls }),
    preview = el("button", { type: "submit", class: "btn" }, "Проверить копию"),
    apply = button("Импортировать шаблоны", save, {
      class: "btn primary",
      disabled: true,
    });
  function controls() {
    file.disabled = preview.disabled = pending;
    ack.disabled = pending || !plan?.valid;
    apply.disabled = pending || !plan?.valid || !ack.checked;
  }
  function invalidate() {
    generation++;
    plan = null;
    ack.checked = false;
    status.textContent = error.textContent = "";
    review.replaceChildren();
    controls();
    onDirty();
  }
  file.addEventListener("change", invalidate);
  root.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (pending) return;
    invalidate();
    const run = generation;
    pending = true;
    controls();
    status.textContent = "Проверяем файл и текущую библиотеку…";
    try {
      const selected = file.files?.[0];
      if (!selected || !/\.json$/i.test(selected.name))
        throw Error("Выберите JSON копии библиотеки шаблонов.");
      if (selected.size > TEMPLATE_BACKUP_BYTES)
        throw Error("Размер файла копии — не больше 300 КБ.");
      let raw;
      try {
        raw = new TextDecoder("utf-8", { fatal: true }).decode(
          await selected.arrayBuffer(),
        );
      } catch {
        throw Error(
          "Не удалось прочитать файл UTF-8. Выберите исходную копию UniFlow.",
        );
      }
      if (run !== generation || !root.isConnected) return;
      const result = await onPreview(raw);
      if (run !== generation || !root.isConnected) return;
      plan = result;
      status.textContent = `Добавить: ${plan.counts.added}. Уже есть: ${plan.counts.skipped}. Конфликт названий: ${plan.counts.conflict}.`;
      review.replaceChildren(
        ...[
          !plan.capacity &&
            el(
              "p",
              { class: "form-error" },
              "В библиотеке недостаточно места: максимум 20 шаблонов и 250 КБ. Старые шаблоны не удаляются.",
            ),
          !!plan.counts.conflict &&
            el(
              "p",
              { class: "form-error" },
              "Одноимённые шаблоны с другим содержимым не заменяются. Переименуйте их в библиотеке, затем повторите проверку.",
            ),
          ...plan.rows.map(({ template, status, missing }) =>
            el(
              "article",
              { class: "batch-change", "data-template-import": status },
              el(
                "strong",
                {},
                `${{ added: "Добавить", skipped: "Уже есть", conflict: "Конфликт названия" }[status]} · ${template.name}`,
              ),
              el(
                "p",
                {},
                `${template.kind === "day" ? "День" : "Неделя"} · ${template.sourceGroupName} · ${template.sourceSubgroup === "all" ? "Все подгруппы" : template.sourceSubgroup} · занятий: ${template.lessons.length}`,
              ),
              missing.length > 0 &&
                el(
                  "p",
                  { class: "small" },
                  `Не найдены справочники (${missing.length}): ${missing.slice(0, 5).join("; ")}${missing.length > 5 ? "; …" : ""}. Копия сохранится, но применять её к расписанию можно после исправления справочников.`,
                ),
            ),
          ),
        ].filter(Boolean),
      );
    } catch (problem) {
      if (run === generation && root.isConnected) {
        plan = null;
        error.textContent = problem.message;
        status.textContent = "Импорт не выполнен.";
      }
    } finally {
      if (run === generation && root.isConnected) {
        pending = false;
        controls();
      }
    }
  });
  async function save() {
    if (apply.disabled) return;
    pending = true;
    controls();
    error.textContent = "";
    status.textContent = "Ожидаем безопасную запись библиотеки…";
    try {
      const result = await onApply(plan);
      if (root.isConnected) {
        status.textContent = `Импортировано: ${result.added}. Расписание не изменилось.`;
        onClose();
      }
    } catch (problem) {
      if (root.isConnected) {
        error.textContent = problem.message;
        plan = null;
        ack.checked = false;
        status.textContent =
          "Повторите проверку перед новой попыткой. Старые шаблоны сохранены.";
      }
    } finally {
      pending = false;
      if (root.isConnected) controls();
    }
  }
  root.append(
    el(
      "p",
      { class: "notice-info" },
      "Копия добавит только шаблоны в этот браузер. Совпадающие шаблоны будут пропущены; существующие не заменятся. Расписание, черновик и настройки входа не изменятся. Максимум 20 шаблонов, файл до 300 КБ.",
    ),
    field("Файл копии шаблонов", file),
    status,
    error,
    review,
    el(
      "label",
      { class: "batch-lesson" },
      ack,
      el("span", {}, "Подтверждаю добавление шаблонов в локальную библиотеку"),
    ),
    el("div", { class: "row batch-actions" }, preview, apply),
  );
  controls();
  return root;
}
