import { projectPublicData } from "../public-data.mjs";
// A bounded data block, never executable code or an authority/cache boundary.
export const INITIAL_SNAPSHOT_ID = "uniflow-public-snapshot";
export const INITIAL_SNAPSHOT_FORMAT = "uniflow-public-snapshot-v1";
export const MAX_INITIAL_SNAPSHOT_BYTES = 1024 * 1024;
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
/** Public field allowlists apply at build AND read; no arbitrary nested values. */
export function projectInitialSnapshot(input) {
  if (
    !object(input) ||
    !object(input.data) ||
    !Array.isArray(input.data.groups) ||
    !Array.isArray(input.data.lessons) ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1 ||
    typeof input.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(input.updatedAt))
  )
    throw Error("Invalid public release snapshot");
  const data = projectPublicData(input.data);
  return {
    source: "release-snapshot",
    revision: input.revision,
    updatedAt: input.updatedAt,
    data,
  };
}

export function readInitialSnapshot(document = globalThis.document) {
  try {
    const element = document?.getElementById(INITIAL_SNAPSHOT_ID);
    if (element?.type !== "application/json") return null;
    const raw = element.textContent;
    if (
      !raw ||
      new TextEncoder().encode(raw).length > MAX_INITIAL_SNAPSHOT_BYTES
    )
      return null;
    const value = JSON.parse(raw);
    if (value?.format !== INITIAL_SNAPSHOT_FORMAT) return null;
    return projectInitialSnapshot(value.snapshot);
  } catch {
    return null;
  }
}

/** Native released form stays useful while settings/IDB resolve. No scope is saved here. */
export function guardInitialChoice(
  document = globalThis.document,
  native = false,
) {
  const form = document?.querySelector?.("[data-initial-choice]");
  if (!form) return;
  // The small build-generated guard works before the application bundle arrives.
  // Upgrade its existing handlers to queue submission once hydration can consume it.
  form.dataset.choiceGuard = native
    ? form.dataset.choiceGuard || "native"
    : "queued";
  if (form.dataset.choiceBound === "true") return;
  form.dataset.choiceBound = "true";
  const group = form.querySelector('[name="g"]');
  const subgroup = form.querySelector('[name="subgroup"]');
  const search = form.querySelector("[data-choice-search]");
  const send = form.querySelector('[type="submit"]');
  const options = [...group.options].slice(1);
  function update() {
    if (!group.value) {
      send.disabled = true;
      return;
    }
    const selected = group.selectedOptions[0];
    const values = selected?.dataset.subgroups
      ? JSON.parse(selected.dataset.subgroups)
      : [];
    const before = subgroup.value;
    subgroup.replaceChildren(
      ...[...values, "all"].map((value) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value === "all" ? "Обе" : value;
        return option;
      }),
    );
    subgroup.value = [...values, "all"].includes(before)
      ? before
      : values[0] || "all";
    send.disabled = !group.value;
  }
  group.addEventListener("change", () => {
    form.dataset.touched = "true";
    update();
  });
  subgroup.addEventListener("change", () => {
    form.dataset.touched = "true";
  });
  search.addEventListener("input", () => {
    form.dataset.touched = "true";
    const term = search.value.trim().toLocaleLowerCase();
    for (const option of options)
      option.hidden = !option.dataset.search.toLocaleLowerCase().includes(term);
    if (group.selectedOptions[0]?.hidden) group.value = "";
    update();
  });
  form.addEventListener("submit", (event) => {
    form.dataset.touched = "true";
    if (form.dataset.choiceGuard === "native") return;
    event.preventDefault();
    form.dataset.submitRequested = "true";
    send.disabled = true;
  });
  update();
}

export function readInitialChoice(document = globalThis.document) {
  return readChoiceForm(
    document?.querySelector?.("[data-initial-choice]"),
    document,
  );
}

/** Capture a chooser draft before a background catalogue replaces its DOM. */
export function readChoiceForm(
  form,
  document = form?.ownerDocument || globalThis.document,
) {
  if (!form) return null;
  const search = form.querySelector("[data-choice-search]");
  const group = form.querySelector('[name="g"]');
  const subgroup = form.querySelector('[name="subgroup"]');
  if (!search || !group || !subgroup) return null;
  return {
    groupId: group.value,
    subgroup: subgroup.value,
    search: search.value,
    touched: form.dataset.touched === "true",
    submitRequested: form.dataset.submitRequested === "true",
    focus:
      document?.activeElement === search
        ? "search"
        : document?.activeElement === group
          ? "group"
          : document?.activeElement === subgroup
            ? "subgroup"
            : "",
    selectionStart: search.selectionStart,
    selectionEnd: search.selectionEnd,
  };
}
