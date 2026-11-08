import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  defaultTeachingSettings,
  validateTeachingSettings,
  teachingSettings,
  lessonTypeSuggestions,
} from "../backend/teaching-settings.mjs";
import {
  mutate,
  validate,
  visible,
  lessonFingerprint,
} from "../backend/core.mjs";
import {
  decomposePlatform,
  recomposePlatform,
  platformChecksum,
} from "../backend/normalized.mjs";
import { projectPublicData } from "../backend/public-data.mjs";
import { DEFAULT_APPEARANCE_POLICY } from "../backend/appearance-policy.mjs";
import { fixture } from "./e2e/fixtures.mjs";
const owner = { role: "admin", name: "Owner" };
const settings = () => ({
  version: 1,
  lessonTypes: [{ id: "seminar", name: "Семинар", enabled: true }],
  bellSchedules: [
    {
      id: "custom",
      name: "Свои звонки",
      enabled: true,
      slots: [
        {
          id: "one",
          name: "Первая",
          start: "09:10",
          end: "10:00",
          endDayOffset: 0,
        },
      ],
    },
  ],
  defaultBellScheduleId: "custom",
});
const data = () => ({
  ...structuredClone(fixture),
  siteSettings: {
    appearance: structuredClone(DEFAULT_APPEARANCE_POLICY),
    future: { private: "retained" },
  },
});
const save = (input, value) =>
  mutate(input, owner, "teaching.save", { settings: value }).data;
const checkSlots = (slots) => {
  const value = settings();
  value.bellSchedules[0].slots = slots;
  return validateTeachingSettings(value);
};
const slot = (id, start, end, endDayOffset = 0) => ({
  id,
  name: id,
  start,
  end,
  endDayOffset,
});

test("legacy defaults are fresh form presets with four raw types and exactly14 hourly50-minute slots", () => {
  const first = defaultTeachingSettings();
  assert.deepEqual(validateTeachingSettings(first), first);
  assert.deepEqual(
    first.lessonTypes.map((item) => item.name),
    ["Лабораторная", "Лекция", "Практика", "Занятие"],
  );
  const slots = first.bellSchedules[0].slots;
  assert.equal(slots.length, 14);
  assert.equal(slots[0].start, "08:00");
  assert.equal(slots.at(-1).end, "21:50");
  first.lessonTypes[0].name = "Changed";
  first.bellSchedules[0].slots[0].start = "01:00";
  assert.equal(defaultTeachingSettings().lessonTypes[0].name, "Лабораторная");
  assert.equal(
    defaultTeachingSettings().bellSchedules[0].slots[0].start,
    "08:00",
  );
});

test("only undefined settings use fallback; explicit empty is valid and malformed/null/future data never silently resets", () => {
  for (const input of [
    undefined,
    {},
    { siteSettings: {} },
    { siteSettings: { teaching: undefined } },
  ])
    assert.deepEqual(teachingSettings(input), defaultTeachingSettings());
  const empty = {
    version: 1,
    lessonTypes: [],
    bellSchedules: [],
    defaultBellScheduleId: "",
  };
  assert.deepEqual(
    teachingSettings({ siteSettings: { teaching: empty } }),
    empty,
  );
  for (const teaching of [null, false, {}, { ...empty, version: 2 }])
    assert.throws(() => teachingSettings({ siteSettings: { teaching } }));
});

test("validation trims only authored names, preserves ordering and returns detached data", () => {
  const value = settings();
  value.lessonTypes.unshift({ id: "Z", name: "  Язык  ", enabled: false });
  value.bellSchedules[0].name = "  Свои звонки  ";
  const result = validateTeachingSettings(value);
  assert.equal(result.lessonTypes[0].name, "Язык");
  assert.deepEqual(
    result.lessonTypes.map((x) => x.id),
    ["Z", "seminar"],
  );
  assert.equal(result.bellSchedules[0].name, "Свои звонки");
  result.bellSchedules[0].slots[0].start = "01:00";
  assert.equal(value.bellSchedules[0].slots[0].start, "09:10");
  assert.equal(value.lessonTypes[0].name, "  Язык  ");
});

