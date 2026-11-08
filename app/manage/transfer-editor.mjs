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
    from.disabled = to.disabled = preview.disabled = pending || applied;
    apply.disabled = pending || !plan;
    apply.textContent = applied
      ? "Повторить сохранение"
      : "Добавить в черновик";
  }
  function invalidate() {
    generation++;
    plan = null;
    page = 0;
    review.replaceChildren();
    status.textContent = error.textContent = "";
    onInvalidate();
    onDirty();
    controls();
  }
  function renderReview() {
    const pages = Math.ceil(plan.count / 40);
    review.replaceChildren(
      el("h3", { tabindex: "-1" }, "Предпросмотр новых занятий"),
      el(
        "p",
        { class: "batch-count" },
        `Будет добавлено: ${plan.count}. Существующие занятия сохраняются.`,
      ),
      el(
        "div",
        { class: "batch-list" },
        ...transferPage(plan, page).map((row) =>
          el(
            "article",
            { class: "batch-change", "data-transfer-lesson": row.id },
            el("strong", {}, row.title),
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
                  renderReview();
                },
                { class: "btn", disabled: page === 0 },
              ),
              button(
                "Следующие занятия",
                () => {
                  page++;
                  renderReview();
                },
                { class: "btn", disabled: page + 1 >= pages },
              ),
            ),
          ]
        : []),
    );
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
      const result = await onPreview(options);
      if (!root.isConnected || generation !== version) return;
      plan = result;
      status.textContent = "";
      renderReview();
      review.querySelector("h3").focus();
      review.scrollIntoView({ block: "start" });
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
    if (pending || !plan) return;
    const version = generation;
    pending = true;
    error.textContent = "";
    controls();
    try {
      const result = await onApply(applied);
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
      "Добавляются новые занятия. Общие занятия выбранной подгруппы копируются только в эту подгруппу. При любом пересечении весь набор отклоняется. Предпросмотр ничего не сохраняет; публикация выполняется отдельно.",
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
    el(
      "div",
      { class: "batch-actions" },
      preview,
      apply,
      button("Закрыть копирование", onClose, { class: "btn" }),
    ),
    ...(onBack ? [button("Назад к шаблонам", onBack, { class: "btn" })] : []),
    error,
    status,
    review,
  );
  return root;
}
