/** Public snapshots/preferences only. Never store passwords, session tokens or account lists. */
const DB = "uniflow-public-v1";
const STORE = "public";
const PREFIX = "uf.public.v1.";
const FORMAT = "uniflow-public-record-v1";
const META = "__uf_meta_v1:";
const memory = new Map();
let opening;
let lastWritten = 0;

// A content marker detects a raw-only write from an older installed client.
// This is freshness bookkeeping, not an authentication or integrity boundary.
function fingerprint(value) {
  const text = JSON.stringify(value) ?? "undefined";
  let first = 2166136261,
    second = 5381;
  for (let index = 0; index < text.length; index++) {
    first = Math.imul(first ^ text.charCodeAt(index), 16777619);
    second = Math.imul(second, 33) ^ text.charCodeAt(index);
  }
  return `${text.length}:${first >>> 0}:${second >>> 0}`;
}

function record(value) {
  if (
    value?.format === FORMAT &&
    Number.isFinite(value.writtenAt) &&
    "value" in value
  )
    return value;
  return { format: FORMAT, writtenAt: 0, value };
}
function localRecord(key) {
  try {
    const raw = globalThis.localStorage?.getItem(PREFIX + key);
    let compatible = null;
    try {
      if (raw != null) compatible = record(JSON.parse(raw));
    } catch {
      /* corrupt compatibility copy */
    }
    const metadata = globalThis.localStorage?.getItem(PREFIX + META + key);
    if (metadata != null) {
      let saved;
      try {
        saved = JSON.parse(metadata);
      } catch {
        return compatible;
      }
      if (
        saved?.format === FORMAT &&
        Number.isFinite(saved.writtenAt) &&
        "value" in saved
      ) {
        const rawFingerprint = compatible && fingerprint(compatible.value);
        const baseline =
          saved.observedRaw?.fingerprint ||
          saved.rawFingerprint ||
          fingerprint(saved.value);
        if (
          compatible &&
          rawFingerprint !== baseline &&
          rawFingerprint !== fingerprint(saved.value)
        ) {
          saved = {
            ...saved,
            observedRaw: {
              fingerprint: rawFingerprint,
              writtenAt: Math.max(Date.now(), lastWritten + 1),
            },
          };
          lastWritten = saved.observedRaw.writtenAt;
          // Preserve the new backup if a legacy tab updates only the raw key.
          try {
            globalThis.localStorage.setItem(
              PREFIX + META + key,
              JSON.stringify(saved),
            );
          } catch {
            /* change remains observed in memory */
          }
        }
        if (compatible && saved.observedRaw?.fingerprint === rawFingerprint)
          return {
            ...saved,
            value: compatible.value,
            writtenAt: saved.observedRaw.writtenAt,
            backup: saved,
          };
        return saved;
      }
    }
    return compatible;
  } catch {
    return null;
  }
}

function database() {
  if (!globalThis.indexedDB) return Promise.resolve(null);
  if (!opening)
    opening = new Promise((resolve) => {
      let request;
      try {
        request = indexedDB.open(DB, 1);
      } catch {
        resolve(null);
        return;
      }
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        resolve(null);
      }, 800);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => {
        clearTimeout(timeout);
        if (timedOut) request.result.close();
        else resolve(request.result);
      };
      request.onerror = () => {
        clearTimeout(timeout);
        resolve(null);
      };
      request.onblocked = () => {
        clearTimeout(timeout);
        timedOut = true;
        resolve(null);
      };
    });
  return opening;
}

async function operation(mode, action) {
  const db = await database();
  if (!db) return { ok: false };
  return new Promise((resolve) => {
    let transaction;
    try {
      transaction = db.transaction(STORE, mode);
      const requested = action(transaction.objectStore(STORE));
      const requests = Array.isArray(requested) ? requested : [requested];
      const values = [];
      const timeout = setTimeout(() => {
        opening = Promise.resolve(null);
        try {
          transaction.abort();
          db.close();
        } catch {
          /* already closed */
        }
        resolve({ ok: false });
      }, 800);
      requests.forEach((request, index) => {
        request.onsuccess = () => {
          values[index] = request.result;
        };
      });
      transaction.oncomplete = () => {
        clearTimeout(timeout);
        resolve({
          ok: true,
          value: Array.isArray(requested) ? values : values[0],
        });
      };
      transaction.onerror = transaction.onabort = () => {
        clearTimeout(timeout);
        resolve({ ok: false });
      };
    } catch {
      try {
        transaction?.abort();
      } catch {
        /* already closed */
      }
      resolve({ ok: false });
    }
  });
}

