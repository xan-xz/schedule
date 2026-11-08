import test from "node:test";
import assert from "node:assert/strict";
import {
  exportPersonalBackup,
  parsePersonalBackup,
  planPersonalRestore,
  restorePersonalTasks,
} from "../app/lib/personal-backup.mjs";
const scope = { groupId: "g-main", subgroup: "А" };
const task = {
  id: "original",
  title: "Личное <script>",
  due: "2026-11-09",
  subjectId: "s1",
  description: "Заметка",
  secret: "NEVER_EXPORT",
};
const file = () =>
  parsePersonalBackup(
    exportPersonalBackup([task], { original: "done" }, scope),
    scope,
  );

test("backup exports a closed personal DTO and exact scope, without unknown metadata", () => {
  const raw = exportPersonalBackup(
    [task],
    { original: "done", unrelated: "progress" },
    { ...scope, token: "NEVER_EXPORT" },
  );
  assert.equal(raw.includes("NEVER_EXPORT"), false);
  assert.equal(raw.includes("unrelated"), false);
  const result = parsePersonalBackup(raw, scope);
  assert.deepEqual(result.scope, scope);
  assert.equal(result.tasks[0].status, "done");
  assert.equal(result.tasks[0].title, task.title);
});
test("restore appends fresh IDs with progress and is idempotent across re-export", () => {
  const existing = { ...task, id: "keep", future: { preserved: true } };
  const result = restorePersonalTasks([existing], file(), scope, () => "fresh");
  assert.equal(result.tasks[0], existing);
  assert.equal(result.tasks[1].id, "fresh");
  assert.equal(result.tasks[1].backupOrigin, "original");
  assert.equal(result.tasks[1].restoredStatus, "done");
  assert.equal(result.tasks[1].secret, undefined);
  assert.equal(
    planPersonalRestore(result.tasks, file(), scope).additions.length,
    0,
  );
  const again = parsePersonalBackup(
    exportPersonalBackup([result.tasks[1]], { fresh: "progress" }, scope),
    scope,
  );
  assert.equal(again.tasks[0].id, "original");
  assert.equal(again.tasks[0].status, "progress");
  assert.equal(planPersonalRestore([task], again, scope).skipped, 1);
});
test("existing original IDs are preserved even when their content or progress differs", () => {
  const current = [{ ...task, title: "Newer edit" }];
  const result = restorePersonalTasks(current, file(), scope, () => {
    throw Error("must not allocate");
  });
  assert.deepEqual(result.tasks, current);
  assert.equal(result.skipped, 1);
});
test("scope, dates, status, duplicates, sizes and invalid shapes reject the entire input", () => {
  assert.throws(
    () =>
      parsePersonalBackup(JSON.stringify(file()), { ...scope, subgroup: "Б" }),
    /backupScope/,
  );
  for (const patch of [
    { due: "2026-02-30" },
    { dueTime: "24:00" },
    { title: " " },
    { status: "admin" },
    { description: "x".repeat(8001) },
  ]) {
    const f = file();
    Object.assign(f.tasks[0], patch);
    assert.throws(
      () => parsePersonalBackup(JSON.stringify(f), scope),
      /backupInvalid/,
    );
  }
  const duplicate = file();
  duplicate.tasks.push(duplicate.tasks[0]);
  assert.throws(
    () => parsePersonalBackup(JSON.stringify(duplicate), scope),
    /backupInvalid/,
  );
  for (const raw of ["{", "null", "[]", '"x"', "я".repeat(500001)])
    assert.throws(() => parsePersonalBackup(raw, scope), /backupInvalid/);
});
test("limit and generated-ID errors leave current rows and backup unchanged", () => {
  const current = Array.from({ length: 1000 }, (_, n) => ({
    ...task,
    id: "other" + n,
  }));
  const backup = file();
  const before = JSON.stringify({ current, backup });
  assert.throws(
    () => restorePersonalTasks(current, backup, scope, () => "fresh"),
    /backupLimit/,
  );
  assert.throws(
    () => restorePersonalTasks([], backup, scope, () => "original"),
    /backupInvalid/,
  );
  assert.equal(JSON.stringify({ current, backup }), before);
});
test("unknown imported fields cannot reach storage and stale status IDs cannot be reused", () => {
  const backup = file();
  backup.tasks[0].accessToken = "NEVER_STORE";
  const result = restorePersonalTasks([], backup, scope, () => "fresh-safe");
  assert.equal(JSON.stringify(result).includes("NEVER_STORE"), false);
  assert.notEqual(result.tasks[0].id, "original");
  assert.equal(result.tasks[0].groupId, scope.groupId);
});