test("every DTO level rejects extra/missing fields and nonboolean enabled", () => {
  for (const change of [
    (x) => (x.password = "never"),
    (x) => delete x.version,
    (x) => (x.lessonTypes[0].metadata = { private: true }),
    (x) => delete x.lessonTypes[0].enabled,
    (x) => (x.bellSchedules[0].groupId = "g"),
    (x) => (x.bellSchedules[0].slots[0].source = { row: 42 }),
    (x) => delete x.bellSchedules[0].slots[0].endDayOffset,
    (x) => (x.lessonTypes[0].enabled = "false"),
    (x) => (x.bellSchedules[0].enabled = 1),
  ]) {
    const value = settings();
    change(value);
    assert.throws(() => validateTeachingSettings(value));
  }
});

test("IDs are bounded ASCII, names are bounded nonempty and case-insensitive duplicates reject after trimming", () => {
  for (const id of ["", "_a", "-a", "группа", "has space", "a".repeat(101)]) {
    const value = settings();
    value.lessonTypes[0].id = id;
    assert.throws(() => validateTeachingSettings(value));
  }
  for (const name of ["  ", "a".repeat(41)]) {
    const value = settings();
    value.lessonTypes[0].name = name;
    assert.throws(() => validateTeachingSettings(value));
  }
  const dupName = settings();
  dupName.lessonTypes.push({
    id: "another",
    name: " СЕМИНАР ",
    enabled: false,
  });
  assert.throws(() => validateTeachingSettings(dupName), /Повторяется/);
  const dupId = settings();
  dupId.bellSchedules[0].slots.push(slot("one", "10:00", "10:50"));
  assert.throws(() => validateTeachingSettings(dupId), /Повторяется/);
  const nameDup = settings();
  nameDup.bellSchedules[0].slots.push({
    ...slot("two", "10:00", "10:50"),
    name: "первая",
  });
  assert.throws(() => validateTeachingSettings(nameDup), /Повторяется/);
  const longName = settings();
  longName.bellSchedules[0].name = "a".repeat(81);
  assert.throws(() => validateTeachingSettings(longName));
});

test("bounded list sizes enforce64 types/16 schedules/32 slots and at least one slot", () => {
  const max = settings();
  max.lessonTypes = Array.from({ length: 64 }, (_, i) => ({
    id: "t" + i,
    name: "Type " + i,
    enabled: true,
  }));
  max.bellSchedules = Array.from({ length: 16 }, (_, i) => ({
    id: "s" + i,
    name: "Scheme " + i,
    enabled: true,
    slots: Array.from({ length: 32 }, (_, j) =>
      slot(
        "p" + j,
        "00:" + String(j).padStart(2, "0"),
        "00:" + String(j + 1).padStart(2, "0"),
      ),
    ),
  }));
  max.defaultBellScheduleId = "s0";
  assert.equal(validateTeachingSettings(max).bellSchedules.length, 16);
  for (const change of [
    (x) => x.lessonTypes.push({ id: "extra", name: "Extra", enabled: true }),
    (x) =>
      x.bellSchedules.push({
        ...x.bellSchedules[0],
        id: "extra",
        name: "Extra",
      }),
    (x) => x.bellSchedules[0].slots.push(slot("extra", "01:00", "01:01")),
    (x) => (x.bellSchedules[0].slots = []),
  ]) {
    const value = structuredClone(max);
    change(value);
    assert.throws(() => validateTeachingSettings(value));
  }
});

test("default scheme must exist and be enabled; empty selection works with zero/disabled schemes", () => {
  for (const selected of [null, 42, "missing"]) {
    const value = settings();
    value.defaultBellScheduleId = selected;
    assert.throws(() => validateTeachingSettings(value));
  }
  const disabled = settings();
  disabled.bellSchedules[0].enabled = false;
  assert.throws(() => validateTeachingSettings(disabled));
  disabled.defaultBellScheduleId = "";
  assert.equal(validateTeachingSettings(disabled).defaultBellScheduleId, "");
});

