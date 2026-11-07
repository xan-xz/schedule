import * as storage from "./storage.mjs";

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const personal = (value) =>
  Array.isArray(value) &&
  value.every(
    (item) =>
      item &&
      typeof item === "object" &&
      typeof item.id === "string" &&
      item.id &&
      typeof item.title === "string",
  );
const statuses = (value) =>
  value && Object.prototype.toString.call(value) === "[object Object]";
const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : statuses(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable(value[key])]),
        )
      : value;
const completedCheckpoint = (value) =>
  value?.complete === true &&
  typeof value.signature === "string" &&
  [value.seenPersonalIds, value.seenProgressIds].every(
    (ids) => Array.isArray(ids) && ids.every((id) => typeof id === "string"),
  );
async function verifiedUpdate(store, key, transform, fallback) {
  const result = await store.update(key, transform, fallback);
  if (!result.persisted || !(await store.persisted(key, result.value)))
    throw Error("Persistent migration unavailable");
  return result.value;
}
async function archive(store, key, copy) {
  return verifiedUpdate(
    store,
    key,
    (current) => {
      if (!current || current.version !== 1 || !Array.isArray(current.copies))
        throw Error("Unrecognized recovery copy");
      return {
        ...current,
        version: 1,
        copies: current.copies.some((item) => same(item, copy))
          ? current.copies
          : [...current.copies, copy],
      };
    },
    { version: 1, copies: [] },
  );
}

/** Personal entries were typed by the user even in a retired context. Keep a
 * durable recovery copy, merge into the canonical scope, and verify readback
 * before removing the old key. Shared fixture datasets are never copied. */
export async function migrateRetiredPersonal(
  config,
  store = storage,
  browserStorage,
  locks = globalThis.navigator?.locks,
) {
  try {
    if (browserStorage === undefined)
      try {
        browserStorage = globalThis.localStorage;
      } catch {
        browserStorage = null;
      }
    if (!locks?.request) {
      const keys = await store.keys();
      const hasSource = keys.some((key) =>
        (config.personalMigrations || []).some(
          (item) =>
            key.startsWith(item.personalFrom) ||
            key.startsWith(item.statusesFrom),
        ),
      );
      let hasCompletions = false;
      for (let index = 0; index < (browserStorage?.length || 0); index++)
        if (
          (config.legacyCompletionPrefixes || []).some((prefix) =>
            browserStorage.key(index)?.startsWith(prefix),
          )
        )
          hasCompletions = true;
      return { ok: !hasSource && !hasCompletions, migrated: false };
    }
    return await locks.request(
      "uniflow-personal-retirement-v1",
      { mode: "exclusive" },
      () => migrateLocked(config, store, browserStorage),
    );
  } catch {
    return { ok: false, migrated: false };
  }
}

