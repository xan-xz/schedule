import { facultyChoices, groupFaculty, isGroupActive } from "./group-state.mjs";
import { equal, sha } from "./security.mjs";
import {
  addDays,
  lessonsForDate,
  localDate,
  monday,
} from "../app/lib/time.mjs";

const maxUpdateBytes = 65_536;
const pageSize = 10;
const site = "https://xan-xz.github.io/schedule/";
const key = async (value) => (await sha(value)).slice(0, 20);
const clip = (value, length = 90) =>
  Array.from(String(value)).slice(0, length).join("");
const button = (text, callback_data) => ({ text: clip(text), callback_data });
const menu = (text, rows) => ({
  text,
  reply_markup: { inline_keyboard: rows },
});
const facultyButton = () => [button("Выбрать факультет", "faculties:0")];
const dateLabel = new Intl.DateTimeFormat("ru", {
  timeZone: "UTC",
  weekday: "long",
  day: "numeric",
  month: "short",
});

async function listPage(records, index, action, option) {
  const max = Math.max(0, Math.ceil(records.length / pageSize) - 1);
  const page = Math.min(index, max);
  const rows = await Promise.all(
    records
      .slice(page * pageSize, (page + 1) * pageSize)
      .map(async (record) => [await option(record)]),
  );
  const nav = [];
  if (page > 0) nav.push(button("Назад", action + (page - 1)));
  if (page < max) nav.push(button("Дальше", action + (page + 1)));
  if (nav.length) rows.push(nav);
  return rows;
}

async function byKey(records, value) {
  if (!/^[0-9a-f]{20}$/.test(value || "")) return undefined;
  for (const record of records)
    if ((await key(record.id)) === value) return record;
}

function timetable(data, group, subgroup, period, now) {
  const today = localDate(now);
  const start =
    period === "week"
      ? monday(today)
      : addDays(today, period === "next" ? 1 : 0);
  const names = Object.fromEntries(
    ["subjects", "rooms", "teachers"].map((kind) => [
      kind,
      new Map(data[kind].map((row) => [row.id, row.name])),
    ]),
  );
  const lines = [
    clip(group.name),
    ...(subgroup === "all" ? [] : ["Подгруппа " + clip(subgroup)]),
  ];
  for (let i = 0; i < (period === "week" ? 7 : 1); i++) {
    const date = addDays(start, i);
    lines.push("", dateLabel.format(new Date(date + "T12:00:00Z")));
    const lessons = lessonsForDate(data, date, { groupId: group.id, subgroup });
    if (!lessons.length) lines.push("Занятий нет.");
    for (const lesson of lessons)
      lines.push(
        [
          lesson.start + "–" + lesson.end,
          clip(names.subjects.get(lesson.subjectId) || "Занятие"),
          lesson.cancelled
            ? "Отменено"
            : lesson.exception
              ? "Перенос / замена"
              : "",
          lesson.roomId && clip(names.rooms.get(lesson.roomId) || "", 40),
          lesson.teacherId &&
            clip(names.teachers.get(lesson.teacherId) || "", 60),
        ]
          .filter(Boolean)
          .join(" · "),
      );
  }
  const message = lines.join("\n");
  if (message.length <= 3900) return message;
  const boundary = message.lastIndexOf("\n", 3800);
  return message.slice(0, boundary) + "\n\nПолное расписание — на сайте.";
}

export async function telegramScheduleMenu(
  data,
  callback = "",
  now = new Date(),
) {
  const faculties = facultyChoices(data, "Без факультета");
  const groups = data.groups.filter(isGroupActive);
  const [action, first, second, third] = callback.split(":");
  const page = (value) => (/^\d{1,4}$/.test(value || "") ? Number(value) : 0);
  if (action === "faculty") {
    const faculty = await byKey(faculties, first);
    if (faculty) {
      const listed = groups.filter(
        (group) => groupFaculty(group) === faculty.id,
      );
      const rows = await listPage(
        listed,
        page(second),
        "faculty:" + first + ":",
        async (group) => button(group.name, "group:" + (await key(group.id))),
      );
      return menu(clip(faculty.name) + "\nВыбери группу.", [
        ...rows,
        facultyButton(),
      ]);
    }
  }
  if (["group", "time"].includes(action)) {
    const group = await byKey(groups, first);
    if (group) {
      const subgroups = ["all", ...group.subgroups];
      const subgroupKeys = await Promise.all(subgroups.map(key));
      if (action === "group")
        return menu(clip(group.name) + "\nВыбери подгруппу.", [
          ...subgroups.map((subgroup, i) => [
            button(
              subgroup === "all" ? "Все подгруппы" : subgroup,
              "time:" + first + ":" + subgroupKeys[i] + ":today",
            ),
          ]),
          facultyButton(),
        ]);
      const subgroup = subgroups[subgroupKeys.indexOf(second)];
      if (subgroup && ["today", "next", "week"].includes(third)) {
        const url = new URL(site);
        url.searchParams.set("g", group.id);
        url.searchParams.set("subgroup", subgroup);
        return menu(timetable(data, group, subgroup, third, now), [
          [
            ["today", "Сегодня"],
            ["next", "Завтра"],
            ["week", "Неделя"],
          ].map(([period, label]) =>
            button(label, "time:" + first + ":" + second + ":" + period),
          ),
          [
            button("Подгруппа", "group:" + first),
            { text: "Открыть сайт", url: url.href },
          ],
          facultyButton(),
        ]);
      }
    }
  }
  const rows = await listPage(
    faculties,
    page(first),
    "faculties:",
    async (faculty) =>
      button(faculty.name, "faculty:" + (await key(faculty.id)) + ":0"),
  );
  return menu(
    rows.length
      ? "Расписание UniFlow\nВыбери факультет."
      : "Расписание UniFlow пока не опубликовано.",
    rows,
  );
}

