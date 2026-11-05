import { generateIcs } from "../beta/lib/calendar.mjs";
import { localDate } from "../beta/lib/time.mjs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
  "Access-Control-Allow-Headers": "if-none-match",
  "Access-Control-Expose-Headers": "etag,last-modified",
  "X-Content-Type-Options": "nosniff",
};
const failure = (message, status) =>
  new Response(message, {
    status,
    headers: {
      ...cors,
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });

/** Public calendar subscription, intentionally independent of login/session cookies. */
export async function handle(req) {
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers: cors });
  if (!["GET", "HEAD"].includes(req.method))
    return failure("Method not allowed", 405);
  const url = new URL(req.url);
  const groupId =
    url.searchParams.get("group") ||
    url.searchParams.get("groupId") ||
    "g-main";
  const selectedSubgroup = url.searchParams.get("subgroup");
  const reminder = Number(url.searchParams.get("reminder") || 0);
  if (
    groupId.length > 100 ||
    (selectedSubgroup?.length || 0) > 15 ||
    !Number.isInteger(reminder) ||
    reminder < 0 ||
    reminder > 1440
  )
    return failure("Invalid calendar parameters", 400);
  try {
    const apiUrl = Deno.env.get("SUPABASE_URL");
    let secret;
    try {
      secret = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default;
    } catch {
      /* use service-role fallback */
    }
    const key = secret || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!apiUrl || !key)
      return failure("Calendar temporarily unavailable", 503);
    const response = await fetch(
      apiUrl + "/rest/v1/uf_platform?id=eq.1&select=data,revision,updated_at",
      {
        headers: {
          apikey: key,
          ...(!secret ? { Authorization: "Bearer " + key } : {}),
        },
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok) return failure("Calendar temporarily unavailable", 503);
    const [row] = await response.json();
    if (
      !row?.data ||
      !Array.isArray(row.data.groups) ||
      !Array.isArray(row.data.lessons)
    )
      return failure("Calendar temporarily unavailable", 503);
    const group = row.data.groups.find((item) => item.id === groupId);
    if (!group) return failure("Group not found", 404);
    const subgroup = selectedSubgroup || group.subgroups[0];
    if (subgroup !== "all" && !group.subgroups.includes(subgroup))
      return failure("Subgroup not found", 400);
    // Only public teaching data enters the feed; no role data or personal tasks.
    const data = {};
    for (const field of [
      "groups",
      "subjects",
      "teachers",
      "rooms",
      "lessons",
      "exceptions",
      "holidays",
    ])
      data[field] = row.data[field] || [];
    for (const field of ["validFrom", "validUntil"])
      if (row.data[field]) data[field] = row.data[field];
    const updated = Number.isFinite(Date.parse(row.updated_at))
      ? new Date(row.updated_at)
      : new Date(0);
    const body = generateIcs(
      data,
      { groupId, subgroup },
      {
        startDate: localDate(),
        days: 112,
        reminderMinutes: reminder,
        now: updated,
      },
    );
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(body),
    );
    const etag =
      '"' +
      Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("") +
      '"';
    const headers = {
      ...cors,
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="uniflow.ics"',
      "Cache-Control": "public, max-age=300, stale-while-revalidate=60",
      ETag: etag,
      "Last-Modified": updated.toUTCString(),
    };
    const matches = (req.headers.get("if-none-match") || "")
      .split(",")
      .map((value) => value.trim());
    if (
      matches.includes(etag) ||
      matches.includes("W/" + etag) ||
      matches.includes("*")
    )
      return new Response(null, { status: 304, headers });
    return new Response(req.method === "HEAD" ? null : body, { headers });
  } catch {
    return failure("Calendar temporarily unavailable", 503);
  }
}
if (typeof Deno !== "undefined") Deno.serve(handle);
