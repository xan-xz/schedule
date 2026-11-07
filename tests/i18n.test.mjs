import test from "node:test";
import assert from "node:assert/strict";
import { dictionaries, translator, localeFor } from "../app/lib/i18n.mjs";

const placeholders = (value) =>
  [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

test("each language explicitly defines the complete interface and preserves interpolation arguments", () => {
  const keys = Object.keys(dictionaries.ru).sort();
  for (const lang of ["kk", "en"]) {
    assert.deepEqual(Object.keys(dictionaries[lang]).sort(), keys, lang);
    for (const key of keys) {
      assert.ok(dictionaries[lang][key].trim().length > 0, `${lang}.${key}`);
      assert.deepEqual(
        placeholders(dictionaries[lang][key]),
        placeholders(dictionaries.ru[key]),
        `${lang}.${key}`,
      );
    }
  }
});

test("translator interpolates data without using localized strings as state keys", () => {
  assert.equal(translator("kk")("remaining", { n: 23 }), "23 минут қалды");
  assert.equal(translator("en")("updated", { date: "6 Nov" }), "Updated 6 Nov");
  assert.equal(translator("unknown")("today"), "Сегодня");
  assert.equal(translator("kk")("new"), "Жаңа");
  assert.equal(localeFor("en"), "en-GB");
  assert.equal(localeFor("unknown"), "ru-RU");
});
