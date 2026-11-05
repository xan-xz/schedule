/** Compatibility renderer for escaped legacy templates. Never assign innerHTML.
 * Only this fixed element/attribute vocabulary is admitted into the live DOM.
 */
const tags = new Set(
  "a article aside b br button circle code dd details dialog div dl dt em fieldset footer form h1 h2 h3 h4 header hr i input label legend li main nav ol optgroup option p path polygon polyline progress rect section select small span strong summary svg table tbody td textarea th thead time tr ul".split(
    " ",
  ),
);
const attributes = new Set(
  "autocomplete checked class colspan cx cy d disabled download fill for height href id inputmode max maxlength min minlength multiple name open pattern placeholder r readonly required role rows rx ry selected stroke stroke-linecap stroke-linejoin stroke-width tabindex target title type value viewbox width x y".split(
    " ",
  ),
);
export function setMarkup(target, markup) {
  const parsed = new DOMParser().parseFromString(String(markup), "text/html");
  for (const node of [...parsed.body.querySelectorAll("*")]) {
    if (!tags.has(node.localName)) {
      node.remove();
      continue;
    }
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      if (
        !attributes.has(name) &&
        !name.startsWith("aria-") &&
        !name.startsWith("data-")
      ) {
        node.removeAttribute(attribute.name);
        continue;
      }
      if (name === "href") {
        try {
          const url = new URL(attribute.value, location.href);
          if (!["https:", "http:"].includes(url.protocol))
            node.removeAttribute(attribute.name);
        } catch {
          node.removeAttribute(attribute.name);
        }
      }
    }
    if (node.localName === "a" && node.target === "_blank")
      node.setAttribute("rel", "noopener noreferrer");
  }
  target.replaceChildren(...parsed.body.childNodes);
  target.querySelectorAll(".table-scroll").forEach((node) => {
    node.tabIndex = 0;
  });
}
