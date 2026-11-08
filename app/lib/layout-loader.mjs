const modules = new Map();
const files = {
  timeline: "timeline.mjs",
  grid: "grid.mjs",
  cards: "cards.mjs",
};
export function loadedLayout(id) {
  return modules.get(id)?.render;
}
export async function loadLayout(id) {
  if (!Object.hasOwn(files, id)) throw Error("Unknown layout");
  const url = new URL("layouts/" + files[id], new URL("./", document.baseURI));
  const module = await import(url.href);
  modules.set(id, module);
  return module.render;
}
