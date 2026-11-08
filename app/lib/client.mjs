import { projectPublicData } from "../public-data.mjs";
import * as storage from "./storage.mjs";
import { readInitialSnapshot } from "./initial-snapshot.mjs";
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
    theme: readPreference("uf.dark", false) ? "dark" : "site",
    hour12: false,
    reminder: 0,
    ...readPreference("uf.settings.v1", {}),
  };
}
function publicSnapshot(snapshot, settings) {
  // Every public cache read/write rechecks its scope. Never let a previous
  // group's tasks or role-specific payload leak into the current selection.
  const data = projectPublicData(snapshot.data || {});
  data.tasks = data.tasks.filter(
    (task) =>
      task.groupId === settings.groupId &&
      (settings.subgroup === "all" ||
        task.subgroup === "all" ||
        task.subgroup === settings.subgroup),
  );
  data.announcements = data.announcements.filter(
    (item) =>
      (!item.roles || item.roles.includes("student")) &&
      (item.groupId ? item.groupId === settings.groupId : !item.teacherId),
  );
  data.attendance = [];
  data.requests = [];
  data.history = [];
  return {
    data,
    revision:
      Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0
        ? snapshot.revision
        : undefined,
    source: ["live", "release-snapshot"].includes(snapshot.source)
      ? snapshot.source
      : undefined,
    updatedAt:
      typeof snapshot.updatedAt === "string" &&
      snapshot.updatedAt.length <= 64 &&
      Number.isFinite(Date.parse(snapshot.updatedAt))
        ? snapshot.updatedAt
        : undefined,
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
  const key = snapshotKey(settings),
    saved = await storage.get(key);
  if (!saved) return null;
  const clean = (value) => {
    try {
      return value ? publicSnapshot(value, settings) : null;
    } catch {
      return null;
    }
  };
  const projected = clean(saved);
  let unchanged = false;
  try {
    unchanged = JSON.stringify(saved) === JSON.stringify(projected);
  } catch {
    /* An invalid old row must not retain private metadata. */
  }
  if (unchanged) return projected;
  // Reproject the latest row atomically, never overwrite a newer tab's revision
  // with the older value read above. Keep its original updatedAt/source age.
  const repaired = await storage.update(key, clean, null);
  return clean(repaired.value);
}
export async function saveSnapshot(settings, snapshot) {
  return storage.set(snapshotKey(settings), publicSnapshot(snapshot, settings));
}
export async function releaseSnapshot(settings) {
  const initial = readInitialSnapshot();
  if (initial) return publicSnapshot(initial, settings || initialSettings());
  const r = await fetch(
    new URL("./bootstrap.json", new URL("./", location.href)),
  );
  if (!r.ok) throw Error("snapshot");
  return publicSnapshot(await r.json(), settings || initialSettings());
}
