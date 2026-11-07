// Lossless, deterministic bridge for the private relational store. This module
// does not connect to a database, grant permissions, or repair source records.
export const NORMALIZED_FORMAT = "uniflow-normalized-v1";
export const COLLECTION_TABLES = Object.freeze({
  groups: "groups",
  subjects: "subjects",
  rooms: "rooms",
  teachers: "teachers",
  lessons: "lessons",
  exceptions: "overrides",
  tasks: "tasks",
  announcements: "announcements",
  holidays: "holidays",
  history: "audit_log",
});
export const REQUIRED_ID_COLLECTIONS = Object.freeze([
  "groups",
  "teachers",
  "subjects",
  "rooms",
  "lessons",
  "tasks",
  "announcements",
  "requests",
]);
const requiredIds = new Set(REQUIRED_ID_COLLECTIONS);
const optionalIds = new Set([
  "exceptions",
  "attendance",
  "holidays",
  "history",
]);
const groupOwned = new Set([
  "lessons",
  "exceptions",
  "tasks",
  "announcements",
  "requests",
  "attendance",
  "holidays",
]);
const catalogCollections = new Set([
  "groups",
  "subgroups",
  "subjects",
  "rooms",
  "teachers",
  "timeSlots",
  "lessonTypes",
  "siteSettings",
]);
const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isId = (value) => typeof value === "string" && value.length > 0;
const own = (object, key) => Object.hasOwn(object, key);
function invalid(message, collection) {
  throw Object.assign(new Error(message), {
    code: "NORMALIZED_INVALID",
    ...(collection ? { collection } : {}),
  });
}

