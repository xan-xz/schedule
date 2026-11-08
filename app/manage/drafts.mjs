// Authored editor deltas only. Never pass API responses or session objects here.
const FORMAT = "uniflow-owner-draft-v1";
const DB = "uniflow-owner-drafts-v1";
const STORE = "drafts";
const fields = {
  groups: "id name subgroups specialty language code archivedAt deletedAt",
  subjects: "id name shortName color",
  teachers: "id name subjects",
  rooms: "id name capacity capacityEstimated building floor note",
  lessons:
    "id groupId subgroup subjectId teacherId roomId day start end week type endDayOffset validFrom validUntil sharedSessionId source",
  exceptions:
    "id lessonId date targetDate status start end roomId subjectId teacherId endDayOffset type note",
};
for (const key of Object.keys(fields)) fields[key] = fields[key].split(" ");
const properties = [
  "holidays",
  "validFrom",
  "validUntil",
  "siteSettings.appearance",
  "source",
  "sourceWarnings",
];
const clone = (value) => structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const plain = (value) =>
  value !== null && Object.getPrototypeOf(value) === Object.prototype;
const secret =
  /\b(?:ow1[arc]\.[a-f0-9]{64}|sb_secret_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/u;
function safeValue(value, depth = 0) {
  if (depth > 8) throw Error("Слишком сложные данные черновика.");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length <= 20000 && !secret.test(value))
    return value;
  if (Array.isArray(value) && value.length <= 3000)
    return value.map((item) => safeValue(item, depth + 1));
  throw Error(
    "Черновик содержит неподдерживаемые данные. Работа осталась в этой вкладке.",
  );
}
function projection(kind, value) {
  if (!plain(value)) throw Error("Неверная запись черновика.");
  return Object.fromEntries(
    fields[kind]
      .filter((key) => Object.hasOwn(value, key))
      .map((key) => [
        key,
        key === "source" ? sourceReference(value[key]) : safeValue(value[key]),
      ]),
  );
}
function selectedObject(value, allowed, nested = {}) {
  if (!plain(value) || Object.keys(value).some((key) => !allowed.includes(key)))
    throw Error(
      "Неизвестные служебные сведения не сохранены локально. Не закрывайте вкладку.",
    );
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      nested[key] ? nested[key](item) : safeValue(item),
    ]),
  );
}
function sourceReference(value) {
  if (value === null) return null;
  return selectedObject(
    value,
    [
      "sheet",
      "row",
      "dayCell",
      "timeCell",
      "subjectCell",
      "typeCell",
      "teacherCell",
      "roomCell",
      "raw",
      "partIndex",
      "teacherText",
      "roomText",
    ],
    {
      raw: (raw) =>
        selectedObject(raw, [
          "day",
          "time",
          "subject",
          "type",
          "teacher",
          "room",
        ]),
    },
  );
}
function property(data, path) {
  const [key, child] = path.split(".");
  const object = child ? data[key] : data;
  const name = child || key;
  if (!object || !Object.hasOwn(object, name)) return { present: false };
  const value = object[name];
  if (path === "source")
    return {
      present: true,
      value:
        value === null
          ? null
          : selectedObject(value, [
              "file",
              "repository",
              "blobSha",
              "importedAt",
              "sheets",
              "note",
            ]),
    };
  if (path === "sourceWarnings") {
    if (!Array.isArray(value) || value.length > 3000)
      throw Error("Неверные сведения источника.");
    return {
      present: true,
      value: value.map((item) =>
        selectedObject(
          item,
          ["code", "message", "groupName", "lessonIds", "source"],
          { source: sourceReference },
        ),
      ),
    };
  }
  if (path === "siteSettings.appearance") {
    const allowed = [
      "version",
      "defaultPalette",
      "defaultLayout",
      "defaultAppearance",
      "allowedPalettes",
      "allowedLayouts",
      "allowPaletteChoice",
      "allowLayoutChoice",
      "allowCustomAccent",
    ];
    if (
      !plain(value) ||
      Object.keys(value).some((key) => !allowed.includes(key))
    )
      throw Error("Неподдерживаемая политика оформления.");
    return {
      present: true,
      value: Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, safeValue(item)]),
      ),
    };
  }
  if (path === "holidays") {
    if (!Array.isArray(value)) throw Error("Неверный список каникул.");
    return {
      present: true,
      value: value.map((item) => {
        if (
          !plain(item) ||
          Object.keys(item).some(
            (key) => !["start", "end", "groupId", "note"].includes(key),
          )
        )
          throw Error("Неподдерживаемые сведения о каникулах.");
        return Object.fromEntries(
          Object.entries(item).map(([key, field]) => [key, safeValue(field)]),
        );
      }),
    };
  }
  return { present: true, value: safeValue(value) };
}
function applyProperty(data, path, next) {
  const [key, child] = path.split(".");
  const target = child ? (data[key] ||= {}) : data;
  if (next.present) target[child || key] = clone(next.value);
  else delete target[child || key];
}

