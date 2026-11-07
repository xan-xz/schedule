// Server-only owner identity boundary shared by the website and future clients.
// Provider JWT claims are inspected only after Auth /user verifies the token.
export const OWNER_EMAIL = "arappayevv@gmail.com";
export const OWNER_ORIGIN = "https://xan-xz.github.io";
export const OWNER_REDIRECT = OWNER_ORIGIN + "/schedule/admin/";
export const ACCESS_MS = 15 * 60 * 1000;
export const ABSOLUTE_MS = 60 * 60 * 1000;
export const CHALLENGE_MS = 5 * 60 * 1000;
export const SETUP_MS = 10 * 60 * 1000;
const encoder = new TextEncoder();
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const hex = (bytes) =>
  Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

export function ownerError(code = "INVALID_PROOF", status = 401, retry = 0) {
  const messages = {
    INVALID_REQUEST: "Проверь введённые данные.",
    INVALID_PROOF:
      "Не удалось подтвердить вход. Проверь данные или начни заново.",
    ACCESS_DENIED: "Доступ не разрешён.",
    FLOW_CONFLICT: "Действие уже выполняется. Подожди и повтори.",
    RATE_LIMITED: "Слишком много попыток. Подожди перед повтором.",
    UNAVAILABLE: "Вход временно недоступен. Попробуй позже.",
    MAIL_UNAVAILABLE:
      "Не удалось отправить письмо. Проверь настройки почты и адреса возврата в Supabase.",
  };
  return Object.assign(
    new Error(
      Object.hasOwn(messages, code) ? messages[code] : messages.UNAVAILABLE,
    ),
    {
      code,
      status,
      retryAfterSeconds: retry,
    },
  );
}
export const randomOpaque = (prefix) =>
  prefix + hex(crypto.getRandomValues(new Uint8Array(32)));
export async function tokenHash(value) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}
export const isAccessToken = (value) =>
  typeof value === "string" && /^ow1a\.[a-f0-9]{64}$/.test(value);
export const isRefreshToken = (value) =>
  typeof value === "string" && /^ow1r\.[a-f0-9]{64}$/.test(value);
export const isChallenge = (value) =>
  typeof value === "string" && /^ow1c\.[a-f0-9]{64}$/.test(value);