test("slot time validation rejects malformed, zero, negative and over24-hour intervals", () => {
  for (const [start, end, offset] of [
    ["24:00", "00:50", 0],
    ["9:00", "10:00", 0],
    ["09:00", "09:00", 0],
    ["10:00", "09:00", 0],
    ["09:00", "10:00", 1],
    ["23:00", "01:00", 2],
    ["23:00", "01:00", true],
  ])
    assert.throws(() => checkSlots([slot("bad", start, end, offset)]));
  assert.equal(
    checkSlots([slot("full", "09:00", "09:00", 1)]).bellSchedules[0].slots
      .length,
    1,
  );
});

test("daily cyclic overlap checks both orderings across midnight while adjacency stays valid", () => {
  for (const slots of [
    [slot("night", "23:00", "01:00", 1), slot("early", "00:30", "00:50")],
    [slot("early", "00:30", "00:50"), slot("night", "23:00", "01:00", 1)],
    [slot("a", "09:00", "10:00"), slot("b", "09:59", "10:50")],
    [slot("full", "09:00", "09:00", 1), slot("other", "08:00", "08:01")],
  ])
    assert.throws(() => checkSlots(slots), /пересекаются/);
  const adjacent = [
    slot("night", "23:00", "01:00", 1),
    slot("early", "01:00", "02:00"),
    slot("late", "22:00", "23:00"),
  ];
  assert.deepEqual(checkSlots(adjacent).bellSchedules[0].slots, adjacent);
});

test("type suggestions retain exact historical override/current strings and do not close legacy types into an enum", () => {
  const input = data();
  input.siteSettings.teaching = settings();
  input.siteSettings.teaching.lessonTypes.push({
    id: "disabled",
    name: "Не использован",
    enabled: false,
  });
  input.lessons[0].type = " Практика ";
  input.lessons[1].type = "Лекция";
  input.exceptions = [{ type: "Разовая встреча" }, { type: "Лекция" }];
  const result = lessonTypeSuggestions(input, "Свободный ввод");
  assert.deepEqual(result, [
    "Семинар",
    " Практика ",
    "Лекция",
    "Практика",
    "Разовая встреча",
    "Свободный ввод",
  ]);
  assert.equal(result.includes("Не использован"), false);
  assert.deepEqual(
    lessonTypeSuggestions({
      siteSettings: {
        teaching: {
          version: 1,
          lessonTypes: [],
          bellSchedules: [],
          defaultBellScheduleId: "",
        },
      },
    }),
    [],
  );
});

test("owner-only teaching.save updates one branch losslessly, without public policy or lesson side effects", () => {
  const input = data(),
    before = structuredClone(input),
    value = settings();
  for (const role of ["guest", "student", "teacher"])
    assert.throws(
      () => mutate(input, { role }, "teaching.save", { settings: value }),
      (error) => error.status === 403,
    );
  const result = save(input, value);
  assert.deepEqual(result.siteSettings.teaching, value);
  assert.deepEqual(result.siteSettings.future, input.siteSettings.future);
  assert.deepEqual(
    result.siteSettings.appearance,
    input.siteSettings.appearance,
  );
  for (const key of Object.keys(input).filter(
    (key) => !["siteSettings", "history"].includes(key),
  ))
    assert.deepEqual(result[key], input[key], key);
  assert.deepEqual(input, before);
  assert.equal(result.history[0].action, "teaching.save");
  assert.equal(validate(result), true);
  assert.equal(
    visible(result, {
      role: "guest",
      id: "guest",
      groupId: "g-main",
      subgroup: "А",
    }).siteSettings.teaching,
    undefined,
  );
  assert.equal(projectPublicData(result).siteSettings.teaching, undefined);
});

