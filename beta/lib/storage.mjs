/** Public snapshots/preferences only. Never store passwords, session tokens or account lists. */
const DB = 'uniflow-public-v1';
const STORE = 'public';
const PREFIX = 'uf.public.v1.';
const memory = new Map();
let opening;

function database() {
  if (!globalThis.indexedDB) return Promise.resolve(null);
  if (!opening) opening = new Promise(resolve => {
    let request;
    try { request = indexedDB.open(DB, 1); } catch { resolve(null); return; }
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return opening;
}

async function operation(mode, action) {
  const db = await database();
  if (!db) return { ok: false };
  return new Promise(resolve => {
    try {
      const transaction = db.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      let value;
      request.onsuccess = () => { value = request.result; };
      transaction.oncomplete = () => resolve({ ok: true, value });
      transaction.onerror = transaction.onabort = () => resolve({ ok: false });
    } catch { resolve({ ok: false }); }
  });
}

export async function get(key, fallback = null) {
  const result = await operation('readonly', store => store.get(key));
  if (result.ok && result.value !== undefined) return result.value;
  if (memory.has(key)) return memory.get(key);
  try {
    const raw = globalThis.localStorage?.getItem(PREFIX + key);
    if (raw !== null && raw !== undefined) return JSON.parse(raw);
  } catch { /* Private mode/quota: in-memory fallback remains available. */ }
  return fallback;
}

export async function set(key, value) {
  const result = await operation('readwrite', store => store.put(value, key));
  memory.set(key, value);
  try {
    if (result.ok) globalThis.localStorage?.removeItem(PREFIX + key);
    else globalThis.localStorage?.setItem(PREFIX + key, JSON.stringify(value));
  } catch { /* A denied persistent store never prevents use of the app. */ }
  return result.ok;
}

export async function del(key) {
  await operation('readwrite', store => store.delete(key));
  memory.delete(key);
  try { globalThis.localStorage?.removeItem(PREFIX + key); } catch { /* denied */ }
}

export async function clear() {
  await operation('readwrite', store => store.clear());
  memory.clear();
  try {
    const storage = globalThis.localStorage;
    const keys = Array.from({ length: storage?.length || 0 }, (_, i) => storage.key(i)).filter(key => key?.startsWith(PREFIX));
    for (const key of keys) storage.removeItem(key);
  } catch { /* denied */ }
}