export function assertPassword(value) {
  // Native Auth uses bcrypt and checks the UTF-8 byte length, not JS UTF-16
  // units. Keep the exact input: trimming or normalization changes the secret.
  if (
    typeof value !== "string" ||
    Array.from(value).length < 12 ||
    encoder.encode(value).length > 72
  )
    throw ownerError("INVALID_REQUEST", 400);
}
export function assertTotp(value) {
  if (typeof value !== "string" || !/^\d{6}$/.test(value))
    throw ownerError("INVALID_REQUEST", 400);
}
function base64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}
function unbase64(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
export async function createSecretBox(serverSecret) {
  if (typeof serverSecret !== "string" || serverSecret.length < 24)
    throw ownerError("UNAVAILABLE", 503);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode("uniflow/owner-access/aes-gcm/v1\0" + serverSecret),
  );
  const key = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
  return {
    async seal(value, purpose) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: encoder.encode(purpose) },
        key,
        encoder.encode(JSON.stringify(value)),
      );
      return "v1." + base64(iv) + "." + base64(ciphertext);
    },
    async open(value, purpose) {
      try {
        const parts = value.split(".");
        if (parts.length !== 3 || parts[0] !== "v1") throw Error();
        const plaintext = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: unbase64(parts[1]),
            additionalData: encoder.encode(purpose),
          },
          key,
          unbase64(parts[2]),
        );
        return JSON.parse(new TextDecoder().decode(plaintext));
      } catch {
        throw ownerError("INVALID_PROOF", 401);
      }
    },
  };
}
export async function privateIpHash(serverSecret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(serverSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode("uniflow/owner-access/ip/v1\0" + value),
    ),
  );
}
export async function ownerCommand(db, operation, payload = {}) {
  const result = await db("rpc/owner_access_command", {
    method: "POST",
    body: JSON.stringify({ p_op: operation, p: payload }),
  });
  if (!result || typeof result !== "object")
    throw ownerError("UNAVAILABLE", 503);
  if (result.error) {
    const statuses = {
      INVALID_PROOF: 401,
      ACCESS_DENIED: 403,
      FLOW_CONFLICT: 409,
      RATE_LIMITED: 429,
      INVALID_REQUEST: 400,
    };
    const known = Object.hasOwn(statuses, result.error);
    throw ownerError(
      known ? result.error : "UNAVAILABLE",
      known ? statuses[result.error] : 503,
      Number(result.retryAfterSeconds) || 0,
    );
  }
  return result;
}
/** No legacy role, client email, JWT metadata or Telegram chat grants access. */
export async function verifyOwnerAccess(db, token) {
  if (!isAccessToken(token)) throw ownerError("INVALID_PROOF", 401);
  const result = await ownerCommand(db, "session.verify", {
    access_hash: await tokenHash(token),
  });
  if (
    !uuid.test(result.owner_uid || "") ||
    result.owner_email !== OWNER_EMAIL ||
    !uuid.test(result.id || "") ||
    !uuid.test(result.native_session_id || "")
  )
    throw ownerError("INVALID_PROOF", 401);
  return {
    id: result.owner_uid,
    role: "admin",
    email: OWNER_EMAIL,
    username: OWNER_EMAIL,
    name: "Араппаев Азат",
    sessionId: result.id,
    authSessionId: result.native_session_id,
    expiresAt: result.expires_at,
  };
}
export async function revokeOwnerAccess(db, token, all = false) {
  const owner = await verifyOwnerAccess(db, token);
  await ownerCommand(db, "session.revoke", { id: owner.sessionId, all });
  return owner;
}

export function serverConfiguration(env) {
  let secret;
  try {
    secret = JSON.parse(env.get("SUPABASE_SECRET_KEYS") || "{}").default;
  } catch {
    throw ownerError("UNAVAILABLE", 503);
  }
  const legacyKey = env.get("SUPABASE_SERVICE_ROLE_KEY");
  const key = secret || legacyKey;
  const api = env.get("SUPABASE_URL");
  let url;
  try {
    url = new URL(api);
  } catch {
    throw ownerError("UNAVAILABLE", 503);
  }
  if (
    !key ||
    key.length < 24 ||
    url.protocol !== "https:" ||
    !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) ||
    url.pathname !== "/" ||
    url.username ||
    url.password
  )
    throw ownerError("UNAVAILABLE", 503);
  return {
    api: url.origin,
    key,
    adminKey: legacyKey || key,
    encryptionSecret: key,
  };
}
export function createOwnerDatabase(configuration, fetcher = fetch) {
  return async (path, options = {}) => {
    if (path !== "rpc/owner_access_command")
      throw ownerError("UNAVAILABLE", 503);
    const response = await fetcher(configuration.api + "/rest/v1/" + path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        apikey: configuration.key,
        ...(!configuration.key.startsWith("sb_secret_")
          ? { Authorization: "Bearer " + configuration.key }
          : {}),
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw ownerError("UNAVAILABLE", 503);
    return response.json();
  };
}

function decodeClaims(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || token.length > 12000) throw Error();
    const encoded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(new TextDecoder().decode(unbase64(encoded)));
  } catch {
    throw ownerError("INVALID_PROOF", 401);
  }
}
/** Parsing email links never performs a request to the supplied URL. */
export function parseEmailProof(value, projectUrl, allowedTypes) {
  if (typeof value !== "string" || !value.trim() || value.length > 12000)
    throw ownerError("INVALID_REQUEST", 400);
  const input = value.trim();
  if (/^\d{6,8}$/.test(input)) return { token: input, type: "email" };
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(input))
    return { accessToken: input };
  let url;
  try {
    url = new URL(input);
  } catch {
    throw ownerError("INVALID_REQUEST", 400);
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== projectUrl ||
    url.pathname !== "/auth/v1/verify" ||
    url.username ||
    url.password
  )
    throw ownerError("INVALID_REQUEST", 400);
  const type = url.searchParams.get("type");
  const token =
    url.searchParams.get("token_hash") || url.searchParams.get("token");
  if (
    !allowedTypes.includes(type) ||
    !/^[A-Za-z0-9_-]{20,512}$/.test(token || "")
  )
    throw ownerError("INVALID_REQUEST", 400);
  return { type, token_hash: token };
}

