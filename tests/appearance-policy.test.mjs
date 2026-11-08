import test from "node:test";
import assert from "node:assert/strict";
import {
  PALETTES,
  LAYOUTS,
  DEFAULT_APPEARANCE_POLICY as defaults,
  validateAppearancePolicy,
  resolveAppearance,
} from "../backend/appearance-policy.mjs";
import { PALETTE_TOKENS } from "../app/lib/appearance-tokens.mjs";
import { contrastRatio, safeAccent } from "../app/lib/personalization.mjs";
import { mutate, visible, validate } from "../backend/core.mjs";
import { fixture } from "./e2e/fixtures.mjs";
const owner = { role: "admin", name: "Owner" },
  copy = (v) => structuredClone(v);
test("policy is closed, bounded, nonempty and defaults belong to allowed choices", () => {
  assert.equal(PALETTES.length, 6);
  assert.equal(LAYOUTS.length, 4);
  for (const update of [
    { version: 2 },
    { x: 1 },
    { allowedLayouts: [] },
    { allowedPalettes: ["ocean"] },
    { allowedLayouts: ["focus", "focus"] },
    { defaultPalette: "url(https://invalid)" },
    { allowCustomAccent: "yes" },
    { allowedPalettes: Array(100).fill("violet") },
  ])
    assert.throws(() =>
      validateAppearancePolicy({ ...copy(defaults), ...update }),
    );
  const result = validateAppearancePolicy(defaults);
  result.allowedLayouts.pop();
  assert.equal(defaults.allowedLayouts.length, 4);
});
test("owner policy resolves device preferences without accepting roles or executable values", () => {
  const policy = {
    ...copy(defaults),
    defaultPalette: "ocean",
    defaultLayout: "cards",
    allowPaletteChoice: false,
    allowLayoutChoice: false,
  };
  const result = resolveAppearance(
    {
      palette: "sunset",
      layout: "grid",
      customAccent: "#ff5500",
      theme: "dark",
      textSize: "larger",
      reducedMotion: true,
      role: "admin",
    },
    policy,
  );
  assert.equal(result.palette, "ocean");
  assert.equal(result.layout, "cards");
  assert.equal(result.customAccent, "");
  assert.equal(result.theme, "dark");
  assert.equal(result.textSize, "larger");
  assert.equal(result.reducedMotion, true);
  assert.ok(!Object.hasOwn(result, "role"));
  assert.equal(
    resolveAppearance({ palette: "forest", layout: "grid" }, defaults).layout,
    "grid",
  );
  assert.equal(
    resolveAppearance(
      { palette: "forest" },
      { ...copy(defaults), allowedPalettes: ["violet"] },
    ).palette,
    "violet",
  );
});
test("all 12 palette variants maintain AA text, statuses, links and control contrast", () => {
  for (const [palette, modes] of Object.entries(PALETTE_TOKENS))
    for (const [mode, colors] of Object.entries(modes)) {
      for (const key of ["ink", "muted", "accent", "danger", "good"])
        for (const bg of ["bg", "surface", "tint"])
          assert.ok(
            contrastRatio(colors[key], colors[bg]) >= 4.5,
            `${palette}/${mode}/${key} on ${bg}: ${contrastRatio(colors[key], colors[bg])}`,
          );
      assert.ok(contrastRatio(colors.accent, colors["on-accent"]) >= 4.5);
      for (const bg of ["bg", "surface"])
        assert.ok(
          contrastRatio(colors.line, colors[bg]) >= 3,
          `${palette}/${mode} control border`,
        );
    }
  assert.equal(
    new Set(Object.values(PALETTE_TOKENS).map((p) => p.light.accent)).size,
    6,
  );
});
test("custom accents are corrected for every palette/mode and keep readable button text", () => {
  for (const modes of Object.values(PALETTE_TOKENS))
    for (const [mode, colors] of Object.entries(modes))
      for (const color of [
        "#ffffff",
        "#000000",
        "#ffdd00",
        "#7957d5",
        "#00ff00",
      ]) {
        const safe = safeAccent(color, colors, mode === "dark");
        for (const bg of [colors.bg, colors.surface, colors.tint])
          assert.ok(contrastRatio(safe.accent, bg) >= 4.5);
        assert.ok(contrastRatio(safe.accent, safe.onAccent) >= 4.5);
      }
});
test("semantic policy editing/import is lossless for unknown root and sibling settings", () => {
  const data = {
    ...copy(fixture),
    future: { data: [1, null, "x"] },
    siteSettings: { privateFuture: { opaque: "preserved" } },
  };
  const policy = {
    ...copy(defaults),
    defaultPalette: "ocean",
    defaultLayout: "grid",
  };
  const edited = mutate(data, owner, "appearance.save", { policy }).data;
  assert.deepEqual(data.siteSettings, {
    privateFuture: { opaque: "preserved" },
  });
  assert.deepEqual(edited.future, data.future);
  assert.deepEqual(
    edited.siteSettings.privateFuture,
    data.siteSettings.privateFuture,
  );
  const imported = mutate(data, owner, "import", {
    data: {
      ...copy(fixture),
      siteSettings: {
        appearance: policy,
        privateFuture: "cannot replace sibling",
      },
    },
  }).data;
  assert.deepEqual(imported.siteSettings, edited.siteSettings);
  assert.equal(
    imported.history[0].summary,
    "Опубликован черновик с настройками интерфейса",
  );
  assert.deepEqual(imported.lessons, data.lessons);
  const publicData = visible(edited, {
    role: "guest",
    groupId: "g-main",
    subgroup: "А",
    id: "guest",
  });
  assert.deepEqual(publicData.siteSettings, { appearance: policy });
  assert.equal(publicData.siteSettings.privateFuture, undefined);
  const oldImport = mutate(edited, owner, "import", {
    data: copy(fixture),
  }).data;
  assert.deepEqual(oldImport.siteSettings, edited.siteSettings);
});
test("invalid imported/stored policies fail and nonowners cannot edit appearance", () => {
  for (const role of ["guest", "student", "teacher"])
    assert.throws(
      () =>
        mutate(copy(fixture), { role, name: "Other" }, "appearance.save", {
          policy: defaults,
        }),
      { status: 403 },
    );
  assert.throws(() =>
    mutate(copy(fixture), owner, "import", {
      data: { ...copy(fixture), siteSettings: { appearance: { version: 99 } } },
    }),
  );
  assert.throws(() =>
    validate({ ...copy(fixture), siteSettings: { appearance: null } }),
  );
  assert.equal(
    visible(
      {
        ...copy(fixture),
        siteSettings: { appearance: { bad: true }, private: "hidden" },
      },
      { role: "guest", groupId: "g-main", subgroup: "А", id: "guest" },
    ).siteSettings,
    undefined,
  );
});
