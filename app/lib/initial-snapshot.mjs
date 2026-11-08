// A bounded data block, never executable code or an authority/cache boundary.
export const INITIAL_SNAPSHOT_ID = "uniflow-public-snapshot";
export const INITIAL_SNAPSHOT_FORMAT = "uniflow-public-snapshot-v1";
export const MAX_INITIAL_SNAPSHOT_BYTES = 1024 * 1024;
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const schemas = {
  groups: [
    "id",
    "name",
    "code",
    "specialty",
    "language",
    "subgroups",
    "status",
    "archived",
    "archivedAt",
    "archived_at",
    "deletedAt",
    "deleted_at",
  ],
  subjects: ["id", "name", "color"],
  teachers: ["id", "name", "subjects"],
  rooms: ["id", "name", "capacity", "capacityEstimated"],
  lessons: [
    "id",
    "groupId",
    "subjectId",
    "teacherId",
    "roomId",
    "subgroup",
    "day",
    "start",
    "end",
    "endDayOffset",
    "week",
    "type",
    "validFrom",
    "validUntil",
    "sharedSessionId",
  ],
  exceptions: [
    "id",
    "lessonId",
    "date",
    "targetDate",
    "status",
    "start",
    "end",
    "endDayOffset",
    "subjectId",
    "teacherId",
    "roomId",
    "type",
    "note",
    "createdAt",
    "updatedAt",
  ],
  tasks: [
    "id",
    "title",
    "description",
    "due",
    "groupId",
    "subgroup",
    "subjectId",
    "teacherId",
    "createdAt",
    "updatedAt",
  ],
  announcements: [
    "id",
    "title",
    "body",
    "roles",
    "groupId",
    "teacherId",
    "createdAt",
    "updatedAt",
  ],
  holidays: ["id", "name", "title", "start", "end", "groupId"],
};
const arrayFields = new Set(["subgroups", "subjects", "roles"]);
const scalar = (value) =>
  value === null ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value)) ||
  (typeof value === "string" && value.length <= 10000);
function row(input, fields) {
  if (!object(input)) throw Error("Invalid public snapshot record");
  const output = {};
  for (const key of fields) {
    if (!Object.hasOwn(input, key)) continue;
    const value = input[key];
    if (arrayFields.has(key)) {
      if (
        !Array.isArray(value) ||
        value.length > 1000 ||
        value.some((item) => typeof item !== "string" || item.length > 1000)
      )
        throw Error("Invalid public snapshot field");
      output[key] = [...value];
    } else {
      if (!scalar(value)) throw Error("Invalid public snapshot field");
      output[key] = value;
    }
  }
  return output;
}
function publicAppearance(value) {
  if (!object(value) || value.version !== 1) return null;
  const result = { version: 1 };
  for (const key of ["defaultPalette", "defaultLayout", "defaultAppearance"]) {
    if (typeof value[key] !== "string" || value[key].length > 64) return null;
    result[key] = value[key];
  }
  for (const key of ["allowedPalettes", "allowedLayouts"]) {
    if (
      !Array.isArray(value[key]) ||
      value[key].length > 32 ||
      value[key].some((item) => typeof item !== "string" || item.length > 64)
    )
      return null;
    result[key] = [...value[key]];
  }
  for (const key of [
    "allowPaletteChoice",
    "allowLayoutChoice",
    "allowCustomAccent",
  ]) {
    if (typeof value[key] !== "boolean") return null;
    result[key] = value[key];
  }
  return result;
}

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
  const data = {};
  for (const [collection, fields] of Object.entries(schemas)) {
    const values = input.data[collection] ?? [];
    if (!Array.isArray(values) || values.length > 10000)
      throw Error("Invalid public release collection");
    data[collection] = values.map((value) => row(value, fields));
    if (
      [
        "groups",
        "subjects",
        "teachers",
        "rooms",
        "lessons",
        "tasks",
        "announcements",
      ].includes(collection) &&
      data[collection].some(
        (value) => typeof value.id !== "string" || !value.id,
      )
    )
      throw Error("Invalid public record identity");
    if (
      ["groups", "subjects", "teachers", "rooms"].includes(collection) &&
      data[collection].some(
        (value) => typeof value.name !== "string" || !value.name,
      )
    )
      throw Error("Invalid public catalogue label");
  }
  for (const key of ["validFrom", "validUntil"])
    if (
      typeof input.data[key] === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(input.data[key])
    )
      data[key] = input.data[key];
  const appearance = publicAppearance(input.data.siteSettings?.appearance);
  if (appearance) data.siteSettings = { appearance };
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
export function guardInitialChoice(document = globalThis.document) {
  const form = document?.querySelector?.("[data-initial-choice]");
  if (!form) return;
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
    event.preventDefault();
    form.dataset.touched = "true";
    form.dataset.submitRequested = "true";
    send.disabled = true;
  });
  update();
}

export function readInitialChoice(document = globalThis.document) {
  const form = document?.querySelector?.("[data-initial-choice]");
  if (!form) return null;
  const search = form.querySelector("[data-choice-search]");
  const group = form.querySelector('[name="g"]');
  const subgroup = form.querySelector('[name="subgroup"]');
  return {
    groupId: group.value,
    subgroup: subgroup.value,
    search: search.value,
    touched: form.dataset.touched === "true",
    submitRequested: form.dataset.submitRequested === "true",
    focus:
      document.activeElement === search
        ? "search"
        : document.activeElement === group
          ? "group"
          : document.activeElement === subgroup
            ? "subgroup"
            : "",
    selectionStart: search.selectionStart,
    selectionEnd: search.selectionEnd,
  };
}