/** Small REST adapter; no Auth SDK, JWTs or provider errors reach the UI. */
export function createAuthProvider(
  configuration,
  fetcher = fetch,
  now = Date.now,
) {
  async function request(
    path,
    body,
    bearer,
    method = "POST",
    admin = false,
    allowMissing = false,
  ) {
    const response = await fetcher(configuration.api + "/auth/v1" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        apikey: configuration.key,
        ...(bearer
          ? { Authorization: "Bearer " + bearer }
          : admin && !configuration.adminKey.startsWith("sb_secret_")
            ? { Authorization: "Bearer " + configuration.adminKey }
            : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    if (allowMissing && response.status === 404) return {};
    if (!response.ok) {
      if (response.status === 429)
        throw ownerError(
          "RATE_LIMITED",
          429,
          Math.min(900, Number(response.headers.get("retry-after")) || 60),
        );
      throw ownerError(
        response.status >= 500 ? "UNAVAILABLE" : "INVALID_PROOF",
        response.status >= 500 ? 503 : 401,
      );
    }
    if (response.status === 204) return {};
    const raw = await response.text();
    return raw ? JSON.parse(raw) : {};
  }
  async function verified(accessToken, { aal, method, since = 0 } = {}) {
    if (typeof accessToken !== "string") throw ownerError();
    // /user verifies the JWT with Auth before any decoded claim is trusted.
    const user = await request("/user", undefined, accessToken, "GET");
    const claims = decodeClaims(accessToken);
    if (
      !uuid.test(user?.id || "") ||
      user.email?.toLowerCase() !== OWNER_EMAIL ||
      (user.phone != null && user.phone !== "") ||
      !user.email_confirmed_at ||
      user.is_anonymous ||
      claims.sub !== user.id ||
      claims.iss !== configuration.api + "/auth/v1" ||
      !(Array.isArray(claims.aud)
        ? claims.aud.includes("authenticated")
        : claims.aud === "authenticated") ||
      !uuid.test(claims.session_id || "") ||
      typeof claims.exp !== "number" ||
      claims.exp * 1000 <= now() ||
      (aal && claims.aal !== aal)
    )
      throw ownerError("ACCESS_DENIED", 403);
    if (method) {
      const methods = Array.isArray(method) ? method : [method];
      if (
        !claims.amr?.some(
          (entry) =>
            methods.includes(entry.method) &&
            Number(entry.timestamp) * 1000 >= since - 1000 &&
            Number(entry.timestamp) * 1000 <= now() + 1000,
        )
      )
        throw ownerError("INVALID_PROOF", 401);
    }
    return { user, claims };
  }
  async function password(value) {
    assertPassword(value);
    const session = await request("/token?grant_type=password", {
      email: OWNER_EMAIL,
      password: value,
    });
    const identity = await verified(session.access_token, {
      method: "password",
      since: now() - 60000,
    });
    return { ...session, identity };
  }
  async function enroll(accessToken) {
    const { user } = await verified(accessToken);
    for (const factor of user.factors || [])
      if (
        factor.status === "unverified" &&
        factor.factor_type === "totp" &&
        factor.friendly_name?.startsWith("UniFlow owner")
      )
        await request(
          "/factors/" + factor.id,
          undefined,
          accessToken,
          "DELETE",
        );
    const result = await request(
      "/factors",
      {
        factor_type: "totp",
        friendly_name: "UniFlow owner " + crypto.randomUUID().slice(0, 8),
        issuer: "UniFlow",
      },
      accessToken,
    );
    if (
      !uuid.test(result.id || "") ||
      typeof result.totp?.secret !== "string" ||
      typeof result.totp?.uri !== "string" ||
      !result.totp.uri.startsWith("otpauth://totp/")
    )
      throw ownerError("UNAVAILABLE", 503);
    return {
      factorId: result.id,
      secret: result.totp.secret,
      uri: result.totp.uri,
    };
  }
  return {
    verified,
    password,
    enroll,
    async invite() {
      try {
        return await request(
          "/invite?redirect_to=" + encodeURIComponent(OWNER_REDIRECT),
          { email: OWNER_EMAIL },
          undefined,
          "POST",
          true,
        );
      } catch (error) {
        if (error?.code === "RATE_LIMITED") throw error;
        throw ownerError("MAIL_UNAVAILABLE", 503);
      }
    },
    async sendEmail() {
      try {
        return await request(
          "/otp?redirect_to=" + encodeURIComponent(OWNER_REDIRECT),
          {
            email: OWNER_EMAIL,
            create_user: false,
          },
        );
      } catch (error) {
        if (error?.code === "RATE_LIMITED") throw error;
        throw ownerError("MAIL_UNAVAILABLE", 503);
      }
    },
    async email(value, { setup = false, since = 0 } = {}) {
      const parsed = parseEmailProof(
        value,
        configuration.api,
        setup
          ? ["invite", "magiclink", "email", "recovery"]
          : ["magiclink", "email"],
      );
      const session = parsed.accessToken
        ? { access_token: parsed.accessToken }
        : await request("/verify", {
            ...parsed,
            ...(parsed.token ? { email: OWNER_EMAIL } : {}),
          });
      // Generic native `otp` also covers SMS. The database and /user checks
      // enforce an email-only owner with no phone or pending phone binding.
      // Native phone MFA uses a different AMR and cannot replace this proof.
      const identity = await verified(session.access_token, {
        method: ["otp", "invite", "magiclink", "recovery"],
        since,
      });
      return { ...session, identity };
    },
    async setPassword(accessToken, value) {
      assertPassword(value);
      await verified(accessToken);
      await request("/user", { password: value }, accessToken, "PUT");
      return password(value);
    },
    async totp(session, factorId, code) {
      assertTotp(code);
      if (!uuid.test(factorId || "")) throw ownerError();
      const challenge = await request(
        "/factors/" + factorId + "/challenge",
        {},
        session.access_token,
      );
      if (!uuid.test(challenge.id || "")) throw ownerError("UNAVAILABLE", 503);
      const verifiedSession = await request(
        "/factors/" + factorId + "/verify",
        { challenge_id: challenge.id, code },
        session.access_token,
      );
      const identity = await verified(verifiedSession.access_token, {
        aal: "aal2",
        method: "totp",
        since: now() - 60000,
      });
      if (identity.claims.session_id !== session.identity.claims.session_id)
        throw ownerError("INVALID_PROOF", 401);
      return { ...verifiedSession, identity };
    },
    async refresh(refreshToken, expectedSessionId) {
      const session = await request("/token?grant_type=refresh_token", {
        refresh_token: refreshToken,
      });
      const identity = await verified(session.access_token, { aal: "aal2" });
      if (identity.claims.session_id !== expectedSessionId) throw ownerError();
      return { ...session, identity };
    },
    async deleteFactor(userId, factorId) {
      if (!uuid.test(userId || "") || !uuid.test(factorId || ""))
        throw ownerError();
      return request(
        "/admin/users/" + userId + "/factors/" + factorId,
        undefined,
        undefined,
        "DELETE",
        true,
        true,
      );
    },
    async logout(accessToken, all = false) {
      return request(
        "/logout?scope=" + (all ? "global" : "local"),
        undefined,
        accessToken,
      );
    },
  };
}