async function readUpdate(request) {
  if (!request.body) return null;
  if (Number(request.headers.get("content-length")) > maxUpdateBytes)
    return null;
  const reader = request.body.getReader();
  const bytes = new Uint8Array(maxUpdateBytes);
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (size + value.length > bytes.length) {
        void reader.cancel().catch(() => {});
        return null;
      }
      bytes.set(value, size);
      size += value.length;
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)),
    );
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

export function createTelegramWebhook({
  env,
  fetcher = fetch,
  now = () => new Date(),
}) {
  async function post(url, body, headers = {}) {
    const response = await fetcher(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const result = await response.json();
    if (!response.ok) {
      // Telegram treats an already-rendered menu as a 400 on callback replay.
      if (
        response.status === 400 &&
        url.endsWith("/editMessageText") &&
        typeof result.description === "string" &&
        result.description.includes("message is not modified")
      )
        return { ok: true };
      throw Error("Telegram integration upstream unavailable");
    }
    return result;
  }
  return async (request) => {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const secret = env.get("TELEGRAM_WEBHOOK_SECRET");
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret || ""))
      return new Response(null, { status: 503 });
    if (!equal(secret, request.headers.get("X-Telegram-Bot-Api-Secret-Token")))
      return new Response(null, { status: 403 });
    const update = await readUpdate(request);
    if (!update || !Number.isSafeInteger(update.update_id))
      return new Response(null, { status: 400 });
    const callback = update.callback_query;
    const message = callback?.message || update.message;
    const chat = message?.chat;
    if (
      chat?.type !== "private" ||
      !Number.isSafeInteger(chat.id) ||
      chat.id <= 0 ||
      chat.id !== (callback?.from || message.from)?.id
    )
      return new Response(null, { status: 204 });
    if (
      callback &&
      (typeof callback.id !== "string" ||
        callback.id.length > 128 ||
        !Number.isSafeInteger(message.message_id) ||
        message.message_id <= 0 ||
        !/^[a-z0-9:]{1,64}$/.test(callback.data || ""))
    )
      return new Response(null, { status: 204 });
    if (
      !callback &&
      !/^\/(?:start|help|schedule)(?:@\w+)?(?:\s|$)/i.test(message.text || "")
    )
      return new Response(null, { status: 204 });
    try {
      const token = env.get("TELEGRAM_BOT_TOKEN");
      const project = new URL(env.get("SUPABASE_URL"));
      const publishable =
        env.get("UNIFLOW_TELEGRAM_PUBLISHABLE_KEY") ||
        env.get("SUPABASE_ANON_KEY");
      if (
        !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token || "") ||
        !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(project.origin) ||
        !publishable
      )
        throw Error("Telegram integration is unconfigured");
      const telegram = (method, body) =>
        post("https://api.telegram.org/bot" + token + "/" + method, body);
      if (callback)
        await telegram("answerCallbackQuery", {
          callback_query_id: callback.id,
        }).catch(() => {});
      const state = await post(
        project.origin + "/functions/v1/uniflow-api",
        { action: "state", subgroup: "all" },
        { apikey: publishable },
      );
      if (state.user?.role !== "guest" || !Array.isArray(state.data?.groups))
        throw Error("Published schedule is unavailable");
      const settings = await telegramScheduleMenu(
        state.data,
        callback?.data,
        now(),
      );
      await telegram(callback ? "editMessageText" : "sendMessage", {
        chat_id: chat.id,
        ...(callback ? { message_id: message.message_id } : {}),
        link_preview_options: { is_disabled: true },
        ...settings,
      });
      return new Response(null, { status: 204 });
    } catch {
      return new Response(null, { status: 503 });
    }
  };
}
