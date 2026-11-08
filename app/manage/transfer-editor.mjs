import { el, button, field, select } from "../lib/dom.mjs";
import { DAYS } from "../core.mjs";
import { transferPage } from "./transfer-preview.mjs";

export function createTransferEditor({
  kind,
  template,
  groupName,
  subgroup,
  day,
  onPreview,
  onApply,
  onInvalidate,
  onDirty,
  onClose,
  onBack,
}) {
  let plan = null,
    page = 0,
    generation = 0,
    pending = false,
    applied = false;
  const root = el("form", { class: "lesson-batch-editor transfer-editor" });
  const error = el("p", {
    id: "form-error",
    class: "form-error",
    role: "alert",
  });
  const status = el("p", { role: "status" });
  const review = el("section", {
    class: "batch-preview",
    "aria-label": "Предпросмотр копирования",
  });
  const days = DAYS.map((name, i) => [String(i), name]);
  const parity = [
    ["odd", "Нечётная"],
    ["even", "Чётная"],
  ];
  const from = select(
    kind === "day" ? days : parity,
    kind === "day" ? String(day) : "odd",
    invalidate,
    { "aria-label": "Откуда" },
  );
  const to = select(
    kind === "week" ? parity : days,
    kind === "week" ? "even" : String(kind === "day" ? (day + 1) % 7 : day),
    invalidate,
    { "aria-label": kind === "template" ? "День назначения" : "Куда" },
  );
  const mode = select(
    [
      ["append", "Добавить занятия"],
      ["replace-destination", "Заменить область назначения"],
    ],
    "append",
    invalidate,
    { "aria-label": "Режим копирования" },
  );
  const acknowledgment = el("input", { type: "checkbox", onchange: controls });
  const confirmation = el(
    "label",
    { class: "batch-lesson", hidden: true },
    acknowledgment,
    el(
      "span",
      {},
      "Подтверждаю замену собственных занятий выбранной области назначения",
    ),
  );
  const preview = el(
    "button",
    { type: "submit", class: "btn" },
    "Предпросмотр копирования",
  );
  const apply = button("Добавить в черновик", save, {
    class: "btn primary",
    disabled: true,
  });
  const source =
    kind === "template"
      ? `Шаблон «${template.name}»`
      : kind === "day"
        ? "Копирование дня"
        : "Копирование чётности недели";
  function controls() {
    from.disabled =
      to.disabled =
      mode.disabled =
      preview.disabled =
        pending || applied;
    confirmation.hidden = mode.value !== "replace-destination";
    acknowledgment.disabled =
      pending || applied || !plan || plan.mode !== "replace-destination";
    apply.disabled =
      pending ||
      !plan ||
      (!applied &&
        plan.mode === "replace-destination" &&
        !acknowledgment.checked);
    apply.textContent = applied
      ? "Повторить сохранение"
      : "Добавить в черновик";
  }
  function invalidate() {
    generation++;
    plan = null;
    acknowledgment.checked = false;
    page = 0;
    review.replaceChildren();
    status.textContent = error.textContent = "";
    onInvalidate();
    onDirty();
    controls();
  }
  function renderReview() {
    const pages = Math.ceil(plan.totalChanges / 40);
    const destination =
      kind === "day" || template?.kind === "day"
        ? DAYS[Number(to.value)]
        : kind === "week"
          ? to.value === "odd"
            ? "Нечётная неделя"
            : "Чётная неделя"
          : "Вся регулярная неделя";
    review.replaceChildren(
      el(
        "h3",
        { tabindex: "-1" },
        plan.mode === "replace-destination"
          ? "Предпросмотр замены назначений"
          : "Предпросмотр новых занятий",
      ),
      el(
        "p",
        { class: "notice-info" },
        `Область назначения: ${groupName} · ${subgroup === "all" ? "Все подгруппы" : "Подгруппа " + subgroup} · ${destination}`,
      ),
      el(
        "p",
        { class: "batch-count" },
        plan.mode === "replace-destination"
          ? `Будет добавлено: ${plan.count}. Будет удалено: ${plan.removedCount}. Меняются только собственные занятия области назначения.`
          : `Будет добавлено: ${plan.count}. Существующие занятия сохраняются.`,
      ),
      el(
        "div",
        { class: "batch-list" },
        ...transferPage(plan, page).map((row) =>
          el(
            "article",
            {
              class: "batch-change",
              "data-transfer-kind": row.kind,
              ...(row.kind === "added"
                ? { "data-transfer-lesson": row.id }
                : { "data-transfer-removed": row.id }),
            },
            el(
              "strong",
              {},
              `${row.kind === "added" ? "Добавить" : "Удалить"} · ${row.title}`,
            ),
            el("p", {}, row.text),
            el("p", {}, row.period),
          ),
        ),
      ),
      ...(pages > 1
        ? [
            el("p", { role: "status" }, `Страница ${page + 1} из ${pages}.`),
            el(
              "div",
              { class: "row" },
              button(
                "Предыдущие занятия",
                () => {
                  page--;
                  acknowledgment.checked = false;
                  renderReview();
                  focusReview();
                },
                { class: "btn", disabled: page === 0 },
              ),
              button(
                "Следующие занятия",
                () => {
                  page++;
                  acknowledgment.checked = false;
                  renderReview();
                  focusReview();
                },
                { class: "btn", disabled: page + 1 >= pages },
              ),
            ),
          ]
        : []),
    );
    controls();
  }
  function focusReview() {
    review.querySelector("h3").focus({ preventScroll: true });
    review.scrollIntoView({ block: "start" });
    // Measure the actual sticky toolbar: confirmation wraps on narrow screens.
    const overlap =
      review.getBoundingClientRect().top -
      root.querySelector(".batch-actions").getBoundingClientRect().bottom -
      12;
    if (overlap < 0) root.closest("dialog").scrollTop += overlap;
  }
  root.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (pending || applied) return;
    invalidate();
    const version = generation;
    pending = true;
    status.textContent = "Проверяем новые занятия и локальное восстановление…";
    controls();
    const options =
      kind === "day"
        ? { fromDay: Number(from.value), toDay: Number(to.value) }
        : kind === "week"
          ? { fromWeek: from.value, toWeek: to.value }
          : { toDay: Number(to.value) };
    try {
      const result = await onPreview({ ...options, mode: mode.value });
      if (!root.isConnected || generation !== version) return;
      plan = result;
      status.textContent = "";
      renderReview();
      focusReview();
    } catch (problem) {
      if (root.isConnected && generation === version) {
        error.textContent = problem.message;
        status.textContent = "";
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
    try {
      const result = await onApply(applied, acknowledgment.checked);
      if (!root.isConnected || generation !== version) return;
      if (result.saved) onClose();
      else {
        applied = true;
        status.textContent =
          "Занятия добавлены в этой вкладке. Локальная копия не сохранена. Повторите сохранение; публикация выполняется отдельно.";
        error.textContent = result.error;
      }
    } catch (problem) {
      if (root.isConnected && generation === version) {
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
      "Выберите добавление или замену области назначения. Общие пары одной подгруппы и занятия каждой недели при замене одной чётности сохраняются. Связанные записи не удаляются автоматически; при конфликте или нарушении связи весь набор отклоняется. Предпросмотр ничего не сохраняет; публикация выполняется отдельно.",
    ),
    el(
      "p",
      {},
      `${source} → ${groupName} · ${subgroup === "all" ? "Все подгруппы" : subgroup}`,
    ),
    ...(kind === "template"
      ? template.kind === "day"
        ? [field("День назначения", to)]
        : []
      : [field("Откуда", from), field("Куда", to)]),
    field("Режим копирования", mode),
    el(
      "div",
      { class: "batch-actions" },
      preview,
      apply,
      button("Закрыть копирование", onClose, { class: "btn" }),
      confirmation,
    ),
    ...(onBack ? [button("Назад к шаблонам", onBack, { class: "btn" })] : []),
    error,
    status,
    review,
  );
  return root;
}
