import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./e2e/fixtures.mjs";
import {
  createTemplate,
  saveTemplate,
  loadTemplates,
  renameTemplate,
  applyTemplate,
  TEMPLATE_STORAGE_KEY,
  exportTemplateBackup,
  previewTemplateBackup,
  applyTemplateBackup,
  withTemplateLock,
} from "../app/manage/templates.mjs";
const data = () => structuredClone(fixture);
const template = (name = "Пятница") =>
  createTemplate(data(), {
    name,
    kind: "day",
    day: 4,
    groupId: "g-main",
    subgroup: "А",
  });
function memory() {
  const values = new Map();
  return {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v),
    values,
  };
}
function backup(rows = [template()]) {
  const store = memory();
  for (const row of rows) saveTemplate(row, store);
  return exportTemplateBackup(store);
}
test("template backup round-trip uses a closed projection and fresh IDs without mutating schedule or preview storage", () => {
  const t = template(),
    source = memory(),
    target = memory(),
    d = data(),
    before = structuredClone(d);
  t.password = "not copied";
  t.lessons[0].sharedSessionId = "not copied";
  t.refs.rooms[0].note = "not copied";
  saveTemplate(t, source);
  const raw = exportTemplateBackup(source);
  assert.doesNotMatch(raw, /password|sharedSessionId|note|attendance|token/);
  const plan = previewTemplateBackup(raw, d, target);
  assert.equal(plan.valid, true);
  assert.deepEqual(plan.counts, { added: 1, skipped: 0, conflict: 0 });
  assert.equal(target.getItem(TEMPLATE_STORAGE_KEY), null);
  assert.deepEqual(applyTemplateBackup(plan, d, target), {
    added: 1,
    skipped: 0,
  });
  assert.notEqual(loadTemplates(target)[0].id, t.id);
  assert.deepEqual(
    loadTemplates(target)[0].lessons,
    t.lessons.map(({ sharedSessionId: _drop, ...row }) => row),
  );
  assert.deepEqual(d, before);
});
test("repeat import skips exact names/content independent of ID, timestamps, object key order and reference ordering", () => {
  const raw = backup(),
    store = memory(),
    d = data();
  applyTemplateBackup(previewTemplateBackup(raw, d, store), d, store);
  const input = JSON.parse(raw);
  input.templates[0].id = "new-file-id";
  input.templates[0].createdAt = "2026-11-01T00:00:00Z";
  input.templates[0].name = "ПЯТНИЦА";
  input.templates[0].lessons = input.templates[0].lessons.map((row) =>
    Object.fromEntries(Object.entries(row).reverse()),
  );
  for (const rows of Object.values(input.templates[0].refs)) rows.reverse();
  const before = store.getItem(TEMPLATE_STORAGE_KEY),
    plan = previewTemplateBackup(JSON.stringify(input), d, store);
  assert.deepEqual(plan.counts, { added: 0, skipped: 1, conflict: 0 });
  assert.equal(plan.valid, false);
  assert.throws(() => applyTemplateBackup(plan, d, store), /заблокирован/);
  assert.equal(store.getItem(TEMPLATE_STORAGE_KEY), before);
});
test("same-name different content blocks the entire import, preserving all existing entries", () => {
  const t = template(),
    store = memory(),
    d = data();
  saveTemplate(t, store);
  const changed = structuredClone(t);
  changed.lessons[0].type = "Другой тип";
  const raw = backup([changed, template("Вторая")]),
    before = store.getItem(TEMPLATE_STORAGE_KEY),
    plan = previewTemplateBackup(raw, d, store);
  assert.equal(plan.valid, false);
  assert.equal(plan.counts.conflict, 1);
  assert.equal(plan.counts.added, 1);
  assert.throws(() => applyTemplateBackup(plan, d, store));
  assert.equal(store.getItem(TEMPLATE_STORAGE_KEY), before);
});
test("quota failure is one atomic write and permits a fresh reviewed retry without duplicates", () => {
  const store = memory(),
    d = data(),
    raw = backup([template("Новая")]);
  saveTemplate(template("Старая"), store);
  const original = store.setItem,
    before = store.getItem(TEMPLATE_STORAGE_KEY),
    plan = previewTemplateBackup(raw, d, store);
  store.setItem = () => {
    throw Error("quota");
  };
  assert.throws(() => applyTemplateBackup(plan, d, store), /место/);
  assert.equal(store.getItem(TEMPLATE_STORAGE_KEY), before);
  store.setItem = original;
  applyTemplateBackup(previewTemplateBackup(raw, d, store), d, store);
  assert.equal(loadTemplates(store).length, 2);
  assert.equal(previewTemplateBackup(raw, d, store).counts.skipped, 1);
});
test("stale library or catalog snapshot rejects before persistence", () => {
  const d = data(),
    raw = backup(),
    store = memory();
  saveTemplate(template("Моя"), store);
  const plan = previewTemplateBackup(raw, d, store);
  renameTemplate(loadTemplates(store)[0].id, "Другая вкладка", store);
  const before = store.getItem(TEMPLATE_STORAGE_KEY);
  assert.throws(() => applyTemplateBackup(plan, d, store), /изменились/);
  assert.equal(store.getItem(TEMPLATE_STORAGE_KEY), before);
  const fresh = previewTemplateBackup(raw, d, store);
  d.rooms[0].name = "Другая";
  assert.throws(() => applyTemplateBackup(fresh, d, store), /изменились/);
  assert.equal(store.getItem(TEMPLATE_STORAGE_KEY), before);
});
test("unknown imported fields, access strings and prototype keys are rejected without any write", () => {
  const original = JSON.parse(backup()),
    d = data(),
    store = memory();
  const edits = [
    (x) => {
      x.token = "bad";
    },
    (x) => {
      x.templates[0].secret = "bad";
    },
    (x) => {
      x.templates[0].lessons[0].sharedSessionId = "bad";
    },
    (x) => {
      x.templates[0].refs.rooms[0].note = "bad";
    },
    (x) => {
      x.templates[0].name = "ow1a." + "a".repeat(64);
    },
    (x) => {
      Object.defineProperty(x.templates[0].refs, "__proto__", {
        value: [],
        enumerable: true,
      });
    },
  ];
  for (const edit of edits) {
    const input = structuredClone(original);
    edit(input);
    assert.throws(() => previewTemplateBackup(JSON.stringify(input), d, store));
  }
  assert.equal(store.getItem(TEMPLATE_STORAGE_KEY), null);
});
test("invalid JSON, schema versions, duplicates and UTF-8 size limits fail closed", () => {
  const original = JSON.parse(backup()),
    d = data(),
    store = memory();
  for (const raw of [
    "{",
    "[]",
    "я".repeat(150001),
    JSON.stringify({ ...original, version: 2 }),
    JSON.stringify({ ...original, templates: [] }),
  ])
    assert.throws(() => previewTemplateBackup(raw, d, store));
  for (const duplicate of [
    structuredClone(original.templates[0]),
    { ...original.templates[0], id: "other", name: "ПЯТНИЦА" },
  ])
    assert.throws(
      () =>
        previewTemplateBackup(
          JSON.stringify({
            ...original,
            templates: [...original.templates, duplicate],
          }),
          d,
          store,
        ),
      /повторяются/,
    );
  assert.equal(store.getItem(TEMPLATE_STORAGE_KEY), null);
});
test("invalid dates, reversed/long intervals and duplicate or incomplete references reject", () => {
  const original = JSON.parse(backup()),
    d = data(),
    store = memory();
  for (const edit of [
    (x) => {
      x.lessons[0].end = "07:00";
    },
    (x) => {
      x.lessons[0].endDayOffset = 1;
    },
    (x) => {
      x.lessons[0].validFrom = "2026-02-30";
    },
    (x) => {
      x.lessons[0].validFrom = "2026-12-01";
      x.lessons[0].validUntil = "2026-11-01";
    },
    (x) => {
      x.refs.rooms = [];
    },
    (x) => {
      x.refs.rooms.push(x.refs.rooms[0]);
    },
  ]) {
    const input = structuredClone(original);
    edit(input.templates[0]);
    assert.throws(() => previewTemplateBackup(JSON.stringify(input), d, store));
  }
});
test("twenty-template capacity and unavailable/corrupt storage preserve recoverable data", () => {
  const store = memory(),
    d = data();
  for (let i = 0; i < 20; i++) saveTemplate(template("Мой " + i), store);
  const before = store.getItem(TEMPLATE_STORAGE_KEY),
    plan = previewTemplateBackup(backup(), d, store);
  assert.equal(plan.capacity, false);
  assert.throws(() => applyTemplateBackup(plan, d, store));
  assert.equal(store.getItem(TEMPLATE_STORAGE_KEY), before);
  store.setItem(TEMPLATE_STORAGE_KEY, "{corrupt");
  assert.throws(() => previewTemplateBackup(backup(), d, store));
  assert.throws(() => exportTemplateBackup(store));
  assert.equal(store.getItem(TEMPLATE_STORAGE_KEY), "{corrupt");
  assert.throws(() =>
    previewTemplateBackup(backup(), d, {
      getItem() {
        throw Error("denied");
      },
    }),
  );
  assert.throws(() => exportTemplateBackup(memory()), /хотя бы один/);
});
test("missing catalog references are explicit warnings: backup can be kept, application remains separately validated", () => {
  const d = data(),
    store = memory(),
    raw = backup();
  d.teachers = [];
  const plan = previewTemplateBackup(raw, d, store);
  assert.equal(plan.valid, true);
  assert.ok(plan.rows[0].missing.some((s) => s.includes("Преподаватель")));
  applyTemplateBackup(plan, d, store);
  assert.throws(
    () =>
      applyTemplate(d, loadTemplates(store)[0], {
        groupId: "g-main",
        subgroup: "А",
        toDay: 1,
      }),
    /нет/,
  );
});
test("plan rows cannot smuggle an unreviewed mutation into the recomputed file import", () => {
  const d = data(),
    store = memory(),
    plan = previewTemplateBackup(backup(), d, store);
  plan.rows[0].template.lessons[0].type = "Unreviewed";
  applyTemplateBackup(plan, d, store);
  assert.notEqual(loadTemplates(store)[0].lessons[0].type, "Unreviewed");
});
test("shared write lock fails closed when unavailable, propagates errors and uses cancellable exclusive scope", async () => {
  let writes = 0;
  await assert.rejects(
    withTemplateLock(() => writes++, {}),
    /безопасную запись/,
  );
  assert.equal(writes, 0);
  const locks = {
    async request(name, options, action) {
      assert.equal(name, "uniflow-template-library-v1");
      assert.equal(options.mode, "exclusive");
      assert.equal(options.signal.aborted, false);
      return action();
    },
  };
  assert.equal(await withTemplateLock(() => ++writes, locks), 1);
  await assert.rejects(
    withTemplateLock(() => {
      throw Error("quota");
    }, locks),
    /quota/,
  );
  await assert.rejects(
    withTemplateLock(() => writes++, {
      request() {
        throw Object.assign(Error("cancelled"), { name: "AbortError" });
      },
    }),
    /Другая вкладка/,
  );
  assert.equal(writes, 1);
});

