import { mutate, visible, validate, clone, uid, fail } from "./core.mjs";
import {
  isAccessToken,
  verifyOwnerAccess,
  revokeOwnerAccess,
} from "./owner-access.mjs";
import { sha, revokeSessions } from "./security.mjs";
const cors = {
  "Access-Control-Allow-Origin": "https://xan-xz.github.io",
  "Access-Control-Allow-Headers": "content-type,apikey",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Cache-Control": "no-store",
  Vary: "Origin",
};
const capabilities = {
  modelVersion: 2,
  teacherOverrides: true,
  logoutAll: true,
  allSubgroupTasks: true,
};
function answer(data, status = 200, publicRead = false) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors,
      ...(publicRead ? { "Access-Control-Allow-Origin": "*" } : {}),
      "Content-Type": "application/json",
    },
  });
}
async function db(path, options = {}) {
  let secret;
  try {
    secret = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default;
  } catch {
    // Older deployments can use the existing server-key fallback below.
  }
  const key = secret || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const headers = {
    apikey: key,
    "Content-Type": "application/json",
    ...(!secret ? { Authorization: "Bearer " + key } : {}),
    ...options.headers,
  };
  const res = await fetch(Deno.env.get("SUPABASE_URL") + "/rest/v1/" + path, {
    ...options,
    headers,
  });
  const raw = await res.text();
  if (!res.ok) {
    if (raw.includes("version_conflict"))
      fail("Данные уже изменились. Обнови страницу и повтори действие.", 409);
    throw new Error("Database request failed");
  }
  return raw ? JSON.parse(raw) : null;
}
async function actor(token) {
  if (!isAccessToken(token)) fail("Нужен вход владельца с 2FA", 401);
  return verifyOwnerAccess(db, token);
}
async function responseState(user, row) {
  const data = visible(row.data, user);
  let versions = [];
  if (user.role === "admin")
    versions = await db(
      "uf_versions?select=revision,actor,reason,created_at&order=revision.desc&limit=30",
    );
  return {
    data,
    revision: row.revision,
    user,
    users: [],
    versions,
    capabilities,
  };
}
async function boundedText(req, limit) {
  if (!req.body) return "";
  const reader = req.body.getReader();
  let bytes = new Uint8Array(0),
    length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const next = length + value.byteLength;
      if (next > limit) fail("Слишком большой запрос", 413);
      if (next > bytes.length) {
        const grown = new Uint8Array(
          Math.min(limit, Math.max(1024, next, bytes.length * 2)),
        );
        grown.set(bytes.subarray(0, length));
        bytes = grown;
      }
      bytes.set(value, length);
      length = next;
    }
    return new TextDecoder().decode(bytes.subarray(0, length));
  } catch (error) {
    // Do not let a failed or stalled producer cancellation delay the response.
    try {
      void reader.cancel().catch(() => {});
    } catch {
      /* best effort */
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function handle(req) {
  let body;
  if (req.method === "OPTIONS")
    return new Response(null, {
      headers: { ...cors, "Access-Control-Allow-Origin": "*" },
    });
  if (req.method !== "POST")
    return answer({ error: "Method not allowed" }, 405);
  try {
    if (Number(req.headers.get("content-length")) > 2000000)
      fail("Слишком большой запрос", 413);
    const raw = await boundedText(req, 2000000);
    try {
      body = JSON.parse(raw);
    } catch {
      fail("Некорректный запрос");
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      fail("Некорректный запрос");
    if (body.action === "login")
      fail(
        "Прежний вход отключён. Открой /schedule/admin/ для входа владельца с 2FA",
        410,
      );
    const publicRead = body.action === "state" && !body.token;
    const origin = req.headers.get("Origin");
    if (
      !publicRead &&
      origin !== null &&
      origin !== cors["Access-Control-Allow-Origin"]
    )
      fail("Источник запроса не разрешён", 403);
    if (body.action === "state") {
      let user;
      if (body.token) user = await actor(body.token);
      const [row] = await db("uf_platform?id=eq.1");
      if (!user) {
        const group =
          row.data.groups.find((g) => g.id === body.groupId) ||
          row.data.groups[0];
        user = {
          id: "guest",
          role: "guest",
          name: "Посетитель",
          groupId: group?.id || "",
          subgroup:
            body.subgroup === "all"
              ? "all"
              : group?.subgroups.includes(body.subgroup)
                ? body.subgroup
                : group?.subgroups[0] || "",
        };
      }
      return answer(await responseState(user, row), 200, publicRead);
    }
    // Old credentials can only revoke their own actual session identity.
    // They never enter actor() or provide access to the timetable workspace.
    if (["logout", "logout.all"].includes(body.action)) {
      if (isAccessToken(body.token)) {
        await revokeOwnerAccess(db, body.token, body.action === "logout.all");
        return answer({ ok: true });
      }
      if (typeof body.token === "string" && /^[a-f0-9]{64}$/.test(body.token)) {
        const tokenHash = await sha(body.token);
        const rows = await db(
          "uf_sessions?token_hash=eq." +
            tokenHash +
            "&expires_at=gt." +
            encodeURIComponent(new Date().toISOString()) +
            "&select=user_id",
        );
        const userId = rows[0]?.user_id;
        if (typeof userId !== "string" || !userId) fail("Сессия истекла", 401);
        if (body.action === "logout.all")
          await revokeSessions(db, { id: userId });
        else
          await db("uf_sessions?token_hash=eq." + tokenHash, {
            method: "DELETE",
          });
        return answer({ ok: true });
      }
    }
    const user = await actor(body.token);
    if (
      typeof body.action === "string" &&
      (body.action.startsWith("account.") ||
        body.action.startsWith("password."))
    )
      fail("Управление прежними аккаунтами и паролями отключено", 410);
    const [row] = await db("uf_platform?id=eq.1");
    if (body.action !== "mutate" && body.action !== "rollback")
      fail("Неизвестное действие");
    if (!Number.isSafeInteger(body.revision) || body.revision !== row.revision)
      fail("Данные изменились. Обнови страницу и повтори действие.", 409);
    let result;
    if (body.action === "rollback") {
      if (user.role !== "admin") fail("Откат доступен администратору", 403);
      if (!Number.isSafeInteger(body.target)) fail("Версия не найдена");
      const [version] = await db("uf_versions?revision=eq." + body.target);
      if (!version) fail("Версия уже недоступна");
      const data = clone(version.data);
      data.history = row.data.history.slice();
      const summary = "Восстановлена версия " + body.target;
      data.history.unshift({
        id: uid(),
        at: new Date().toISOString(),
        actor: user.name,
        action: "rollback",
        summary,
      });
      validate(data);
      result = { data, summary };
    } else {
      if (body.op === "attendance.save") {
        const [student] = await db(
          "uf_accounts?id=eq." +
            encodeURIComponent(String(body.payload?.studentId || "")) +
            "&role=eq.student&active=eq.true&select=id,group_id,subgroup,role,active",
        );
        const lesson = row.data.lessons.find(
          (l) => l.id === body.payload?.lessonId,
        );
        if (
          !student ||
          !lesson ||
          student.group_id !== lesson.groupId ||
          (lesson.subgroup !== "all" && student.subgroup !== lesson.subgroup)
        )
          fail("Студент не относится к этой паре");
      }
      result = mutate(row.data, user, body.op, body.payload);
    }
    if (
      body.action === "rollback" ||
      body.op === "import" ||
      JSON.stringify(row.data.groups) !== JSON.stringify(result.data.groups) ||
      JSON.stringify(row.data.teachers) !== JSON.stringify(result.data.teachers)
    ) {
      const accounts = await db(
        "uf_accounts?select=role,group_id,subgroup,teacher_id",
      );
      for (const account of accounts) {
        if (
          account.role === "student" &&
          !result.data.groups.some(
            (group) =>
              group.id === account.group_id &&
              group.subgroups?.includes(account.subgroup),
          )
        )
          fail("Изменение удалит группу или подгруппу существующего аккаунта");
        if (
          account.role === "teacher" &&
          !result.data.teachers.some(
            (teacher) => teacher.id === account.teacher_id,
          )
        )
          fail("Изменение удалит преподавателя существующего аккаунта");
      }
    }
    const committed = await db("rpc/uf_commit", {
      method: "POST",
      body: JSON.stringify({
        p_expected: row.revision,
        p_data: result.data,
        p_actor: user.name,
        p_reason: result.summary,
      }),
    });
    return answer(await responseState(user, committed));
  } catch (error) {
    return answer(
      {
        error: error.status
          ? error.message
          : "Сервер временно недоступен. Попробуй ещё раз.",
      },
      error.status || 503,
    );
  }
}
if (typeof Deno !== "undefined") Deno.serve(handle);
