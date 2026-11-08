import { qrcode } from "../admin/vendor/qrcode-generator-2.0.4.mjs";
import { el, button, field, select, download } from "../lib/dom.mjs";
import { isGroupActive } from "../group-state.mjs";

/** A public invitation only. It never contains an owner credential or role. */
export function groupShareUrl(
  group,
  subgroup = "all",
  base = new URL("../", import.meta.url),
) {
  if (
    !group ||
    typeof group.id !== "string" ||
    !group.id.trim() ||
    group.id.length > 100 ||
    !Array.isArray(group.subgroups) ||
    !group.subgroups.length ||
    group.subgroups.some((s) => typeof s !== "string" || !s || s.length > 15) ||
    (subgroup !== "all" && !group.subgroups.includes(subgroup))
  )
    throw Error("Проверь группу и подгруппу для ссылки.");
  if (!isGroupActive(group))
    throw Error("Ссылка доступна после восстановления группы из архива.");
  const url = new URL(base);
  if (
    url.username ||
    url.password ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    )
  )
    throw Error("Ссылка требует HTTPS или локальный preview.");
  url.search = "";
  url.hash = "";
  url.searchParams.set("g", group.id);
  url.searchParams.set("subgroup", subgroup);
  return url.href;
}

function qrSvg(url) {
  qrcode.stringToBytes = (text) => [...new TextEncoder().encode(text)];
  const code = qrcode(0, "M");
  code.addData(url, "Byte");
  code.make();
  const size = code.getModuleCount();
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [name, value] of Object.entries({
    viewBox: `0 0 ${size + 8} ${size + 8}`,
    width: "240",
    height: "240",
    role: "img",
    "aria-label": "QR-код публичной ссылки на группу",
    "shape-rendering": "crispEdges",
    class: "group-share-qr",
  }))
    svg.setAttribute(name, value);
  const background = document.createElementNS(ns, "rect");
  background.setAttribute("width", String(size + 8));
  background.setAttribute("height", String(size + 8));
  background.setAttribute("fill", "#fff");
  const path = document.createElementNS(ns, "path");
  let geometry = "";
  for (let row = 0; row < size; row++)
    for (let col = 0; col < size; col++)
      if (code.isDark(row, col)) geometry += `M${col + 4},${row + 4}h1v1h-1z`;
  path.setAttribute("d", geometry);
  path.setAttribute("fill", "#000");
  svg.append(background, path);
  return svg;
}

export function showGroupShare(
  dialog,
  group,
  subgroup = "all",
  { published = true, onClose = () => dialog.close() } = {},
) {
  if (!published)
    throw Error("Сначала опубликуй новую группу, затем создай ссылку.");
  let url = groupShareUrl(group, subgroup);
  const css = new URL("./group-share.css", import.meta.url).href;
  const previousLabel = dialog.getAttribute("aria-labelledby");
  dialog.setAttribute("aria-labelledby", "group-share-title");
  dialog.addEventListener(
    "close",
    () => {
      if (previousLabel === null) dialog.removeAttribute("aria-labelledby");
      else dialog.setAttribute("aria-labelledby", previousLabel);
    },
    { once: true },
  );
  if (!document.querySelector("link[data-group-share]"))
    document.head.append(
      el("link", { rel: "stylesheet", href: css, "data-group-share": "true" }),
    );
  const status = el("p", { role: "status", class: "small" });
  const input = el("input", {
    type: "url",
    readonly: true,
    value: url,
    "aria-label": "Публичная ссылка группы",
  });
  const image = el("div", { class: "group-share-image" });
  const refresh = () => {
    input.value = url;
    image.replaceChildren(qrSvg(url));
    status.textContent = "";
  };
  const choices = select(
    [["all", "Обе / все подгруппы"], ...group.subgroups.map((s) => [s, s])],
    subgroup,
    (event) => {
      url = groupShareUrl(group, event.target.value);
      refresh();
    },
    { "aria-label": "Подгруппа для ссылки" },
  );
  dialog.replaceChildren(
    el(
      "div",
      { class: "dialog-head" },
      el("h2", { id: "group-share-title" }, "Ссылка и QR: " + group.name),
      button("Закрыть", onClose, { class: "btn" }),
    ),
    el(
      "p",
      { class: "dialog-sub" },
      "Откроется актуальное расписание группы после подтверждения выбора. Эта ссылка не даёт права управления.",
    ),
    field("Подгруппа для ссылки", choices),
    image,
    field("Публичная ссылка группы", input),
    el(
      "div",
      { class: "row section-space" },
      button(
        "Скопировать ссылку",
        async () => {
          try {
            await navigator.clipboard.writeText(url);
            status.textContent = "Ссылка скопирована.";
          } catch {
            input.focus();
            input.select();
            status.textContent =
              "Браузер не разрешил копирование. Ссылка выделена — скопируй её вручную.";
          }
        },
        { class: "btn primary" },
      ),
      button(
        "Скачать QR (SVG)",
        () => {
          const filename = group.id
            .replace(/[^a-zA-Z0-9_-]/g, "_")
            .slice(0, 50);
          download(
            "uniflow-group-" + filename + ".svg",
            new globalThis.XMLSerializer().serializeToString(
              image.firstElementChild,
            ),
            "image/svg+xml;charset=utf-8",
          );
        },
        { class: "btn" },
      ),
    ),
    status,
  );
  refresh();
  if (!dialog.open) dialog.showModal();
  choices.focus();
}
