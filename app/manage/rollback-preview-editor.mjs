import { el, button } from "../lib/dom.mjs";

const ACK = "Подтверждаю восстановление всей версии для всех групп";
function checked(value, revision, target, page) {
  const integer = (n) => Number.isSafeInteger(n) && n >= 0;
  if (
    value?.format !== "uniflow-rollback-preview-v1" ||
    value.revision !== revision ||
    value.target !== target ||
    value.page !== page ||
    value.pageSize !== 40 ||
    !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
    !integer(value.totalChanges) ||
    !integer(value.totalPages) ||
    value.totalPages !== Math.max(1, Math.ceil(value.totalChanges / 40)) ||
    page >= value.totalPages ||
    !Array.isArray(value.summary) ||
    value.summary.length > 32 ||
    !Array.isArray(value.changes) ||
    value.changes.length !==
      Math.min(40, Math.max(0, value.totalChanges - page * 40)) ||
    value.summary.some(
      (s) =>
        !s ||
        typeof s.label !== "string" ||
        s.label.length > 200 ||
        ![s.beforeCount, s.afterCount, s.added, s.removed, s.changed].every(
          integer,
        ) ||
        typeof s.detailed !== "boolean" ||
        typeof s.orderChanged !== "boolean",
    ) ||
    value.changes.some(
      (c) =>
        !c ||
        !["added", "removed", "changed", "order"].includes(c.kind) ||
        ![c.label, c.beforeText, c.afterText].every(
          (s) => typeof s === "string" && s.length <= 2000,
        ) ||
        typeof c.hiddenChanged !== "boolean",
    )
  )
    throw Error(
      "Не удалось проверить ответ сервера. Откройте просмотр заново.",
    );
  return value;
}

export function createRollbackPreview({
  revision,
  target,
  onLoad,
  onApply,
  onClose,
}) {
  let plan = null,
    fingerprint = null,
    pending = false,
    generation = 0;
  const root = el("form", {
      class: "lesson-batch-editor rollback-preview-editor",
    }),
    error = el("p", { id: "form-error", class: "form-error", role: "alert" }),
    status = el("p", { role: "status", class: "small" }),
    summary = el("div", { class: "batch-preview" }),
    changes = el("div", {
      class: "batch-list",
      "aria-label": "Изменения версии",
    }),
    pager = el("div", {
      class: "row",
      role: "group",
      "aria-label": "Страницы изменений",
    }),
    acknowledgment = el("input", { type: "checkbox", onchange: update }),
    apply = el(
      "button",
      { type: "submit", class: "btn danger", disabled: true },
      "Восстановить",
    ),
    retry = button(
      "Обновить сравнение",
      () => {
        fingerprint = null;
        load(0);
      },
      { class: "btn" },
    );
  function update() {
    apply.disabled =
      pending || !plan || !plan.totalChanges || !acknowledgment.checked;
    acknowledgment.disabled = pending || !plan || !plan.totalChanges;
    retry.disabled = pending;
  }
  function draw(value) {
    summary.replaceChildren(
      el(
        "p",
        { class: "batch-count" },
        `Изменений: ${value.totalChanges}. Сравниваются опубликованные данные версии ${revision} и версии ${target}.`,
      ),
      el(
        "details",
        {},
        el("summary", {}, "Сравнение разделов"),
        ...value.summary.map((s) =>
          el(
            "p",
            { class: "small" },
            `${s.label}: ${s.beforeCount} → ${s.afterCount}. ` +
              (s.detailed
                ? `Добавлено: ${s.added}, удалено: ${s.removed}, изменено: ${s.changed}${s.orderChanged ? ", изменён порядок" : ""}.`
                : s.changed
                  ? "Состав изменится; содержимое скрыто."
                  : "Без изменений."),
          ),
        ),
      ),
    );
    changes.replaceChildren(
      ...value.changes.map((c) =>
        el(
          "article",
          { class: "batch-change", "data-rollback-change": c.kind },
          el(
            "div",
            {},
            el(
              "strong",
              {},
              `${{ added: "Добавление", removed: "Удаление", changed: "Изменение", order: "Порядок" }[c.kind]} · ${c.label}`,
            ),
            el("p", { class: "small" }, "Сейчас: " + c.beforeText),
            el("p", { class: "small" }, "После: " + c.afterText),
            c.hiddenChanged &&
              el(
                "p",
                { class: "small" },
                "Дополнительные сведения также изменятся; содержимое скрыто.",
              ),
          ),
        ),
      ),
    );
    pager.replaceChildren(
      button("Назад", () => load(value.page - 1), {
        class: "btn tiny",
        disabled: !value.page,
      }),
      el(
        "span",
        { class: "small" },
        `Страница ${value.page + 1} из ${value.totalPages}`,
      ),
      button("Далее", () => load(value.page + 1), {
        class: "btn tiny",
        disabled: value.page + 1 >= value.totalPages,
      }),
    );
    status.textContent = value.totalChanges
      ? "Проверьте изменения перед подтверждением."
      : "Опубликованные данные совпадают. Восстановление не требуется.";
  }
  async function load(page) {
    const run = ++generation;
    pending = true;
    plan = null;
    acknowledgment.checked = false;
    error.textContent = "";
    status.textContent = "Загружаем сравнение…";
    changes.replaceChildren();
    pager.replaceChildren();
    summary.replaceChildren();
    update();
    try {
      const value = checked(await onLoad(page), revision, target, page);
      if (run !== generation || !root.isConnected) return;
      if (fingerprint && fingerprint !== value.fingerprint)
        throw Error(
          "Состав версии изменился. Обновите сравнение и проверьте его заново.",
        );
      fingerprint = value.fingerprint;
      plan = value;
      draw(value);
    } catch (problem) {
      if (run === generation && root.isConnected) {
        plan = null;
        error.textContent = problem.message;
        status.textContent =
          "Сравнение недоступно. Восстановление заблокировано.";
      }
    } finally {
      if (run === generation && root.isConnected) {
        pending = false;
        update();
      }
    }
  }
  root.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (apply.disabled) return;
    pending = true;
    error.textContent = "";
    update();
    try {
      await onApply(plan, () => {
        status.textContent =
          "Восстановление отправлено. Закрытие окна не отменяет запрос.";
      });
      if (root.isConnected) onClose();
    } catch (problem) {
      if (root.isConnected) {
        plan = null;
        fingerprint = null;
        acknowledgment.checked = false;
        error.textContent = problem.message;
        status.textContent = "Обновите сравнение перед повторной попыткой.";
      }
    } finally {
      pending = false;
      if (root.isConnected) update();
    }
  });
  root.append(
    el(
      "p",
      { class: "notice-info" },
      "Будет восстановлен весь документ для ВСЕХ групп: расписания, задания, объявления и посещаемость. Настройки входа владельца не меняются. Текущая опубликованная версия сохранится в истории. Локальный черновик будет сохранён отдельно перед восстановлением.",
    ),
    status,
    error,
    summary,
    changes,
    pager,
    el("label", { class: "batch-lesson" }, acknowledgment, el("span", {}, ACK)),
    el("div", { class: "row batch-actions" }, retry, apply),
  );
  return { root, load };
}