test("optional teaching import validates only its authored subtree and preserves absent branch plus unknown siblings", () => {
  const initial = save(data(), settings());
  const legacy = structuredClone(initial);
  delete legacy.siteSettings;
  const retained = mutate(initial, owner, "import", { data: legacy }).data;
  assert.deepEqual(retained.siteSettings, initial.siteSettings);
  const next = settings();
  next.lessonTypes[0].name = "Новый шаблон";
  next.bellSchedules[0].slots[0].start = "09:20";
  const uploaded = {
    ...structuredClone(initial),
    siteSettings: { teaching: next, unknownInjected: { private: "ignored" } },
  };
  const result = mutate(initial, owner, "import", { data: uploaded }).data;
  assert.deepEqual(result.siteSettings.teaching, next);
  assert.deepEqual(result.siteSettings.future, initial.siteSettings.future);
  assert.deepEqual(
    result.siteSettings.appearance,
    initial.siteSettings.appearance,
  );
  assert.equal(result.siteSettings.unknownInjected, undefined);
  for (const teaching of [null, { ...next, version: 2 }]) {
    const invalid = structuredClone(uploaded);
    invalid.siteSettings.teaching = teaching;
    assert.throws(
      () => mutate(initial, owner, "import", { data: invalid }),
      (error) => error.status === 400,
    );
  }
  assert.deepEqual(initial.siteSettings.teaching, settings());
});

test("invalid teaching settings reject full model and save atomically", () => {
  const original = data();
  const broken = settings();
  broken.bellSchedules[0].slots.push(slot("overlap", "09:30", "09:40"));
  assert.throws(
    () => save(original, broken),
    (error) => error.status === 400,
  );
  assert.equal(original.siteSettings.teaching, undefined);
  const stored = data();
  stored.siteSettings.teaching = broken;
  assert.throws(
    () => validate(stored),
    (error) => error.status === 400,
  );
});

test("preset rename/change/removal never rewrites524 lessons, source warnings, conflict fingerprints or derived normalized catalogs", async () => {
  const source = JSON.parse(
    readFileSync(new URL("../app/seed.json", import.meta.url), "utf8"),
  );
  const before = structuredClone(source);
  const originalDerived = decomposePlatform(source).derived;
  let result = save(source, defaultTeachingSettings());
  const changed = defaultTeachingSettings();
  changed.lessonTypes[0].name = "Лабораторный шаблон";
  changed.bellSchedules[0].slots[0] = {
    ...slot("hour-08", "23:00", "00:00", 1),
    name: "Ночной",
  };
  changed.bellSchedules[0].slots = changed.bellSchedules[0].slots.filter(
    (item) => item.id !== "hour-21",
  );
  result = save(result, changed);
  result = save(result, {
    version: 1,
    lessonTypes: [],
    bellSchedules: [],
    defaultBellScheduleId: "",
  });
  assert.equal(validate(result), true);
  assert.equal(result.lessons.length, 524);
  assert.equal(
    result.lessons.filter(
      (item) => item.start === "09:00" && item.end === "17:00",
    ).length,
    9,
  );
  for (const key of [
    "lessons",
    "source",
    "sourceWarnings",
    "sourceConflictPairs",
  ])
    assert.deepEqual(result[key], source[key], key);
  assert.equal(result.sourceWarnings.length, 54);
  assert.equal(result.sourceConflictPairs.length, 133);
  assert.deepEqual(
    result.lessons.map(lessonFingerprint),
    source.lessons.map(lessonFingerprint),
  );
  const normalized = decomposePlatform(result);
  assert.deepEqual(normalized.derived, originalDerived);
  const recomposed = recomposePlatform(normalized);
  assert.deepEqual(recomposed, result);
  assert.equal(
    await platformChecksum(recomposed),
    await platformChecksum(result),
  );
  assert.deepEqual(source, before);
});

test("disabled presets stay absent from observed suggestions case-insensitively while current remains exact", () => {
  const input = data();
  input.siteSettings.teaching = defaultTeachingSettings();
  input.siteSettings.teaching.lessonTypes[0].enabled = false;
  input.lessons[0].type = " ЛАБОРАТОРНАЯ ";
  input.lessons[1].type = "Лабораторная";
  input.lessons[2].type = "Неизвестный тип";
  input.exceptions = [
    { type: "лабораторная" },
    { type: "Старая разовая встреча" },
  ];
  const result = lessonTypeSuggestions(input);
  assert.equal(
    result.some(
      (value) => value.trim().toLocaleLowerCase("ru") === "лабораторная",
    ),
    false,
  );
  assert.equal(result.includes("Неизвестный тип"), true);
  assert.equal(result.includes("Старая разовая встреча"), true);
  assert.equal(
    lessonTypeSuggestions(input, " Лабораторная ").at(-1),
    " Лабораторная ",
  );
  assert.equal(
    lessonTypeSuggestions(input, "Свободный ввод").at(-1),
    "Свободный ввод",
  );
  input.siteSettings.teaching.lessonTypes = [];
  assert.equal(lessonTypeSuggestions(input).includes(" ЛАБОРАТОРНАЯ "), true);
  assert.equal(input.lessons[0].type, " ЛАБОРАТОРНАЯ ");
});

