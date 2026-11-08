import { el, field, select } from "./dom.mjs";
import {
  PALETTES,
  LAYOUTS,
  appearancePolicy,
  resolveAppearance,
} from "../appearance-policy.mjs";
import { PALETTE_TOKENS } from "./appearance-tokens.mjs";
const names = {
  ru: {
    title: "Оформление на этом устройстве",
    palette: "Палитра",
    layout: "Представление расписания",
    theme: "Тема",
    site: "По умолчанию сайта",
    system: "Как в системе",
    light: "Светлое",
    dark: "Тёмное",
    accent: "Свой акцент",
    useAccent: "Использовать свой цвет",
    accentHelp:
      "Цвет автоматически корректируется до контраста AA с фоном. Исходный цвет сохраняется на устройстве.",
    density: "Плотность",
    textSize: "Размер текста",
    rounding: "Скругление",
    motion: "Уменьшить анимации",
    compact: "Компактно",
    standard: "Стандарт",
    spacious: "Просторно",
    large: "Крупнее",
    larger: "Очень крупный",
    square: "Почти прямые",
    soft: "Мягкие",
    round: "Круглые",
    locked:
      "Основной вариант выбран владельцем сайта. Личные настройки доступности сохраняются.",
    preview: "Живой предпросмотр",
    example: "Следующая пара · 09:00–10:20 · аудитория 204",
    palettes: ["Фиолетовая", "Графит", "Океан", "Хвоя", "Закат", "Контрастная"],
    layouts: [
      "Фокус — сейчас и дальше",
      "Лента дня — пары и окна",
      "Неделя-сетка — дни и время",
      "Карточки — дни и задания",
    ],
  },
  kk: {
    title: "Осы құрылғыдағы көрініс",
    palette: "Палитра",
    layout: "Сабақ кестесінің көрінісі",
    theme: "Жарық режимі",
    site: "Сайттың әдепкісі",
    system: "Жүйеге сай",
    light: "Жарық",
    dark: "Қараңғы",
    accent: "Жеке түс",
    useAccent: "Жеке түсті қолдану",
    accentHelp:
      "Түс AA контрастына дейін автоматты түзетіледі. Таңдау құрылғыда сақталады.",
    density: "Тығыздық",
    textSize: "Мәтін өлшемі",
    rounding: "Бұрыштар",
    motion: "Анимацияны азайту",
    compact: "Ықшам",
    standard: "Стандарт",
    spacious: "Кең",
    large: "Үлкен",
    larger: "Өте үлкен",
    square: "Тікке жақын",
    soft: "Жұмсақ",
    round: "Дөңгелек",
    locked:
      "Негізгі көріністі сайт иесі таңдаған. Қолжетімділік баптаулары сақталады.",
    preview: "Алдын ала көрініс",
    example: "Келесі сабақ · 09:00–10:20 · 204 аудитория",
    palettes: ["Күлгін", "Графит", "Мұхит", "Қылқан", "Күнбатыс", "Контраст"],
    layouts: [
      "Фокус — қазір және кейін",
      "Күн таспасы — сабақ пен үзіліс",
      "Апта торы — күндер мен уақыт",
      "Карточкалар — күн мен тапсырма",
    ],
  },
  en: {
    title: "Appearance on this device",
    palette: "Palette",
    layout: "Schedule layout",
    theme: "Color mode",
    site: "Site default",
    system: "System",
    light: "Light",
    dark: "Dark",
    accent: "Custom accent",
    useAccent: "Use custom color",
    accentHelp:
      "The color is adjusted automatically for AA contrast. Your original choice stays on this device.",
    density: "Density",
    textSize: "Text size",
    rounding: "Corners",
    motion: "Reduce motion",
    compact: "Compact",
    standard: "Standard",
    spacious: "Spacious",
    large: "Larger",
    larger: "Largest",
    square: "Square",
    soft: "Soft",
    round: "Round",
    locked:
      "The site owner selects the main appearance. Accessibility preferences stay available.",
    preview: "Live preview",
    example: "Next class · 09:00–10:20 · room 204",
    palettes: [
      "Violet",
      "Graphite",
      "Ocean",
      "Forest",
      "Sunset",
      "High contrast",
    ],
    layouts: [
      "Focus — now and next",
      "Day timeline — classes and breaks",
      "Week grid — days and times",
      "Cards — days and tasks",
    ],
  },
};
export const appearanceLabels = (lang) => names[lang] || names.ru;
export function luminance(hex) {
  const channels = hex
    .slice(1)
    .match(/../g)
    .map((v) => parseInt(v, 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
export const contrastRatio = (a, b) => {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
export function safeAccent(requested, colors, dark) {
  let accent = requested;
  const source = requested
    .slice(1)
    .match(/../g)
    .map((v) => parseInt(v, 16));
  for (let step = 0; step <= 100; step++) {
    accent =
      "#" +
      source
        .map((v) =>
          Math.round(v + ((dark ? 255 - v : -v) * step) / 100)
            .toString(16)
            .padStart(2, "0"),
        )
        .join("");
    if (
      [colors.bg, colors.surface, colors.tint].every(
        (bg) => contrastRatio(accent, bg) >= 4.5,
      )
    )
      break;
  }
  return {
    accent,
    onAccent: contrastRatio(accent, "#ffffff") >= 4.5 ? "#ffffff" : "#000000",
  };
}
export function applyAppearance(settings, policy) {
  const effective = resolveAppearance(settings, policy),
    root = document.documentElement;
  for (const key of [
    "theme",
    "palette",
    "layout",
    "density",
    "textSize",
    "rounding",
    "reducedMotion",
  ])
    root.dataset[key] = String(effective[key]);
  const dark =
    effective.theme === "dark" ||
    (effective.theme === "system" &&
      matchMedia("(prefers-color-scheme: dark)").matches);
  let custom = null;
  if (effective.customAccent)
    custom = safeAccent(
      effective.customAccent,
      PALETTE_TOKENS[effective.palette][dark ? "dark" : "light"],
      dark,
    );
  for (const [key, value] of [
    ["--accent", custom?.accent],
    ["--on-accent", custom?.onAccent],
  ]) {
    if (value) root.style.setProperty(key, value);
    else root.style.removeProperty(key);
  }
  try {
    localStorage.setItem(
      "uf.student.appearance.applied.v1",
      JSON.stringify({ version: 1, ...effective, custom, customDark: dark }),
    );
  } catch {
    /* settings backup remains available */
  }
  return effective;
}
export function renderPersonalization({
  settings,
  policy: rawPolicy,
  onChange,
}) {
  const policy = appearancePolicy(rawPolicy),
    effective = resolveAppearance(settings, policy),
    t = appearanceLabels(settings.lang);
  const root = el(
    "section",
    { class: "appearance-settings", "aria-label": t.title },
    el("h2", {}, t.title),
  );
  const choice = (label, key, options, disabled = false) =>
    field(
      label,
      select(
        options,
        options.some(([id]) => id === settings[key]) ? settings[key] : "site",
        (event) => onChange(key, event.target.value),
        { disabled },
      ),
    );
  root.append(
    choice(t.theme, "theme", [
      ["site", t.site],
      ...["system", "light", "dark"].map((v) => [v, t[v]]),
    ]),
    choice(
      t.palette,
      "palette",
      [
        ["site", t.site],
        ...policy.allowedPalettes.map((v) => [
          v,
          t.palettes[PALETTES.indexOf(v)],
        ]),
      ],
      !policy.allowPaletteChoice,
    ),
    choice(
      t.layout,
      "layout",
      [
        ["site", t.site],
        ...policy.allowedLayouts.map((v) => [v, t.layouts[LAYOUTS.indexOf(v)]]),
      ],
      !policy.allowLayoutChoice,
    ),
  );
  if (!policy.allowPaletteChoice || !policy.allowLayoutChoice)
    root.append(el("p", { class: "muted" }, t.locked));
  if (policy.allowPaletteChoice && policy.allowCustomAccent) {
    const color = el("input", {
      type: "color",
      value: settings.customAccent || "#7957d5",
      onchange: (e) => onChange("customAccent", e.target.value),
    });
    root.append(
      field(
        t.useAccent,
        el("input", {
          type: "checkbox",
          checked: !!settings.customAccent,
          onchange: (e) =>
            onChange("customAccent", e.target.checked ? "#7957d5" : ""),
        }),
      ),
      field(t.accent, color),
      el("p", { class: "muted" }, t.accentHelp),
    );
  }
  root.append(
    choice(
      t.density,
      "density",
      ["compact", "standard", "spacious"].map((v) => [v, t[v]]),
    ),
    choice(
      t.textSize,
      "textSize",
      ["standard", "large", "larger"].map((v) => [v, t[v]]),
    ),
    choice(
      t.rounding,
      "rounding",
      ["square", "soft", "round"].map((v) => [v, t[v]]),
    ),
    field(
      t.motion,
      el("input", {
        type: "checkbox",
        checked: settings.reducedMotion,
        onchange: (e) => onChange("reducedMotion", e.target.checked),
      }),
    ),
    el(
      "div",
      { class: "appearance-preview" },
      el(
        "strong",
        {},
        t.preview + " · " + t.palettes[PALETTES.indexOf(effective.palette)],
      ),
      el("p", {}, t.example),
      el("small", {}, t.layouts[LAYOUTS.indexOf(effective.layout)]),
    ),
  );
  return root;
}
