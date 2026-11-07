/** Construct trusted structure. All dynamic copy is assigned as text, never HTML. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (name.startsWith("on") && typeof value === "function")
      node.addEventListener(name.slice(2), value);
    else if (name === "class") node.className = value;
    else if (name === "value") node.value = value;
    else if (name === "checked") node.checked = value;
    else node.setAttribute(name, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child != null && child !== false)
      node.append(
        child instanceof Node ? child : document.createTextNode(String(child)),
      );
  }
  return node;
}
export const button = (text, onclick, attrs = {}) =>
  el("button", { type: "button", onclick, ...attrs }, text);
export function field(text, input) {
  return el("label", { class: "field" }, el("span", {}, text), input);
}
export function select(options, value, onchange, attrs = {}) {
  const node = el(
    "select",
    { onchange, ...attrs },
    options.map(([id, text]) => el("option", { value: id }, text)),
  );
  node.value = value;
  return node;
}
export function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
