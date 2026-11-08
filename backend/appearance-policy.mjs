/** Public, bounded presentation policy. Contains no identity or authorization data. */
export const PALETTES = Object.freeze([
  "violet",
  "graphite",
  "ocean",
  "forest",
  "sunset",
  "contrast",
]);
export const LAYOUTS = Object.freeze(["focus", "timeline", "grid", "cards"]);
export const APPEARANCES = Object.freeze(["system", "light", "dark"]);
export const DEFAULT_APPEARANCE_POLICY = Object.freeze({
  version: 1,
  defaultPalette: "violet",
  defaultLayout: "focus",
  defaultAppearance: "system",
  allowedPalettes: PALETTES,
  allowedLayouts: LAYOUTS,
  allowPaletteChoice: true,
  allowLayoutChoice: true,
  allowCustomAccent: true,
});
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/** Reject unknown versions/keys and executable CSS rather than accepting a partial policy. */
export function validateAppearancePolicy(value) {
  if (
    !object(value) ||
    value.version !== 1 ||
    Object.keys(value).length !==
      Object.keys(DEFAULT_APPEARANCE_POLICY).length ||
    Object.keys(value).some((k) => !Object.hasOwn(DEFAULT_APPEARANCE_POLICY, k))
  )
    throw Error("Неверная версия или формат настроек интерфейса");
  for (const [key, options, chosen] of [
    ["allowedPalettes", PALETTES, "defaultPalette"],
    ["allowedLayouts", LAYOUTS, "defaultLayout"],
  ]) {
    const values = value[key];
    if (
      !Array.isArray(values) ||
      !values.length ||
      values.length > options.length ||
      values.some((id) => !options.includes(id)) ||
      new Set(values).size !== values.length ||
      !values.includes(value[chosen])
    )
      throw Error("Основной вариант должен быть среди разрешённых");
  }
  if (
    !APPEARANCES.includes(value.defaultAppearance) ||
    ["allowPaletteChoice", "allowLayoutChoice", "allowCustomAccent"].some(
      (k) => typeof value[k] !== "boolean",
    )
  )
    throw Error("Проверь разрешения интерфейса");
  return structuredClone(value);
}
export function appearancePolicy(value) {
  try {
    return validateAppearancePolicy(value);
  } catch {
    return structuredClone(DEFAULT_APPEARANCE_POLICY);
  }
}
export function cleanAppearancePreferences(value = {}) {
  return {
    palette: PALETTES.includes(value.palette) ? value.palette : "site",
    layout: LAYOUTS.includes(value.layout) ? value.layout : "site",
    theme: [...APPEARANCES, "site"].includes(value.theme)
      ? value.theme
      : "site",
    customAccent:
      typeof value.customAccent === "string" &&
      /^#[\da-f]{6}$/i.test(value.customAccent)
        ? value.customAccent.toLowerCase()
        : "",
    density: ["compact", "standard", "spacious"].includes(value.density)
      ? value.density
      : "standard",
    textSize: ["standard", "large", "larger"].includes(value.textSize)
      ? value.textSize
      : "standard",
    rounding: ["square", "soft", "round"].includes(value.rounding)
      ? value.rounding
      : "soft",
    reducedMotion: value.reducedMotion === true,
  };
}
/** Local choices are presentation preferences, never an authorization source. */
export function resolveAppearance(preferences, rawPolicy) {
  const policy = appearancePolicy(rawPolicy),
    p = cleanAppearancePreferences(preferences);
  return {
    ...p,
    palette:
      policy.allowPaletteChoice && policy.allowedPalettes.includes(p.palette)
        ? p.palette
        : policy.defaultPalette,
    layout:
      policy.allowLayoutChoice && policy.allowedLayouts.includes(p.layout)
        ? p.layout
        : policy.defaultLayout,
    theme: APPEARANCES.includes(p.theme) ? p.theme : policy.defaultAppearance,
    customAccent:
      policy.allowPaletteChoice && policy.allowCustomAccent
        ? p.customAccent
        : "",
  };
}