async function migrateLocked(config, store, browserStorage) {
  let migrated = false;
  try {
    const completionRows = [];
    const completed = new Set();
    for (let index = 0; index < (browserStorage?.length || 0); index++) {
      const key = browserStorage.key(index);
      if (
        !(config.legacyCompletionPrefixes || []).some((prefix) =>
          key?.startsWith(prefix),
        )
      )
        continue;
      const value = browserStorage.getItem(key);
      completionRows.push({ key, value });
      try {
        const ids = JSON.parse(value);
        if (Array.isArray(ids))
          for (const id of ids) if (typeof id === "string") completed.add(id);
      } catch {
        /*unknown content remains in its recovery copy*/
      }
    }
    if (completionRows.length)
      await archive(
        store,
        "personal-history:live:completion-lists",
        completionRows,
      );
    const keys = await store.keys();
    for (const migration of config.personalMigrations || []) {
      const scopes = new Set(
        keys.flatMap((key) =>
          key.startsWith(migration.personalFrom)
            ? [key.slice(migration.personalFrom.length)]
            : key.startsWith(migration.statusesFrom)
              ? [key.slice(migration.statusesFrom.length)]
              : completionRows.length && key.startsWith("personal:live:")
                ? [key.slice("personal:live:".length)]
                : [],
        ),
      );
      for (const scope of scopes) {
        const personalKey = migration.personalFrom + scope,
          statusKey = migration.statusesFrom + scope;
        const sourcePersonal = await store.get(personalKey, null),
          sourceStatuses = await store.get(statusKey, null);
        if (
          sourcePersonal === null &&
          sourceStatuses === null &&
          !completionRows.length
        )
          continue;
        if (sourcePersonal !== null && !personal(sourcePersonal))
          throw Error("Unrecognized personal records");
        const historyKey = "personal-history:live:" + scope;
        const history = await store.get(historyKey, null);
        const savedCheckpoint =
          history?.processedSources?.[migration.personalFrom];
        const previous =
          completedCheckpoint(savedCheckpoint) &&
          (await store.persisted(historyKey, history))
            ? savedCheckpoint
            : null;
        const signature = JSON.stringify(
          stable({
            personal: sourcePersonal,
            statuses: sourceStatuses,
            completions: [...completionRows].sort((left, right) =>
              left.key.localeCompare(right.key),
            ),
          }),
        );
        if (previous?.signature === signature) continue;
        const seenPersonal = new Set(previous?.seenPersonalIds || []);
        const seenProgress = new Set(previous?.seenProgressIds || []);
        await archive(store, historyKey, {
          personal: sourcePersonal,
          statuses: sourceStatuses,
        });
        const conflicts = new Set();
        const targetPersonal = await verifiedUpdate(
          store,
          "personal:live:" + scope,
          (current) => {
            if (!personal(current))
              throw Error("Unrecognized canonical personal records");
            conflicts.clear();
            const byId = new Map(current.map((task) => [task.id, task]));
            for (const task of sourcePersonal || []) {
              if (!byId.has(task.id) && !seenPersonal.has(task.id))
                byId.set(task.id, task);
              else if (!same(byId.get(task.id), task)) conflicts.add(task.id);
            }
            return [...byId.values()];
          },
          [],
        );
        const humanIds = new Set(
          targetPersonal
            .map((task) => task.id)
            .filter((id) => !conflicts.has(id) && !seenProgress.has(id)),
        );
        const imported = new Map(
          [...completed]
            .filter((id) => humanIds.has(id))
            .map((id) => [id, "done"]),
        );
        for (const [id, value] of Object.entries(
          statuses(sourceStatuses) ? sourceStatuses : {},
        ))
          if (humanIds.has(id) && ["new", "progress", "done"].includes(value))
            imported.set(id, value);
        await verifiedUpdate(
          store,
          "statuses:live:" + scope,
          (current) => {
            if (!statuses(current))
              throw Error("Unrecognized canonical statuses");
            return { ...Object.fromEntries(imported), ...current };
          },
          {},
        );
        await verifiedUpdate(store, historyKey, (current) => {
          const latest = current?.processedSources?.[migration.personalFrom];
          return {
            ...current,
            processedSources: {
              ...current.processedSources,
              [migration.personalFrom]: {
                complete: true,
                signature,
                seenPersonalIds: [
                  ...new Set([
                    ...seenPersonal,
                    ...(completedCheckpoint(latest)
                      ? latest.seenPersonalIds
                      : []),
                    ...(sourcePersonal || []).map((task) => task.id),
                    ...targetPersonal.map((task) => task.id),
                  ]),
                ],
                seenProgressIds: [
                  ...new Set([
                    ...seenProgress,
                    ...(completedCheckpoint(latest)
                      ? latest.seenProgressIds
                      : []),
                    ...targetPersonal.map((task) => task.id),
                  ]),
                ],
              },
            },
          };
        });
        // A still-open older tab may have edited its records during migration.
        // Keep that changed source for the next attempt instead of deleting it.
        await store.deleteIfUnchanged([
          [personalKey, sourcePersonal],
          [statusKey, sourceStatuses],
        ]);
        migrated = true;
      }
    }
    // localStorage has no cross-tab compare-and-delete operation. Keep these
    // original lists as inactive recovery sources rather than racing an older
    // tab's last-moment update. Their unrelated IDs never become active.
    return { ok: true, migrated };
  } catch {
    return { ok: false, migrated };
  }
}