/** The before image is a narrow comparison basis, never a private snapshot. */
export function catalogReplacementIntents(input = []) {
  if (!Array.isArray(input) || input.length > 100)
    throw Error("Слишком много замен справочника.");
  const result = input.map((item) => {
    if (
      !plain(item) ||
      Object.keys(item).some(
        (key) => !["entity", "id", "replacementId"].includes(key),
      ) ||
      !["groups", "subjects", "teachers", "rooms"].includes(item.entity) ||
      [item.id, item.replacementId].some(
        (id) =>
          typeof id !== "string" || !id || id.length > 100 || secret.test(id),
      ) ||
      item.id === item.replacementId
    )
      throw Error("Неверная замена справочника.");
    return {
      entity: item.entity,
      id: item.id,
      replacementId: item.replacementId,
    };
  });
  const sources = new Set(result.map((item) => item.entity + ":" + item.id));
  if (
    sources.size !== result.length ||
    result.some((item) => sources.has(item.entity + ":" + item.replacementId))
  )
    throw Error(
      "Цепочки замен не поддерживаются. Выберите конечную запись сразу.",
    );
  return result;
}

export function draftChanges(before, after, replacements = []) {
  const changes = [];
  for (const kind of Object.keys(fields)) {
    if (!Array.isArray(before[kind]) || !Array.isArray(after[kind]))
      throw Error("Неверный раздел расписания.");
    const previous = new Map(before[kind].map((row) => [row.id, row]));
    const next = new Map(after[kind].map((row) => [row.id, row]));
    if (
      previous.size !== before[kind].length ||
      next.size !== after[kind].length
    )
      throw Error("Повторяются ID черновика.");
    for (const id of new Set([...previous.keys(), ...next.keys()])) {
      const a = previous.get(id),
        b = next.get(id);
      if (equal(a, b)) continue;
      for (const key of new Set([
        ...Object.keys(a || {}),
        ...Object.keys(b || {}),
      ]))
        if (
          !fields[kind].includes(key) &&
          !(
            b === undefined &&
            ["groups", "subjects", "teachers", "rooms"].includes(kind)
          ) &&
          !(
            kind === "exceptions" &&
            ["before", "after", "actor", "createdAt", "updatedAt"].includes(key)
          ) &&
          !equal(a?.[key], b?.[key])
        )
          throw Error(
            "Эти дополнительные поля не поддерживают локальное восстановление. Не закрывайте вкладку.",
          );
      if (typeof id !== "string" || !id || id.length > 100)
        throw Error("Неверный ID черновика.");
      const old = a ? projection(kind, a) : null,
        value = b ? projection(kind, b) : null;
      if (!equal(old, value))
        changes.push({ kind, id, before: old, after: value });
    }
  }
  for (const path of properties) {
    const [key, child] = path.split(".");
    const a = child ? before[key] : before,
      b = child ? after[key] : after,
      name = child || key;
    if (
      Boolean(a && Object.hasOwn(a, name)) ===
        Boolean(b && Object.hasOwn(b, name)) &&
      equal(a?.[name], b?.[name])
    )
      continue;
    const old = property(before, path),
      next = property(after, path);
    if (!equal(old, next))
      changes.push({ kind: "property", path, before: old, after: next });
  }
  for (const item of catalogReplacementIntents(replacements))
    changes.push({ kind: "catalogReplacement", ...item });
  if (new TextEncoder().encode(JSON.stringify(changes)).byteLength > 1000000)
    throw Error(
      "Локальный черновик превышает 1 МБ. Работа осталась в этой вкладке.",
    );
  return changes;
}

