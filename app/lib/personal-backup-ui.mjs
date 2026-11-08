import { el, button, field, download } from "./dom.mjs";
import {
  BACKUP_BYTES,
  exportPersonalBackup,
  parsePersonalBackup,
  planPersonalRestore,
} from "./personal-backup.mjs";

export function openPersonalBackup({
  dialog,
  t,
  scope,
  scopeLabel,
  read,
  restore,
  isCurrent,
  onClose,
}) {
  let disposed = false,
    generation = 0,
    backup = null,
    busy = false,
    page = 0;
  const error = el("p", { role: "alert", class: "form-error" });
  const summary = el("p", { role: "status" });
  const rows = el("ul", { class: "task-body" });
  const previous = button(t("backupPrevious"), () => {
    page--;
    paint();
  });
  const next = button(t("backupNext"), () => {
    page++;
    paint();
  });
  const apply = button(
    t("backupRestore"),
    async () => {
      if (!backup || busy) return;
      busy = true;
      apply.disabled = true;
      file.disabled = true;
      try {
        check();
        const result = await restore(backup);
        check();
        summary.textContent = t("backupSaved", result);
        backup = null;
        rows.replaceChildren();
        previous.hidden = next.hidden = true;
      } catch (e) {
        error.textContent = t(
          e.message === "storageWarning"
            ? "storageWarning"
            : ["backupScope", "backupLimit"].includes(e.message)
              ? e.message
              : "backupInvalid",
        );
      } finally {
        busy = false;
        file.disabled = false;
        apply.disabled = !backup;
      }
    },
    { class: "primary wide", disabled: true },
  );
  function check() {
    if (disposed || !isCurrent()) throw Error("backupScope");
  }
  function paint() {
    if (!backup) return;
    rows.replaceChildren(
      ...backup.tasks
        .slice(page * 40, (page + 1) * 40)
        .map((x) =>
          el("li", {}, x.title + " · " + x.due + " · " + t(x.status)),
        ),
    );
    previous.hidden = next.hidden = backup.tasks.length <= 40;
    previous.disabled = page === 0;
    next.disabled = (page + 1) * 40 >= backup.tasks.length;
  }
  const file = el("input", {
    type: "file",
    accept: ".json,application/json",
    onchange: async () => {
      const own = ++generation;
      backup = null;
      apply.disabled = true;
      rows.replaceChildren();
      summary.textContent = "";
      error.textContent = "";
      previous.hidden = next.hidden = true;
      const selected = file.files[0];
      if (!selected) return;
      try {
        check();
        if (selected.size > BACKUP_BYTES) throw Error("backupInvalid");
        const raw = await selected.text();
        check();
        if (own !== generation) return;
        const parsed = parsePersonalBackup(raw, scope);
        const snapshot = await read();
        check();
        if (own !== generation) return;
        const plan = planPersonalRestore(snapshot.tasks, parsed, scope);
        backup = parsed;
        page = 0;
        paint();
        summary.textContent = t("backupPreview", {
          added: plan.additions.length,
          skipped: plan.skipped,
        });
        apply.disabled = !parsed.tasks.length;
      } catch (e) {
        if (!disposed && own === generation)
          error.textContent = t(
            ["backupScope", "backupLimit"].includes(e.message)
              ? e.message
              : "backupInvalid",
          );
      }
    },
  });
  previous.hidden = next.hidden = true;
  dialog.addEventListener(
    "close",
    () => {
      disposed = true;
      generation++;
      onClose();
    },
    { once: true },
  );
  dialog.replaceChildren(
    el(
      "div",
      { class: "dialog-heading" },
      el("h2", { id: "modal-title" }, t("backupTitle")),
      button(t("close"), () => dialog.close()),
    ),
    el("p", { class: "notice" }, t("backupHelp")),
    el("p", { class: "notice" }, scopeLabel),
    button(t("backupDownload"), async () => {
      if (busy) return;
      try {
        check();
        const snapshot = await read();
        check();
        download(
          "uniflow-personal-tasks.json",
          exportPersonalBackup(snapshot.tasks, snapshot.statuses, scope),
          "application/json",
        );
      } catch {
        if (!disposed) error.textContent = t("backupInvalid");
      }
    }),
    field(t("backupFile"), file),
    summary,
    rows,
    el("div", { class: "actions" }, previous, next),
    apply,
    error,
  );
  dialog.showModal();
  file.focus();
}
