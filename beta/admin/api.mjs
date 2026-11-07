const ENDPOINT =
  "https://anfwdrcazwbkkayczkxg.supabase.co/functions/v1/owner-access";
const PUBLIC_KEY = "sb_publishable_NkbuSbf1LxiCGvgz48fPjg_aVVwDU_G";
export function validOwnerPassword(value) {
  return (
    typeof value === "string" &&
    [...value].length >= 12 &&
    new TextEncoder().encode(value).length <= 72
  );
}
const ACTIONS = new Set([
  "status",
  "setup.request",
  "setup.start",
  "setup.password",
  "setup.verify",
  "login.begin",
  "login.verify",
  "recovery.verify",
  "recovery.finish",
  "session.refresh",
  "logout",
  "logout.all",
]);

export class OwnerAccessError extends Error {
  constructor(code = "UNAVAILABLE", retryAfterSeconds = 0) {
    super(code);
    this.name = "OwnerAccessError";
    this.code = code;
    this.retryAfterSeconds = Math.max(
      0,
      Math.min(3600, Number(retryAfterSeconds) || 0),
    );
  }
}

/** This transport intentionally has no storage, logging or identity parameter. */
export function createOwnerApi({ fetcher = fetch, endpoint = ENDPOINT } = {}) {
  return async function request(action, fields = {}, { signal } = {}) {
    if (!ACTIONS.has(action)) throw new OwnerAccessError("INVALID_REQUEST");
    let response;
    try {
      response = await fetcher(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: PUBLIC_KEY },
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(15000),
        body: JSON.stringify({ ...fields, action }),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new OwnerAccessError("UNAVAILABLE");
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw new OwnerAccessError("UNAVAILABLE");
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new OwnerAccessError("UNAVAILABLE");
    if (!response.ok) {
      const codes = [
        "INVALID_REQUEST",
        "INVALID_PROOF",
        "ACCESS_DENIED",
        "FLOW_CONFLICT",
        "RATE_LIMITED",
        "UNAVAILABLE",
        "MAIL_UNAVAILABLE",
      ];
      throw new OwnerAccessError(
        codes.includes(body.code) ? body.code : "UNAVAILABLE",
        body.retryAfterSeconds || response.headers.get("Retry-After"),
      );
    }
    return body;
  };
}

function validSession(value) {
  return (
    value &&
    /^ow1a\.[a-f0-9]{64}$/.test(value.token) &&
    /^ow1r\.[a-f0-9]{64}$/.test(value.refreshToken) &&
    Number.isFinite(Date.parse(value.expiresAt)) &&
    Number.isFinite(Date.parse(value.refreshExpiresAt)) &&
    typeof value.owner?.id === "string" &&
    typeof value.owner?.email === "string"
  );
}

/** Credentials live only in this closure; refresh cannot resurrect a cleared session. */
export function createOwnerSession(
  initial,
  request,
  { now = Date.now, onExpired = () => {} } = {},
) {
  if (!validSession(initial)) throw new OwnerAccessError("UNAVAILABLE");
  let state = { ...initial };
  delete state.recoveryCodes;
  let refreshPromise = null;
  let generation = 0;
  const owner = Object.freeze({ id: state.owner.id, email: state.owner.email });
  function clear() {
    generation++;
    state = null;
  }
  async function getAccessToken() {
    if (!state) throw new OwnerAccessError("INVALID_PROOF");
    if (Date.parse(state.refreshExpiresAt) <= now()) {
      clear();
      onExpired();
      throw new OwnerAccessError("INVALID_PROOF");
    }
    if (Date.parse(state.expiresAt) > now() + 30000) return state.token;
    if (!refreshPromise) {
      const current = generation;
      const refreshToken = state.refreshToken;
      refreshPromise = (async () => {
        try {
          const next = await request("session.refresh", { refreshToken });
          if (generation !== current || !state)
            throw new OwnerAccessError("INVALID_PROOF");
          if (
            !validSession(next) ||
            next.owner.id !== owner.id ||
            next.owner.email !== owner.email
          )
            throw new OwnerAccessError("INVALID_PROOF");
          state = { ...next };
          delete state.recoveryCodes;
          return state.token;
        } catch (error) {
          if (
            generation === current &&
            error.code !== "UNAVAILABLE" &&
            error.code !== "RATE_LIMITED"
          ) {
            clear();
            onExpired();
          }
          throw error;
        } finally {
          refreshPromise = null;
        }
      })();
    }
    return refreshPromise;
  }
  async function end(action) {
    try {
      const token = await getAccessToken();
      await request(action, { token });
    } finally {
      clear();
    }
  }
  return Object.freeze({
    owner,
    get expiresAt() {
      return state?.expiresAt || null;
    },
    getAccessToken,
    logout: () => end("logout"),
    logoutAll: () => end("logout.all"),
    clear,
  });
}

/** Remove the entire invite fragment before any asynchronous work or rendering. */
export function consumeBootstrapFragment(
  locationObject = location,
  historyObject = history,
) {
  const fragment = new URLSearchParams(locationObject.hash.slice(1));
  const token = fragment.get("access_token") || "";
  if (locationObject.hash)
    historyObject.replaceState(
      null,
      "",
      locationObject.pathname + locationObject.search,
    );
  return token;
}
