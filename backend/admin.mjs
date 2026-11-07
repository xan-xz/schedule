import { sha, revokeSessions } from "./security.mjs";
// Cutover policy: the unified editor writes uf_platform. Keep the legacy table
// readable, but never let an old open tab claim it published to all students.
// This endpoint can only retire old credentials. Owner authentication never
// falls back to the archived password or an old administrative session.
export const LEGACY_WRITES_ENABLED = false;
const origin = "https://xan-xz.github.io";
const cors = {
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Headers": "content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
  Vary: "Origin",
};
async function rest(path, options = {}) {
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const res = await fetch(Deno.env.get("SUPABASE_URL") + "/rest/v1/" + path, {
    ...options,
    headers: {
      apikey: key,
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) throw new Error("Database request failed");
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
function reply(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
export async function handle(req) {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  if (Number(req.headers.get("content-length")) > 100000)
    return reply({ error: "Слишком большой запрос" }, 413);
  try {
    const raw = await req.text();
    if (raw.length > 100000)
      return reply({ error: "Слишком большой запрос" }, 413);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return reply({ error: "Некорректный запрос" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      return reply({ error: "Некорректный запрос" }, 400);
    if (body.action === "login") {
      return reply(
        {
          error:
            "Прежний вход отключён. Открой /schedule/admin/ для входа владельца с 2FA.",
        },
        410,
      );
    }
    if (typeof body.token !== "string" || !/^[a-f0-9]{64}$/.test(body.token))
      return reply({ error: "Войди как администратор" }, 401);
    const tokenHash = await sha(body.token);
    const sessions = await rest(
      "schedule_sessions?token_hash=eq." +
        tokenHash +
        "&expires_at=gt." +
        encodeURIComponent(new Date().toISOString()) +
        "&select=expires_at",
    );
    if (!sessions.length)
      return reply({ error: "Сессия истекла. Войди заново." }, 401);
    if (body.action === "logout") {
      await rest("schedule_sessions?token_hash=eq." + tokenHash, {
        method: "DELETE",
      });
      return reply({ ok: true });
    }
    if (body.action === "logout.all") {
      await revokeSessions(rest, { id: "admin" });
      return reply({ ok: true });
    }
    if (body.action !== "save")
      return reply({ error: "Неизвестное действие" }, 400);
    return reply(
      { error: "Прежний редактор отключён. Открой /schedule/admin/." },
      410,
    );
  } catch {
    return reply(
      { error: "Сервер временно недоступен. Попробуй ещё раз." },
      503,
    );
  }
}
if (typeof Deno !== "undefined") Deno.serve(handle);