test("disabling the historical laboratory preset excludes307 source suggestions without changing any original type", () => {
  const input = JSON.parse(
    readFileSync(new URL("../app/seed.json", import.meta.url), "utf8"),
  );
  const before = input.lessons.map((row) => row.type);
  input.siteSettings = { teaching: defaultTeachingSettings() };
  input.siteSettings.teaching.lessonTypes.find(
    (item) => item.name === "Лабораторная",
  ).enabled = false;
  assert.equal(lessonTypeSuggestions(input).includes("Лабораторная"), false);
  assert.equal(
    lessonTypeSuggestions(input, "Лабораторная").includes("Лабораторная"),
    true,
  );
  assert.deepEqual(
    input.lessons.map((row) => row.type),
    before,
  );
});

test("teaching-only draft publication produces owner history without changing the public DTO or adding notices", () => {
  const input = data(),
    uploaded = structuredClone(input);
  uploaded.siteSettings = {
    teaching: settings(),
    unknownInjected: { private: "do not leak" },
  };
  const result = mutate(input, owner, "import", { data: uploaded });
  assert.deepEqual(result.data.announcements, input.announcements);
  assert.deepEqual(projectPublicData(result.data), projectPublicData(input));
  assert.equal(result.summary, "Обновлены шаблоны типов занятий и звонков");
  assert.equal(result.data.history[0].summary, result.summary);
  assert.equal(
    JSON.stringify(projectPublicData(result.data)).includes("do not leak"),
    false,
  );
  const source = JSON.parse(
    readFileSync(new URL("../app/seed.json", import.meta.url), "utf8"),
  );
  const onlySettings = {
    ...structuredClone(source),
    siteSettings: { teaching: defaultTeachingSettings() },
  };
  const originalResult = mutate(source, owner, "import", {
    data: onlySettings,
  }).data;
  assert.equal(
    originalResult.announcements.length,
    source.announcements.length,
  );
  assert.deepEqual(originalResult.lessons, source.lessons);
});

test("a public catalog, lesson time, bounds or appearance change alongside presets still produces the normal student notice", () => {
  for (const change of [
    (value) => (value.rooms[0].name = "Новое имя аудитории"),
    (value) => (value.lessons[0].start = "08:10"),
    (value) => (value.validFrom = "2026-01-01"),
    (value) => (value.siteSettings.appearance.defaultPalette = "ocean"),
  ]) {
    const input = data(),
      uploaded = structuredClone(input);
    uploaded.siteSettings.teaching = settings();
    change(uploaded);
    const result = mutate(input, owner, "import", { data: uploaded }).data;
    assert.equal(result.announcements.length, input.announcements.length + 1);
    assert.equal(
      result.announcements[0].body,
      "Администратор обновил расписание из файла",
    );
  }
});

test("ordinary imports including unchanged teaching retain prior notice behaviour", () => {
  for (const input of [data(), save(data(), settings())]) {
    const result = mutate(input, owner, "import", {
      data: structuredClone(input),
    }).data;
    assert.equal(result.announcements.length, input.announcements.length + 1);
  }
});

test("projection-comparison errors fall back to normal model validation400 instead of a new exception", () => {
  const input = data(),
    uploaded = structuredClone(input);
  uploaded.siteSettings.teaching = settings();
  uploaded.groups[0].subgroups = [{ unknown: "invalid DTO" }];
  assert.throws(
    () => mutate(input, owner, "import", { data: uploaded }),
    (error) => error.status === 400,
  );
  assert.equal(input.siteSettings.teaching, undefined);
});