test("combined UTF-8 library size is checked before a single byte can replace the existing library", () => {
  const heavy = template("Первая");
  const refs = { subjects: [], teachers: [], rooms: [] };
  heavy.lessons = Array.from({ length: 100 }, (_, i) => {
    const row = { ...heavy.lessons[0] };
    for (const [collection, field] of [
      ["subjects", "subjectId"],
      ["teachers", "teacherId"],
      ["rooms", "roomId"],
    ]) {
      const id = (collection + i).padEnd(64, "x");
      refs[collection].push({ id, name: "x".repeat(140) });
      row[field] = id;
    }
    return row;
  });
  heavy.refs = refs;
  const store = memory();
  saveTemplate(heavy, store);
  saveTemplate({ ...heavy, id: "second", name: "Вторая" }, store);
  const before = store.getItem(TEMPLATE_STORAGE_KEY);
  const raw = backup([{ ...heavy, id: "third", name: "Третья" }]);
  const plan = previewTemplateBackup(raw, data(), store);
  assert.equal(plan.capacity, false);
  assert.throws(() => applyTemplateBackup(plan, data(), store));
  assert.equal(store.getItem(TEMPLATE_STORAGE_KEY), before);
});

test("adding a file preserves unknown local metadata on existing templates but never exports it", () => {
  const store = memory(),
    old = { ...template("Мой"), future: { localOnly: "retain this" } };
  store.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify([old]));
  const raw = backup();
  applyTemplateBackup(previewTemplateBackup(raw, data(), store), data(), store);
  assert.deepEqual(JSON.parse(store.getItem(TEMPLATE_STORAGE_KEY))[0], old);
  assert.doesNotMatch(
    exportTemplateBackup(store),
    /localOnly|retain this|future/,
  );
});