export async function get(key, fallback = null) {
  const result = await operation("readonly", (store) => [
    store.get(key),
    store.get(META + key),
  ]);
  const stored =
    result.ok && result.value[0] !== undefined ? record(result.value[0]) : null;
  if (stored) {
    const metadata = result.value[1];
    const stamped =
      metadata?.format === FORMAT && Number.isFinite(metadata.writtenAt);
    stored.writtenAt = stamped ? metadata.writtenAt : 0;
    if (
      (!stamped || metadata.fingerprint !== fingerprint(stored.value)) &&
      (memory.get(key)?.writtenAt || 0) <= stored.writtenAt
    )
      memory.delete(key);
  }
  let local = localRecord(key);
  if (
    local?.writtenAt === 0 &&
    stored &&
    fingerprint(local.value) !== result.value[1]?.localFingerprintAtWrite
  ) {
    local = { ...local, writtenAt: Math.max(Date.now(), lastWritten + 1) };
    lastWritten = local.writtenAt;
  }
  const candidates = [stored, local, memory.get(key)].filter(Boolean);
  if (!candidates.length) return fallback;
  // A failed IDB write may leave an older readable row. Reconcile every store
  // rather than letting that row replace a newer local or in-memory update.
  const latest = candidates.reduce((a, b) =>
    b.writtenAt >= a.writtenAt ? b : a,
  );
  lastWritten = Math.max(lastWritten, latest.writtenAt);
  memory.set(key, latest);
  return latest.value;
}

export async function set(key, value) {
  const prior = localRecord(key);
  const alternatives = [...(prior?.alternatives || [])];
  if (
    prior?.backup &&
    fingerprint(prior.backup.value) !== fingerprint(value) &&
    !alternatives.some(
      (item) => fingerprint(item.value) === fingerprint(prior.backup.value),
    )
  )
    alternatives.push({
      writtenAt: prior.backup.writtenAt,
      value: prior.backup.value,
    });
  const next = {
    format: FORMAT,
    writtenAt: Math.max(Date.now(), lastWritten + 1),
    value,
    ...(alternatives.length ? { alternatives } : {}),
  };
  lastWritten = next.writtenAt;
  memory.set(key, next);
  // Keep existing row values raw: older installed clients still read these
  // arrays/snapshots. Freshness lives in a sidecar in the same IDB transaction.
  const result = await operation("readwrite", (store) => [
    store.put(value, key),
    store.put(
      {
        format: FORMAT,
        writtenAt: next.writtenAt,
        fingerprint: fingerprint(value),
        localFingerprintAtWrite: prior && fingerprint(prior.value),
        ...(alternatives.length ? { alternatives } : {}),
      },
      META + key,
    ),
  ]);
  let persisted = result.ok;
  try {
    if (memory.get(key) !== next) return persisted;
    if (result.ok) {
      if (
        !alternatives.length &&
        (localRecord(key)?.writtenAt || 0) <= next.writtenAt
      ) {
        globalThis.localStorage?.removeItem(PREFIX + key);
        globalThis.localStorage?.removeItem(PREFIX + META + key);
      }
    } else if (globalThis.localStorage) {
      // The sidecar is a complete atomic fallback even if a quota prevents
      // updating the compatibility key immediately afterwards.
      const backup = {
        ...next,
        rawFingerprint: prior && fingerprint(prior.value),
      };
      globalThis.localStorage.setItem(
        PREFIX + META + key,
        JSON.stringify(backup),
      );
      persisted = true;
      globalThis.localStorage.setItem(PREFIX + key, JSON.stringify(value));
      globalThis.localStorage.setItem(
        PREFIX + META + key,
        JSON.stringify({ ...backup, rawFingerprint: fingerprint(value) }),
      );
    }
  } catch {
    /* A denied persistent store never prevents use of the app. */
  }
  return persisted;
}

export async function del(key) {
  await operation("readwrite", (store) => [
    store.delete(key),
    store.delete(META + key),
  ]);
  memory.delete(key);
  try {
    globalThis.localStorage?.removeItem(PREFIX + key);
    globalThis.localStorage?.removeItem(PREFIX + META + key);
  } catch {
    /* denied */
  }
}

export async function clear() {
  await operation("readwrite", (store) => store.clear());
  memory.clear();
  try {
    const storage = globalThis.localStorage;
    const keys = Array.from({ length: storage?.length || 0 }, (_, i) =>
      storage.key(i),
    ).filter((key) => key?.startsWith(PREFIX));
    for (const key of keys) storage.removeItem(key);
  } catch {
    /* denied */
  }
}
