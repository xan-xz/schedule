import { validateAppearancePolicy } from "./appearance-policy.mjs";

// Closed public DTO fields. Owner records remain untouched; room notes and any
// unknown present/future metadata are deliberately absent from this boundary.
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
    "deleted",
    "deletedAt",
    "deleted_at",
  ],
  subjects: ["id", "name", "shortName", "color"],
  teachers: ["id", "name", "subjects"],
  rooms: ["id", "name", "capacity", "capacityEstimated", "building", "floor"],
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
    "dueTime",
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
const optionalCatalogLabels = {
  subjects: { shortName: 60 },
  rooms: { building: 120, floor: 40 },
};
const scalar = (value) =>
  value === null ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value)) ||
  (typeof value === "string" && value.length <= 10000);
function row(input, fields, collection) {
  if (!object(input)) throw Error("Invalid public snapshot record");
  const output = {};
  for (const key of fields) {
    if (!Object.hasOwn(input, key)) continue;
    const value = input[key];
    const limit = optionalCatalogLabels[collection]?.[key];
    if (
      limit &&
      value !== null &&
      (typeof value !== "string" || value.length > limit)
    )
      continue;
    if (
      collection === "groups" &&
      key === "deleted" &&
      typeof value !== "boolean"
    )
      throw Error("Invalid public lifecycle field");
    if (
      collection === "tasks" &&
      key === "dueTime" &&
      value !== null &&
      (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))
    )
      throw Error("Invalid public deadline time");
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

const catalogs = ["groups", "subjects", "teachers", "rooms"];
function collection(input, collection) {
  const values = input[collection] ?? [];
  if (!Array.isArray(values) || values.length > 10000)
    throw Error("Invalid public release collection");
  const result = values.map((value) =>
    row(value, schemas[collection], collection),
  );
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
    result.some((value) => typeof value.id !== "string" || !value.id)
  )
    throw Error("Invalid public record identity");
  if (
    ["groups", "subjects", "teachers", "rooms"].includes(collection) &&
    result.some((value) => typeof value.name !== "string" || !value.name)
  )
    throw Error("Invalid public catalogue label");

  return result;
}
export function projectPublicCatalogs(input) {
  if (!object(input)) throw Error("Invalid public data");
  return Object.fromEntries(
    catalogs.map((name) => [name, collection(input, name)]),
  );
}
function publicAppearance(value) {
  try {
    return validateAppearancePolicy(value);
  } catch {
    return null;
  }
}
/** Public union of student/guest scopes, never an owner backup or identity DTO. */
export function projectPublicData(input) {
  if (!object(input)) throw Error("Invalid public data");
  const data = Object.fromEntries(
    Object.keys(schemas).map((name) => [name, collection(input, name)]),
  );
  // A released snapshot is the union of schedules guests can choose. Keep the
  // exact student/guest audience rule from the server, before bytes enter HTML
  // or the external public fallback; client-side filtering would be too late.
  const groupIds = new Set(data.groups.map((group) => group.id));
  data.tasks = data.tasks.filter((item) => groupIds.has(item.groupId));
  data.announcements = data.announcements.filter(
    (item) =>
      item.roles?.includes("student") &&
      ((!item.groupId && !item.teacherId) || groupIds.has(item.groupId)),
  );
  for (const key of ["validFrom", "validUntil"])
    if (
      typeof input[key] === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(input[key])
    )
      data[key] = input[key];
  const appearance = publicAppearance(input.siteSettings?.appearance);
  if (appearance) data.siteSettings = { appearance };

  data.requests = [];
  data.attendance = [];
  data.history = [];
  return data;
}
