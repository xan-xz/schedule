import { validDate } from "../app/lib/time.mjs";
import { equal } from "./security.mjs";

const maxClaims = 12;
const concurrency = 4;
const secretHeader = "X-UniFlow-Notification-Secret";
const clockTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const label = (value, length) =>
  typeof value === "string"
    ? Array.from(value.replace(/\s+/gu, " ").trim()).slice(0, length).join("")
    : "";

function slot(date, start, end, room) {
  if (!validDate(date) || !clockTime.test(start) || !clockTime.test(end))
    return null;
  const displayDate = date.split("-").reverse().join(".");
  const audience = label(room, 70);
  return `${displayDate}, ${start}–${end}${audience ? " · ауд. " + audience : ""}`;
}

export function telegramNotificationText(payload) {
  if (!payload || !["moved", "cancelled"].includes(payload.status)) return null;
  const group = label(payload.groupName, 80);
  const subject = label(payload.subject, 150);
  const before = slot(
    payload.originalDate,
    payload.originalStart,
    payload.originalEnd,
    payload.originalRoom,
  );
  if (!group || !subject || !before) return null;
  const subgroup = label(payload.subgroup, 30);
  const scope = `Группа ${group}${subgroup && subgroup !== "all" ? " · подгруппа " + subgroup : ""}`;
  if (payload.status === "cancelled")
    return ["🚫 Занятие отменено", subject, scope, before].join("\n");
  const after = slot(payload.date, payload.start, payload.end, payload.room);
  if (!after) return null;
  return [
    "🔔 Занятие перенесено",
    subject,
    scope,
    "Было " + before,
    "Стало " + after,
  ].join("\n");
}

function privateChat(value) {
  if (typeof value === "string" && /^[1-9][0-9]{0,15}$/u.test(value))
    value = Number(value);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function response(status, body) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function serverConfig(env) {
  let secret;
  try {
    secret = JSON.parse(env.get("SUPABASE_SECRET_KEYS") || "{}")?.default;
  } catch {
    // Legacy projects continue to use their service role key.
  }
  const serviceKey = secret || env.get("SUPABASE_SERVICE_ROLE_KEY");
  const project = env.get("SUPABASE_URL");
  const token = env.get("TELEGRAM_BOT_TOKEN");
  if (
    !/^[\w.-]+$/u.test(serviceKey || "") ||
    !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/u.test(project || "") ||
    !/^\d+:[A-Za-z0-9_-]{20,}$/u.test(token || "")
  )
    return null;
  return {
    rpcBase: new URL("/rest/v1/rpc/", project),
    botApi: `https://api.telegram.org/bot${token}/sendMessage`,
    headers: {
      apikey: serviceKey,
      "Content-Type": "application/json",
      ...(!secret ? { Authorization: "Bearer " + serviceKey } : {}),
    },
  };
}

function retryDelay(attempts) {
  const exponent = Number.isInteger(attempts)
    ? Math.min(7, Math.max(0, attempts - 1))
    : 0;
  return Math.min(3600, 30 * 2 ** exponent);
}

export function createTelegramNotificationWorker({ env, fetcher = fetch }) {
  return async (request) => {
    if (request.method !== "POST") return response(405, { ok: false });
    const secret = env.get("UNIFLOW_TELEGRAM_NOTIFICATION_SECRET");
    if (!/^[A-Za-z0-9_-]{32,256}$/u.test(secret || ""))
      return response(503, { ok: false });
    if (!equal(secret, request.headers.get(secretHeader)))
      return response(403, { ok: false });
    const config = serverConfig(env);
    if (!config) return response(503, { ok: false });
    const rpc = async (name, data) => {
      const result = await fetcher(new URL(name, config.rpcBase), {
        method: "POST",
        headers: config.headers,
        body: JSON.stringify(data),
        redirect: "error",
        signal: AbortSignal.timeout(4000),
      });
      if (!result.ok) throw Error("Notification storage unavailable");
      return result;
    };
    const post = async (chat, text, attempts) => {
      const delay = retryDelay(attempts);
      try {
        const result = await fetcher(config.botApi, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chat,
            text,
            link_preview_options: { is_disabled: true },
          }),
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        });
        const body = await result.json().catch(() => null);
        if (result.ok && body?.ok === true) return ["sent", 0];
        const code = result.ok ? body?.error_code : result.status;
        if (code === 403) return ["blocked", 0];
        if (code === 400) return ["discard", 0];
        if (code === 429) {
          const wait = body?.parameters?.retry_after;
          return [
            "retry",
            Number.isSafeInteger(wait) && wait > 0
              ? Math.min(wait, 86400)
              : delay,
          ];
        }
      } catch {
        // A timeout may occur after Telegram has accepted the message.
      }
      return ["retry", delay];
    };

    let records;
    try {
      records = await (
        await rpc("uf_telegram_claim_notifications", { p_limit: maxClaims })
      ).json();
      if (!Array.isArray(records) || records.length > maxClaims)
        return response(503, { ok: false });
    } catch {
      return response(503, { ok: false });
    }
    const counts = {
      claimed: records.length,
      sent: 0,
      retry: 0,
      discard: 0,
      blocked: 0,
      stale: 0,
      failed: 0,
    };
    const grouped = new Map();
    for (const record of records) {
      if (
        typeof record?.id !== "string" ||
        typeof record.lease_token !== "string" ||
        !uuid.test(record.id) ||
        !uuid.test(record.lease_token)
      ) {
        counts.failed++;
        continue;
      }
      const chat = privateChat(record.chat_id);
      const batch = grouped.get(chat) || [];
      batch.push({ ...record, chat });
      grouped.set(chat, batch);
    }
    const chats = [...grouped.values()];
    await Promise.all(
      Array.from({ length: Math.min(concurrency, chats.length) }, async () => {
        while (chats.length) {
          const batch = chats.shift();
          let blocked = false;
          for (const record of batch) {
            const text = telegramNotificationText(record.payload);
            const [outcome, delay] = blocked
              ? ["blocked", 0]
              : record.chat && text
                ? await post(record.chat, text, record.attempts)
                : ["discard", 0];
            blocked ||= outcome === "blocked";
            try {
              const acknowledgement = await rpc(
                "uf_telegram_finish_notification",
                {
                  p_id: record.id,
                  p_lease_token: record.lease_token,
                  p_outcome: outcome,
                  p_delay_seconds: delay,
                },
              );
              const accepted = await acknowledgement.json();
              if (accepted === true) counts[outcome]++;
              else if (accepted === false) counts.stale++;
              else counts.failed++;
            } catch {
              counts.failed++;
            }
          }
        }
      }),
    );
    return response(counts.failed ? 503 : 200, {
      ok: counts.failed === 0,
      ...counts,
    });
  };
}