/** Reject non-JSON JavaScript values instead of silently dropping/coercing them. */
function assertJson(value, ancestors = new Set()) {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      invalid("Non-finite number cannot be stored losslessly");
    return;
  }
  if (typeof value !== "object") invalid("Only JSON values can be normalized");
  if (ancestors.has(value)) invalid("Cyclic values cannot be normalized");
  if (
    !Array.isArray(value) &&
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    invalid("Only plain JSON objects can be normalized");
  if (Object.getOwnPropertySymbols(value).length)
    invalid("Symbol properties cannot be stored losslessly");
  ancestors.add(value);
  const keys = Object.keys(value);
  if (
    Object.getOwnPropertyNames(value).length !==
    keys.length + (Array.isArray(value) ? 1 : 0)
  )
    invalid("Non-enumerable properties cannot be stored losslessly");
  if (
    Array.isArray(value) &&
    (keys.length !== value.length ||
      keys.some((key, index) => String(index) !== key))
  )
    invalid(
      "Sparse arrays or extra array properties cannot be stored losslessly",
    );
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!own(descriptor, "value"))
      invalid("Accessor properties are not JSON data");
    assertJson(descriptor.value, ancestors);
  }
  ancestors.delete(value);
}
const copyJson = (value) => {
  assertJson(value);
  return structuredClone(value);
};
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (isObject(value))
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function canonicalJson(value) {
  assertJson(value);
  return canonical(value);
}
export async function platformChecksum(data) {
  const bytes = new TextEncoder().encode(canonicalJson(data));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
const tuple = (...parts) => canonical(parts);
const storage = (collection) =>
  own(COLLECTION_TABLES, collection)
    ? COLLECTION_TABLES[collection]
    : "extension_records";
function rowIdentity(collection, payload, position) {
  if (requiredIds.has(collection)) {
    if (!isObject(payload) || !isId(payload.id))
      invalid("Entity requires a nonempty original ID", collection);
    return payload.id;
  }
  // Namespaces prevent a literal ID from colliding with a composite/position key.
  if (optionalIds.has(collection) && isObject(payload) && isId(payload.id))
    return tuple("id", payload.id);
  if (
    collection === "exceptions" &&
    isObject(payload) &&
    isId(payload.lessonId) &&
    isId(payload.date)
  )
    return tuple("lesson-date", payload.lessonId, payload.date);
  if (
    collection === "attendance" &&
    isObject(payload) &&
    isId(payload.lessonId) &&
    isId(payload.date) &&
    isId(payload.studentId)
  )
    return tuple(
      "attendance",
      payload.lessonId,
      payload.date,
      payload.studentId,
    );
  return tuple("position", position);
}
function indexesFor(collection, payload, lessons) {
  if (
    !isObject(payload) ||
    !(own(COLLECTION_TABLES, collection) || groupOwned.has(collection))
  )
    return {};
  const indexes = {};
  for (const field of [
    "groupId",
    "lessonId",
    "subjectId",
    "teacherId",
    "roomId",
    "studentId",
    "subgroup",
    "day",
    "start",
    "end",
    "endDayOffset",
    "week",
    "date",
    "targetDate",
    "sharedSessionId",
  ])
    if (own(payload, field)) indexes[field] = structuredClone(payload[field]);
  if (collection === "groups" && isId(payload.id)) indexes.groupId = payload.id;
  if (["exceptions", "requests", "attendance"].includes(collection)) {
    const lesson = lessons.get(payload.lessonId);
    if (lesson && isId(lesson.groupId)) indexes.groupId = lesson.groupId;
  }
  if (
    collection === "lessons" &&
    typeof payload.start === "string" &&
    typeof payload.end === "string"
  )
    indexes.timeSlotKey = tuple(
      payload.start,
      payload.end,
      payload.endDayOffset ?? 0,
    );
  if (collection === "lessons" && typeof payload.type === "string")
    indexes.lessonTypeKey = payload.type;
  return indexes;
}
function derivedCatalogs(data) {
  const subgroups = [];
  for (const group of Array.isArray(data.groups) ? data.groups : []) {
    if (!isObject(group) || !isId(group.id) || !Array.isArray(group.subgroups))
      continue;
    const names = new Set();
    group.subgroups.forEach((value, position) => {
      // Preserve duplicate/unknown subgroup values in the group payload. Only
      // unambiguous string labels can serve as a relational lookup projection.
      if (typeof value !== "string" || names.has(value)) return;
      names.add(value);
      subgroups.push({
        collection: "@derived/subgroups",
        table: "subgroups",
        rowKey: tuple(group.id, value),
        position,
        groupId: group.id,
        name: value,
        payload: value,
      });
    });
  }
  const slots = new Map(),
    types = new Map();
  for (const lesson of Array.isArray(data.lessons) ? data.lessons : []) {
    if (!isObject(lesson)) continue;
    if (typeof lesson.start === "string" && typeof lesson.end === "string") {
      const offset = lesson.endDayOffset ?? 0;
      const key = tuple(lesson.start, lesson.end, offset);
      if (!slots.has(key))
        slots.set(key, {
          collection: "@derived/timeSlots",
          table: "time_slots",
          rowKey: key,
          payload: {
            start: lesson.start,
            end: lesson.end,
            endDayOffset: offset,
          },
        });
    }
    if (typeof lesson.type === "string" && !types.has(lesson.type))
      types.set(lesson.type, {
        collection: "@derived/lessonTypes",
        table: "lesson_types",
        rowKey: lesson.type,
        payload: { name: lesson.type },
      });
  }
  return {
    subgroups,
    timeSlots: [...slots.values()]
      .sort((a, b) => (a.rowKey < b.rowKey ? -1 : a.rowKey > b.rowKey ? 1 : 0))
      .map((row, position) => ({ ...row, position })),
    lessonTypes: [...types.values()]
      .sort((a, b) => (a.rowKey < b.rowKey ? -1 : a.rowKey > b.rowKey ? 1 : 0))
      .map((row, position) => ({ ...row, position })),
  };
}

/** Entity and group revisions begin independently at 1. sourceRevision records
 * the legacy snapshot's revision; it is not a global write lock for new edits.
 * SQL should CAS changed entity revisions plus affected group revisions, and a
 * separate catalog revision for global dictionary changes. groupIds are lookup
 * metadata, never a substitute for server authorization.
 */
export function decomposePlatform(
  input,
  { sourceRevision = 1, entityRevision = 1 } = {},
) {
  if (!isObject(input)) invalid("Platform must be a JSON object");
  if (
    !Number.isSafeInteger(sourceRevision) ||
    sourceRevision < 1 ||
    !Number.isSafeInteger(entityRevision) ||
    entityRevision < 1
  )
    invalid("Revision must be a positive safe integer");
  const data = copyJson(input);
  const rootKeys = Object.keys(data),
    rootPayload = {},
    collections = [],
    records = [];
  const lessons = new Map(
    (Array.isArray(data.lessons) ? data.lessons : [])
      .filter(isObject)
      .map((lesson) => [lesson.id, lesson]),
  );
  for (const collection of rootKeys) {
    const value = data[collection];
    if (!Array.isArray(value)) {
      Object.defineProperty(rootPayload, collection, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      continue;
    }
    const table = storage(collection),
      keys = new Set();
    collections.push({
      name: collection,
      table,
      identity: requiredIds.has(collection) ? "id" : "mixed",
      count: value.length,
    });
    value.forEach((payload, position) => {
      const rowKey = rowIdentity(collection, payload, position);
      if (keys.has(rowKey))
        invalid("Duplicate entity ID or natural key", collection);
      keys.add(rowKey);
      const indexes = indexesFor(collection, payload, lessons);
      // Unknown extension objects may use groupId for unrelated domains. Scope
      // only the known model; provenance and future payload remain opaque.
      const grouped = collection === "groups" || groupOwned.has(collection);
      const groupIds =
        grouped && isId(indexes.groupId) ? [indexes.groupId] : [];
      records.push({
        collection,
        table,
        rowKey,
        sourceId: isObject(payload) && isId(payload.id) ? payload.id : null,
        position,
        revision: entityRevision,
        groupIds,
        indexes,
        payload,
      });
    });
  }
  return {
    format: NORMALIZED_FORMAT,
    sourceRevision,
    rootKeys,
    rootPayload,
    collections,
    records,
    derived: derivedCatalogs(data),
  };
}

/** SQL row order is unspecified. Reconstruct by explicit position, preserving
 * absent fields, null, empty arrays, duplicate values and every payload field.
 */
export function recomposePlatform(input) {
  const snapshot = copyJson(input);
  if (
    snapshot?.format !== NORMALIZED_FORMAT ||
    !Array.isArray(snapshot.rootKeys) ||
    !isObject(snapshot.rootPayload) ||
    !Array.isArray(snapshot.collections) ||
    !Array.isArray(snapshot.records)
  )
    invalid("Unsupported normalized document");
  const rootKeys = new Set(snapshot.rootKeys);
  if (
    rootKeys.size !== snapshot.rootKeys.length ||
    snapshot.rootKeys.some((key) => typeof key !== "string")
  )
    invalid("Duplicate or invalid root key");
  const sections = new Map();
  for (const collection of snapshot.collections) {
    if (
      !isObject(collection) ||
      typeof collection.name !== "string" ||
      sections.has(collection.name) ||
      !rootKeys.has(collection.name) ||
      own(snapshot.rootPayload, collection.name) ||
      collection.table !== storage(collection.name) ||
      !Number.isSafeInteger(collection.count) ||
      collection.count < 0
    )
      invalid("Invalid collection manifest");
    sections.set(collection.name, {
      manifest: collection,
      rows: [],
      keys: new Set(),
      positions: new Set(),
    });
  }
  for (const row of snapshot.records) {
    if (!isObject(row)) invalid("Normalized row must be an object");
    const section = sections.get(row.collection);
    if (
      !section ||
      row.table !== section.manifest.table ||
      typeof row.rowKey !== "string" ||
      !Number.isSafeInteger(row.position) ||
      row.position < 0 ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1 ||
      section.keys.has(row.rowKey) ||
      section.positions.has(row.position) ||
      !own(row, "payload")
    )
      invalid("Invalid, duplicate or unmanifested row", row.collection);
    if (row.rowKey !== rowIdentity(row.collection, row.payload, row.position))
      invalid(
        "Row identity no longer matches its source payload",
        row.collection,
      );
    section.keys.add(row.rowKey);
    section.positions.add(row.position);
    section.rows.push(row);
  }
  if (
    Object.keys(snapshot.rootPayload).some(
      (key) => !rootKeys.has(key) || Array.isArray(snapshot.rootPayload[key]),
    )
  )
    invalid("Root payload contains unmanifested data");
  const result = {};
  for (const key of snapshot.rootKeys) {
    const section = sections.get(key);
    let value;
    if (section) {
      if (section.rows.length !== section.manifest.count)
        invalid("Collection count does not match its rows", key);
      value = section.rows
        .sort((a, b) => a.position - b.position)
        .map((row) => row.payload);
    } else {
      if (!own(snapshot.rootPayload, key))
        invalid("Missing root payload value");
      value = snapshot.rootPayload[key];
    }
    Object.defineProperty(result, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

/** Scope compatibility check for legacy-model edits. Full model validation is
 * required explicitly so this helper cannot be mistaken for authorization or
 * bypass cross-group room/teacher collisions and original conflict fingerprints.
 */
export function validateGroupScopedEdit(
  beforeInput,
  afterInput,
  groupId,
  { validateModel } = {},
) {
  if (!isId(groupId) || typeof validateModel !== "function")
    invalid("Group scope and full model validator are required");
  const before =
    beforeInput?.format === NORMALIZED_FORMAT
      ? recomposePlatform(beforeInput)
      : copyJson(beforeInput);
  const after =
    afterInput?.format === NORMALIZED_FORMAT
      ? recomposePlatform(afterInput)
      : copyJson(afterInput);
  if (
    !before.groups?.some((group) => group.id === groupId) ||
    !after.groups?.some((group) => group.id === groupId)
  )
    invalid("Group scope does not exist");
  validateModel(before);
  validateModel(after);
  const left = decomposePlatform(before),
    right = decomposePlatform(after);
  if (
    canonical(left.rootPayload) !== canonical(right.rootPayload) ||
    canonical(left.collections.map((row) => row.name)) !==
      canonical(right.collections.map((row) => row.name))
  )
    invalid("Group edit changed document metadata");
  const changed = [];
  const leftSections = new Map(
    left.collections.map((section) => [section.name, []]),
  );
  const rightSections = new Map(
    right.collections.map((section) => [section.name, []]),
  );
  for (const row of left.records) leftSections.get(row.collection).push(row);
  for (const row of right.records) rightSections.get(row.collection).push(row);
  for (const [collection, oldRows] of leftSections) {
    const newRows = rightSections.get(collection),
      oldMap = new Map(oldRows.map((row) => [row.rowKey, row])),
      newMap = new Map(newRows.map((row) => [row.rowKey, row]));
    const allKeys = new Set([...oldMap.keys(), ...newMap.keys()]);
    for (const key of allKeys) {
      const oldRow = oldMap.get(key),
        newRow = newMap.get(key);
      if (
        oldRow &&
        newRow &&
        canonical(oldRow.payload) === canonical(newRow.payload)
      )
        continue;
      if (collection === "history" && !oldRow && newRow) continue; // append-only audit entries
      const scopes = new Set([
        ...(oldRow?.groupIds || []),
        ...(newRow?.groupIds || []),
      ]);
      if (
        !groupOwned.has(collection) ||
        scopes.size !== 1 ||
        !scopes.has(groupId)
      )
        invalid(
          "Group edit touched another group or global record",
          collection,
        );
      changed.push({ collection, rowKey: key, groupIds: [...scopes] });
    }
    const outside = (rows) =>
      rows
        .filter(
          (row) =>
            !(
              groupOwned.has(collection) &&
              row.groupIds.length === 1 &&
              row.groupIds[0] === groupId
            ),
        )
        .filter((row) => collection !== "history" || oldMap.has(row.rowKey))
        .map((row) => row.rowKey);
    if (canonical(outside(oldRows)) !== canonical(outside(newRows)))
      invalid("Group edit reordered outside records", collection);
  }
  return {
    groupId,
    changed,
    catalogChanged: changed.some((row) =>
      catalogCollections.has(row.collection),
    ),
  };
}
