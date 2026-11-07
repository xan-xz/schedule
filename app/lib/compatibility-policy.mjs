const protectedLocal = [
  "uf.student.",
  "uf.settings",
  "uf.group",
  "uf.subgroup",
  "uf.dark",
  "para.",
  "uf.tasks.live",
  "uf.schedule.templates.v1.live",
  "uf.public.v1.",
];
const protectedPublic = [
  "personal:live:",
  "statuses:live:",
  "student-choice:",
  "student-settings:",
  "snapshot:",
  "__uf_meta_v1:",
];
const overlaps = (left, right) =>
  left.startsWith(right) || right.startsWith(left);
const stringArray = (value) =>
  Array.isArray(value) &&
  value.every((item) => typeof item === "string" && item.length > 0) &&
  new Set(value).size === value.length;
const routePath = (value) =>
  typeof value === "string" &&
  /^(?:[A-Za-z0-9_-]+\/)+$/u.test(value) &&
  !["admin", "manage", "lib", "icons", "backend", "app"].includes(
    value.split("/")[0],
  );
const localKey = (value) =>
  typeof value === "string" &&
  /^uf\.[A-Za-z0-9_.:-]+$/u.test(value) &&
  !protectedLocal.some((key) => overlaps(key, value));

/** Only the two public per-context collections have retired namespaces.
 * Never accept a prefix overlapping real data, sidecars or snapshots.
 */
export const isRetirablePublicPrefix = (value) =>
  typeof value === "string" &&
  /^(?:personal|statuses):[A-Za-z0-9_-]+:$/u.test(value) &&
  !protectedPublic.some((key) => overlaps(key, value));

/** Validate before any URL, storage, worker or redirect side effect. The
 * manifest names retired contexts; it cannot authorize a root/external scope,
 * a real user's namespace, or an arbitrary administrative destination.
 */
export function validateCompatibility(config) {
  if (
    !config ||
    typeof config !== "object" ||
    config.format !== "uniflow-compatibility-v1" ||
    !Array.isArray(config.legacyRoutes) ||
    !stringArray(config.retiredQueryParams) ||
    !stringArray(config.cacheScopes) ||
    !config.storage ||
    !stringArray(config.storage.localPrefixes) ||
    !stringArray(config.storage.localExact) ||
    !stringArray(config.storage.publicPrefixes)
  )
    return false;
  const paths = new Set(),
    workerPaths = new Set();
  for (const route of config.legacyRoutes) {
    if (
      !route ||
      !routePath(route.path) ||
      paths.has(route.path) ||
      !["./", "./admin/"].includes(route.target) ||
      (route.worker !== undefined && typeof route.worker !== "boolean") ||
      (route.worker &&
        (!/^[A-Za-z0-9_-]+\/$/u.test(route.path) || route.target !== "./"))
    )
      return false;
    paths.add(route.path);
    if (route.worker) workerPaths.add(route.path);
  }
  if (
    config.cacheScopes.length !== workerPaths.size ||
    config.cacheScopes.some((scope) => !workerPaths.has(scope)) ||
    config.retiredQueryParams.some(
      (key) =>
        !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(key) ||
        ["g", "group", "subgroup", "date"].includes(key.toLowerCase()),
    ) ||
    !config.storage.localPrefixes.every(localKey) ||
    !config.storage.localExact.every(localKey) ||
    !config.storage.publicPrefixes.every(isRetirablePublicPrefix)
  )
    return false;
  const migrations = config.storage.personalMigrations || [];
  const completionPrefixes = config.storage.legacyCompletionPrefixes || [];
  if (
    !Array.isArray(migrations) ||
    !stringArray(completionPrefixes) ||
    !completionPrefixes.every(localKey) ||
    migrations.some(
      (item) =>
        !item ||
        !isRetirablePublicPrefix(item.personalFrom) ||
        !item.personalFrom.startsWith("personal:") ||
        !isRetirablePublicPrefix(item.statusesFrom) ||
        !item.statusesFrom.startsWith("statuses:") ||
        item.personalFrom.split(":")[1] !== item.statusesFrom.split(":")[1],
    )
  )
    return false;
  return true;
}