function checkedChanges(input) {
  if (!Array.isArray(input) || input.length > 10000)
    throw Error("Неверный локальный черновик.");
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 1000000)
    throw Error("Локальный черновик превышает 1 МБ.");
  const seen = new Set();
  catalogReplacementIntents(
    input
      .filter((item) => item?.kind === "catalogReplacement")
      .map(({ kind: _kind, ...item }) => item),
  );
  return input.map((change) => {
    if (!plain(change)) throw Error("Неверное изменение черновика.");
    const key =
      change.kind === "property"
        ? change.path
        : change.kind + ":" + (change.entity || "") + ":" + change.id;
    if (seen.has(key)) throw Error("Повторяется изменение черновика.");
    seen.add(key);
    if (change.kind === "catalogReplacement") {
      const { kind: _kind, ...item } = change;
      return {
        kind: "catalogReplacement",
        ...catalogReplacementIntents([item])[0],
      };
    }
    if (change.kind === "property") {
      if (!properties.includes(change.path))
        throw Error("Раздел не разрешён для локального черновика.");
      const normalize = (value) => {
        if (!plain(value) || typeof value.present !== "boolean")
          throw Error("Неверное значение черновика.");
        if (!value.present) return { present: false };
        const data = {};
        applyProperty(data, change.path, value);
        return property(data, change.path);
      };
      return {
        kind: "property",
        path: change.path,
        before: normalize(change.before),
        after: normalize(change.after),
      };
    }
    if (
      !Object.hasOwn(fields, change.kind) ||
      typeof change.id !== "string" ||
      !change.id ||
      change.id.length > 100
    )
      throw Error("Раздел не разрешён для локального черновика.");
    const normalize = (row) => {
      if (row === null) return null;
      if (
        !plain(row) ||
        Object.keys(row).some((key) => !fields[change.kind].includes(key)) ||
        row.id !== change.id
      )
        throw Error("Неподдерживаемая запись локального черновика.");
      return projection(change.kind, row);
    };
    return {
      kind: change.kind,
      id: change.id,
      before: normalize(change.before),
      after: normalize(change.after),
    };
  });
}

/** Rebase only authored fields, preserving fresh server metadata and archives. */
export function recoverChanges(server, input, { force = false } = {}) {
  const data = clone(server),
    conflicts = [],
    catalogReplacements = [];
  for (const change of checkedChanges(input)) {
    if (change.kind === "catalogReplacement") {
      const { kind: _kind, ...item } = change;
      catalogReplacements.push(item);
      continue;
    }
    if (change.kind === "property") {
      const current = property(data, change.path);
      if (!equal(current, change.before) && !equal(current, change.after))
        conflicts.push({
          label: change.path,
          before: change.before,
          current,
          after: change.after,
        });
      if (
        force ||
        equal(current, change.before) ||
        equal(current, change.after)
      )
        applyProperty(data, change.path, change.after);
      continue;
    }
    const rows = data[change.kind];
    if (!Array.isArray(rows))
      throw Error("Раздел расписания больше недоступен.");
    const index = rows.findIndex((row) => row.id === change.id),
      current = index < 0 ? null : projection(change.kind, rows[index]);
    const changed =
      change.before && change.after
        ? fields[change.kind].filter(
            (key) =>
              !equal(change.before[key], change.after[key]) ||
              Object.hasOwn(change.before, key) !==
                Object.hasOwn(change.after, key),
          )
        : fields[change.kind];
    const matches =
      current !== null &&
      change.before !== null &&
      changed.every(
        (key) =>
          equal(current[key], change.before[key]) &&
          Object.hasOwn(current, key) === Object.hasOwn(change.before, key),
      );
    const same = equal(current, change.after);
    const compatible =
      change.before === null
        ? current === null || same
        : change.after === null
          ? equal(current, change.before) || current === null
          : matches || same;
    if (!compatible)
      conflicts.push({
        label: change.kind + " · " + change.id,
        before: change.before,
        current,
        after: change.after,
      });
    if (!force && !compatible) continue;
    if (change.after === null) {
      if (index >= 0) rows.splice(index, 1);
    } else if (index < 0) rows.push(clone(change.after));
    else {
      for (const key of changed) {
        if (Object.hasOwn(change.after, key))
          rows[index][key] = clone(change.after[key]);
        else delete rows[index][key];
      }
    }
  }
  return { data, conflicts, catalogReplacements };
}

function ownerKey(owner, scope) {
  if (
    typeof owner !== "string" ||
    !owner ||
    owner.length > 300 ||
    scope !== "workspace" ||
    secret.test(owner)
  )
    throw Error("Нет подтверждённого владельца черновика.");
  return JSON.stringify([owner, scope]);
}
function recordInput(input) {
  if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0)
    throw Error("Неизвестна исходная версия черновика.");
  return {
    baseRevision: input.baseRevision,
    changes: checkedChanges(input.changes),
  };
}
const storageError = () =>
  Error(
    "Локальное сохранение недоступно. Не закрывайте вкладку; освободите место и нажмите «Повторить сохранение».",
  );

