import { validDate } from "./time.mjs";

export const BACKUP_BYTES = 1_000_000;
const FORMAT = "uniflow-personal-tasks-v1";
const states = ["new", "progress", "done"];
const text = (x, max, required = false) =>
  typeof x === "string" &&
  x.length <= max &&
  (!required || x.trim().length > 0);
const object = (x) => x && typeof x === "object" && !Array.isArray(x);
function invalid() {
  throw Error("backupInvalid");
}
function scopeValid(scope) {
  return (
    object(scope) &&
    text(scope.groupId, 100, true) &&
    text(scope.subgroup, 100, true)
  );
}
function cleanTask(task) {
  if (
    !object(task) ||
    !text(task.id, 100, true) ||
    !text(task.title, 160, true) ||
    !validDate(task.due) ||
    !text(task.subjectId, 100) ||
    !text(task.description, 8000) ||
    !text(task.dueTime, 5) ||
    (task.dueTime && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(task.dueTime)) ||
    !states.includes(task.status)
  )
    invalid();
  return Object.fromEntries(
    ["id", "title", "due", "dueTime", "subjectId", "description", "status"].map(
      (k) => [k, task[k]],
    ),
  );
}
export function parsePersonalBackup(raw, scope) {
  if (
    !text(raw, BACKUP_BYTES) ||
    new TextEncoder().encode(raw).byteLength > BACKUP_BYTES
  )
    invalid();
  let file;
  try {
    file = JSON.parse(raw);
  } catch {
    invalid();
  }
  if (
    !object(file) ||
    file.format !== FORMAT ||
    !scopeValid(file.scope) ||
    !Array.isArray(file.tasks) ||
    file.tasks.length > 1000
  )
    invalid();
  if (
    !scopeValid(scope) ||
    file.scope.groupId !== scope.groupId ||
    file.scope.subgroup !== scope.subgroup
  )
    throw Error("backupScope");
  const tasks = file.tasks.map(cleanTask);
  if (new Set(tasks.map((x) => x.id)).size !== tasks.length) invalid();
  return {
    format: FORMAT,
    scope: { groupId: scope.groupId, subgroup: scope.subgroup },
    tasks,
  };
}
export function exportPersonalBackup(tasks, statuses, scope) {
  if (!Array.isArray(tasks) || !object(statuses) || !scopeValid(scope))
    invalid();
  const rows = tasks.map((task) => ({
    id: task.backupOrigin || task.id,
    title: task.title,
    due: task.due,
    dueTime: task.dueTime || "",
    subjectId: task.subjectId || "",
    description: task.description || "",
    status: Object.hasOwn(statuses, task.id)
      ? statuses[task.id]
      : task.restoredStatus || "new",
  }));
  const raw = JSON.stringify(
    {
      format: FORMAT,
      scope: { groupId: scope.groupId, subgroup: scope.subgroup },
      tasks: rows,
    },
    null,
    2,
  );
  parsePersonalBackup(raw, scope);
  return raw;
}
export function planPersonalRestore(current, backup, scope) {
  if (!Array.isArray(current)) invalid();
  // Revalidate even callers that did not use the file picker.
  const clean = parsePersonalBackup(JSON.stringify(backup), scope);
  const known = new Set(
    current.flatMap((task) => [task.id, task.backupOrigin].filter(Boolean)),
  );
  const additions = clean.tasks.filter((task) => !known.has(task.id));
  if (current.length + additions.length > 1000) throw Error("backupLimit");
  return { additions, skipped: clean.tasks.length - additions.length };
}
export function restorePersonalTasks(current, backup, scope, makeId) {
  const plan = planPersonalRestore(current, backup, scope);
  const used = new Set([
    ...current.map((x) => x.id),
    ...backup.tasks.map((x) => x.id),
  ]);
  const added = plan.additions.map((task) => {
    const id = makeId();
    if (!text(id, 100, true) || used.has(id)) invalid();
    used.add(id);
    return {
      id,
      backupOrigin: task.id,
      title: task.title,
      due: task.due,
      dueTime: task.dueTime,
      subjectId: task.subjectId,
      description: task.description,
      groupId: scope.groupId,
      restoredStatus: task.status,
    };
  });
  return {
    tasks: [...current, ...added],
    added: added.length,
    skipped: plan.skipped,
  };
}
