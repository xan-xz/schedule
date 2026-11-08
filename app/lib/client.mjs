import * as storage from "./storage.mjs";
const API = "https://anfwdrcazwbkkayczkxg.supabase.co";
const KEY = "sb_publishable_NkbuSbf1LxiCGvgz48fPjg_aVVwDU_G";
export function readPreference(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value == null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}
export function writePreference(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
/** Read the former public completion list once without changing its stored value. */
export function legacyTaskStatuses() {
  const value = readPreference("uf.tasks.live.guest", []);
  return Object.fromEntries(
    (Array.isArray(value) ? value : [])
      .filter((id) => typeof id === "string" && id.length > 0)
      .map((id) => [id, "done"]),
  );
}

/** Only the latest still-current scope may reach the UI. Missing progress is
 * initialized atomically: migration or another tab may have filled it after
 * the initial read returned null. Capture legacy input before any awaits. */
export function createPersonalLoader(store = storage) {
  let sequence = 0;
  return async function load({
    tasksKey,
    statusesKey,
    isCurrent = () => true,
    legacy = legacyTaskStatuses,
  }) {
    const request = ++sequence,
      initial = legacy();
    const current = () => request === sequence && isCurrent();
    const [tasks, storedStatuses] = await Promise.all([
      store.get(tasksKey, []),
      store.get(statusesKey, null),
    ]);
    if (!current()) return null;
    let statuses = storedStatuses;
    if (statuses === null) {
      const result = await store.update(
        statusesKey,
        (value) => value ?? initial,
        null,
      );
      statuses = result.value;
    }
    return current() ? { tasks, statuses } : null;
  };
}
export function initialSettings() {
  let legacy = "А";
  try {
    legacy = localStorage.getItem("para.group") === "Б" ? "Б" : "А";
  } catch {
    /* restricted browser */
  }
  return {
    groupId: readPreference("uf.group", "g-main"),
    subgroup: readPreference("uf.subgroup", legacy),
    lang: "ru",
    theme: readPreference("uf.dark", false) ? "dark" : "system",
    hour12: false,
    reminder: 0,
    ...readPreference("uf.settings.v1", {}),
  };
}
function publicSnapshot(snapshot, settings) {
  // Every public cache read/write rechecks its scope. Never let a previous
  // group's tasks or role-specific payload leak into the current selection.
  const source = snapshot.data || {};
  const data = {};
  for (const key of [
    "groups",
    "teachers",
    "subjects",
    "rooms",
    "lessons",
    "exceptions",
    "holidays",
  ])
    data[key] = source[key] || [];
  for (const key of ["validFrom", "validUntil"])
    if (source[key]) data[key] = source[key];
  data.tasks = (source.tasks || []).filter(
    (task) =>
      task.groupId === settings.groupId &&
      (settings.subgroup === "all" ||
        task.subgroup === "all" ||
        task.subgroup === settings.subgroup),
  );
  data.announcements = (source.announcements || []).filter(
    (item) =>
      (!item.roles || item.roles.includes("student")) &&
      (item.groupId ? item.groupId === settings.groupId : !item.teacherId),
  );
  data.attendance = [];
  data.requests = [];
  data.history = [];
  return {
    data,
    revision: snapshot.revision,
    source: snapshot.source,
    updatedAt: snapshot.updatedAt,
  };
}
export async function publicState(groupId, subgroup) {
  const request = async (sub) => {
    const r = await fetch(API + "/functions/v1/uniflow-api", {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: KEY },
      body: JSON.stringify({ action: "state", groupId, subgroup: sub }),
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) throw Error("state " + r.status);
    return r.json();
  };
  const state = await request(subgroup);
  // Compatibility with the deployed v2 server, which projects "all" as subgroup A.
  if (subgroup === "all" && !state.capabilities?.allSubgroupTasks) {
    const group = state.data.groups.find((g) => g.id === groupId);
    const rest = await Promise.all(
      (group?.subgroups || [])
        .filter((g) => g !== state.user?.subgroup)
        .map(request),
    );
    state.data.tasks = [
      ...new Map(
        [state, ...rest]
          .flatMap((s) => s.data.tasks)
          .map((task) => [task.id, task]),
      ).values(),
    ];
  }
  // Never persist private state, accounts, tokens or attendance in the public cache.
  return publicSnapshot(
    {
      data: state.data,
      revision: state.revision,
      updatedAt: new Date().toISOString(),
      source: "live",
    },
    { groupId, subgroup },
  );
}
export const snapshotKey = (settings) =>
  "snapshot:" + settings.groupId + ":" + settings.subgroup;
export async function getSnapshot(settings) {
  const saved = await storage.get(snapshotKey(settings));
  return saved ? publicSnapshot(saved, settings) : null;
}
export async function saveSnapshot(settings, snapshot) {
  return storage.set(snapshotKey(settings), publicSnapshot(snapshot, settings));
}
export async function releaseSnapshot(settings) {
  const r = await fetch(
    new URL("./bootstrap.json", new URL("./", location.href)),
  );
  if (!r.ok) throw Error("snapshot");
  return publicSnapshot(await r.json(), settings || initialSettings());
}