export function createDraftJournal({
  indexedDB: idb = globalThis.indexedDB,
  now = () => Date.now(),
  uuid = () => crypto.randomUUID(),
} = {}) {
  let opening;
  function database() {
    if (!idb) return Promise.reject(storageError());
    return (opening ||= new Promise((resolve, reject) => {
      let request;
      let expired = false;
      try {
        request = idb.open(DB, 1);
      } catch {
        reject(storageError());
        return;
      }
      const timer = setTimeout(() => {
        expired = true;
        reject(storageError());
      }, 1200);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => {
        clearTimeout(timer);
        if (expired) request.result.close();
        else {
          request.result.onversionchange = () => request.result.close();
          resolve(request.result);
        }
      };
      request.onerror = request.onblocked = () => {
        clearTimeout(timer);
        expired = true;
        reject(storageError());
      };
    }).catch((error) => {
      opening = null;
      throw error;
    }));
  }
  async function transaction(mode, action) {
    const db = await database();
    return new Promise((resolve, reject) => {
      let tx, result, failure;
      try {
        tx = db.transaction(STORE, mode, { durability: "strict" });
        const timer = setTimeout(() => {
          try {
            tx.abort();
          } catch {
            /*closed*/
          }
          reject(storageError());
        }, 1200);
        tx.oncomplete = () => {
          clearTimeout(timer);
          resolve(result);
        };
        tx.onerror = tx.onabort = () => {
          clearTimeout(timer);
          reject(failure || storageError());
        };
        action(
          tx.objectStore(STORE),
          (value) => {
            result = value;
          },
          (error) => {
            failure = error;
            tx.abort();
          },
        );
      } catch {
        reject(storageError());
      }
    });
  }
  const valid = (record, key) => {
    if (
      record?.format !== FORMAT ||
      record.ownerKey !== key ||
      !["active", "archived"].includes(record.status) ||
      !Number.isSafeInteger(record.generation) ||
      record.generation < 1
    )
      throw Error(
        "Локальная копия повреждена или принадлежит другому владельцу.",
      );
    const content = recordInput(record);
    if (
      Object.keys(record).some(
        (key) =>
          ![
            "format",
            "ownerKey",
            "id",
            "generation",
            "status",
            "createdAt",
            "updatedAt",
            "baseRevision",
            "changes",
            "forkedFrom",
            "reason",
          ].includes(key),
      ) ||
      typeof record.id !== "string" ||
      !record.id ||
      !Number.isFinite(record.createdAt) ||
      !Number.isFinite(record.updatedAt)
    )
      throw Error("Неподдерживаемая локальная копия.");
    return { ...record, ...content };
  };
  return {
    async list(owner, scope = "workspace") {
      const key = ownerKey(owner, scope);
      return transaction("readonly", (store, done, fail) => {
        const request = store.getAll();
        request.onsuccess = () => {
          try {
            done(
              request.result
                .filter((record) => record.ownerKey === key)
                .map((record) => valid(record, key))
                .sort((a, b) => b.updatedAt - a.updatedAt),
            );
          } catch (error) {
            fail(error);
          }
        };
      });
    },
    async save(
      owner,
      { id, generation = 0, baseRevision, changes },
      scope = "workspace",
    ) {
      const key = ownerKey(owner, scope),
        content = recordInput({ baseRevision, changes });
      if (
        typeof id !== "string" ||
        !id ||
        !Number.isSafeInteger(generation) ||
        generation < 0
      )
        throw Error("Неверная версия локального черновика.");
      return transaction("readwrite", (store, done, fail) => {
        const request = store.get(id);
        request.onsuccess = () => {
          try {
            const previous = request.result;
            if (previous) valid(previous, key);
            const forked = previous
              ? previous.generation !== generation ||
                previous.status !== "active"
              : generation !== 0;
            const record = {
              format: FORMAT,
              ownerKey: key,
              id: forked ? uuid() : id,
              generation: forked ? 1 : generation + 1,
              status: "active",
              createdAt: forked ? now() : previous?.createdAt || now(),
              updatedAt: now(),
              ...content,
              ...(forked
                ? { forkedFrom: id }
                : previous?.forkedFrom
                  ? { forkedFrom: previous.forkedFrom }
                  : {}),
            };
            if (previous && !forked) store.put(record, record.id);
            else store.add(record, record.id);
            done({ record, forked });
          } catch (error) {
            fail(error);
          }
        };
      });
    },
    async archive(owner, record, reason, scope = "workspace") {
      const key = ownerKey(owner, scope);
      if (!["published", "discarded", "recovered", "rollback"].includes(reason))
        throw Error("Неизвестная причина архивации.");
      return transaction("readwrite", (store, done, fail) => {
        const request = store.get(record.id);
        request.onsuccess = () => {
          try {
            const current = valid(request.result, key);
            if (current.generation !== record.generation)
              throw Error(
                "Черновик обновлён в другой вкладке. Его новая версия сохранена.",
              );
            const archived = {
              ...current,
              generation: current.generation + 1,
              status: "archived",
              reason,
              updatedAt: now(),
            };
            store.put(archived, archived.id);
            done(archived);
          } catch (error) {
            fail(error);
          }
        };
      });
    },
  };
}
