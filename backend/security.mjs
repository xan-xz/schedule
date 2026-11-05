// Server-only helpers. No credentials are stored in this module.
const hex = (value) =>
  Array.from(new Uint8Array(value))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
export const sha = async (value) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
export async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return hex(
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: new TextEncoder().encode(salt),
        iterations: 210000,
      },
      key,
      256,
    ),
  );
}
export function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length)
    return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++)
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
export async function reserveLogin(db, req, username) {
  // The managed gateway must replace, rather than append to, the forwarded IP header.
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  return db("rpc/uf_login_attempt", {
    method: "POST",
    body: JSON.stringify({
      p_ip_hash: await sha("uniflow:ip:" + ip),
      p_account_hash: await sha("uniflow:account:" + username),
    }),
  });
}
export const delayFailure = () =>
  new Promise((resolve) =>
    setTimeout(
      resolve,
      450 + (crypto.getRandomValues(new Uint8Array(1))[0] % 151),
    ),
  );
export async function revokeSessions(db, user) {
  // One RPC transaction revokes both generations of the built-in admin's sessions.
  return db("rpc/uf_revoke_sessions", {
    method: "POST",
    body: JSON.stringify({ p_user_id: user.id }),
  });
}
