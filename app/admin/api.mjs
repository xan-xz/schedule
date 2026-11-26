const ENDPOINT =
  "https://anfwdrcazwbkkayczkxg.supabase.co/functions/v1/owner-access";
const PUBLIC_KEY = "sb_publishable_NkbuSbf1LxiCGvgz48fPjg_aVVwDU_G";
const GOOGLE_LOGIN_KEY = "uniflow:owner-google-pkce";
const OWNER_REDIRECT = "https://xan-xz.github.io/schedule/admin/";
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
  "google.exchange",
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

const CALLBACK_ERROR_CODES = {
  otp_expired: "CALLBACK_EXPIRED",
  invite_not_found: "CALLBACK_EXPIRED",
  flow_state_expired: "CALLBACK_EXPIRED",
  flow_state_not_found: "CALLBACK_EXPIRED",
  over_email_send_rate_limit: "CALLBACK_RATE_LIMITED",
  over_request_rate_limit: "CALLBACK_RATE_LIMITED",
  email_provider_disabled: "CALLBACK_UNAVAILABLE",
  otp_disabled: "CALLBACK_UNAVAILABLE",
};
const callbackErrorFields = ["error", "error_code", "error_description"];

export async function startGoogleLogin() {
  const verifier = Array.from(
    crypto.getRandomValues(new Uint8Array(32)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  const target = new URL("/auth/v1/authorize", ENDPOINT);
  target.search = new URLSearchParams({
    provider: "google",
    scopes: "openid",
    redirect_to: OWNER_REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "s256",
    prompt: "select_account",
  }).toString();
  sessionStorage.setItem(
    GOOGLE_LOGIN_KEY,
    JSON.stringify({
      verifier,
      expiresAt: Date.now() + 15 * 60 * 1000,
    }),
  );
  location.assign(target.href);
}

/** Only a short-lived OAuth verifier survives the redirect. Application
 * credentials are never stored in the browser's session storage. */
export function consumeGoogleCallback(
  locationObject = location,
  historyObject = history,
  storage = sessionStorage,
  now = Date.now,
) {
  const query = new URLSearchParams(locationObject.search);
  const fragment = new URLSearchParams(locationObject.hash.slice(1));
  const failed = callbackErrorFields.some(
    (key) => query.has(key) || fragment.has(key),
  );
  if (!query.has("code") && !failed) return null;

  let pending;
  try {
    const raw = storage.getItem(GOOGLE_LOGIN_KEY);
    if (query.has("code") || raw) storage.removeItem(GOOGLE_LOGIN_KEY);
    pending = JSON.parse(raw);
  } catch {
    // A blocked or corrupted store is treated as an expired request.
  }
  if (!query.has("code") && !pending) return null;
  historyObject.replaceState(null, "", locationObject.pathname);
  const codes = query.getAll("code");
  if (
    failed ||
    codes.length !== 1 ||
    !/^[A-Za-z0-9_-]{16,512}$/.test(codes[0]) ||
    !/^[a-f0-9]{64}$/.test(pending?.verifier || "") ||
    !Number.isFinite(pending?.expiresAt) ||
    pending.expiresAt <= now()
  )
    return { failed: true };
  return { code: codes[0], verifier: pending.verifier };
}

/** Consume callback data synchronously. Provider descriptions never reach UI,
 * storage or a retained URL; an error never authenticates an accompanying token. */
export function consumeBootstrapCallback(
  locationObject = location,
  historyObject = history,
) {
  const fragment = new URLSearchParams(locationObject.hash.slice(1));
  const query = new URLSearchParams(locationObject.search);
  const failed = callbackErrorFields.some(
    (key) => fragment.has(key) || query.has(key),
  );
  const nativeCode =
    fragment.get("error_code") || query.get("error_code") || "";
  const errorCode = failed
    ? Object.hasOwn(CALLBACK_ERROR_CODES, nativeCode)
      ? CALLBACK_ERROR_CODES[nativeCode]
      : "CALLBACK_ERROR"
    : null;
  const token = failed ? "" : fragment.get("access_token") || "";
  if (failed) {
    // Remove callback errors and any accompanying credentials from error queries.
    for (const key of [
      ...callbackErrorFields,
      "access_token",
      "refresh_token",
      "provider_token",
      "provider_refresh_token",
      "token_hash",
      "code",
    ])
      query.delete(key);
  }
  if (locationObject.hash || failed) {
    const search = failed ? query.toString() : locationObject.search.slice(1);
    historyObject.replaceState(
      null,
      "",
      locationObject.pathname + (search ? "?" + search : ""),
    );
  }
  return { token, errorCode };
}

/** Compatibility helper for callers that only consume successful invitation proof. */
export function consumeBootstrapFragment(
  locationObject = location,
  historyObject = history,
) {
  return consumeBootstrapCallback(locationObject, historyObject).token;
}
