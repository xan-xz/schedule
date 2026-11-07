import { validateCompatibility } from "./lib/compatibility-policy.mjs";
const root = new URL("./", import.meta.url);
const config = await fetch(new URL("compatibility.json", root), {
  cache: "no-store",
}).then((response) => {
  if (!response.ok) throw Error("Compatibility route unavailable");
  return response.json();
});
if (!validateCompatibility(config)) throw Error("Unsafe compatibility policy");
const relative = location.pathname.startsWith(root.pathname)
  ? location.pathname.slice(root.pathname.length).replace(/index\.html$/, "")
  : "";
const route = [...config.legacyRoutes]
  .sort((a, b) => b.path.length - a.path.length)
  .find((route) => relative === route.path || relative.startsWith(route.path));
const target = new URL(route?.target || "./", root);
target.search = location.search;
for (const key of config.retiredQueryParams) target.searchParams.delete(key);
target.hash = location.hash;
location.replace(target.href);
