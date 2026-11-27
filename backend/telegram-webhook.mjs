import { facultyChoices, groupFaculty, isGroupActive } from "./group-state.mjs";
import { equal, sha } from "./security.mjs";
import {
  answerScheduleQuestion,
  parseScheduleQuestion,
} from "./ai-queries.mjs";
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
const bold = (text) => ({ text });
const periodLabels = { today: "Сегодня", next: "Завтра", week: "Неделя" };
const facultyButton = () => [button("‹ К факультетам", "faculties:0")];
const siteButton = (url = site) => ({ text: "Открыть на сайте", url });
const dateLabel = new Intl.DateTimeFormat("ru", {
  timeZone: "UTC",
  weekday: "long",
  day: "numeric",
  month: "long",
});

function menu(lines, rows, more = "Остальные занятия — на сайте.") {
  let text = "";
  const entities = [];
  for (const line of lines) {
    const value = typeof line === "string" ? line : line.text;
    const offset = text.length ? text.length + 1 : 0;
    if (offset + value.length > 3800) {
      text = text.replace(/\n+$/, "") + "\n\n" + more;
      break;
    }
    if (typeof line !== "string")
      entities.push({ type: "bold", offset, length: value.length });
    text += (offset ? "\n" : "") + value;
  }
  return { text, entities, reply_markup: { inline_keyboard: rows } };
}

function helpMenu() {
  return menu(
    [
      bold("Как посмотреть расписание"),
      "",
      "Выбери факультет, группу и подгруппу. Если твоей группы нет в списках факультетов, загляни в «Без факультета».",
      "",
      "Кнопки «Сегодня», «Завтра» и «Неделя» переключают расписание. Чтобы выбрать другую группу, нажми «Сменить группу».",
      "",
      "Можно написать «Какие пары завтра у группы ИТ-21?» или ответить на сообщение с расписанием вопросом «Какая следующая пара?». Бот понимает вопросы на русском и казахском.",
    ],
    [[button("Выбрать группу", "faculties:0")], [siteButton()]],
  );
}

async function listPage(records, index, action, option) {
  const max = Math.max(0, Math.ceil(records.length / pageSize) - 1);
  const page = Math.min(index, max);
  const rows = await Promise.all(
    records
      .slice(page * pageSize, (page + 1) * pageSize)
      .map(async (record) => [await option(record)]),
  );
  const nav = [];
  if (page > 0) nav.push(button("‹ Назад", action + (page - 1)));
  if (page < max) nav.push(button("Дальше ›", action + (page + 1)));
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
  const lines = [bold("📅 " + periodLabels[period] + " · " + clip(group.name))];
  if (group.subgroups.length)
    lines.push(
      subgroup === "all" ? "Все подгруппы" : "Подгруппа " + clip(subgroup),
    );
  for (let i = 0; i < (period === "week" ? 7 : 1); i++) {
    const date = addDays(start, i);
    const day = dateLabel.format(new Date(date + "T12:00:00Z"));
    lines.push("", bold(day[0].toUpperCase() + day.slice(1)));
    const lessons = lessonsForDate(data, date, { groupId: group.id, subgroup });
    if (!lessons.length) lines.push("Занятий нет.");
    for (const [index, lesson] of lessons.entries()) {
      // On the day view, leave space between lesson details.
      if (index && period !== "week") lines.push("");
      lines.push(
        bold(
          lesson.start +
            "–" +
            lesson.end +
            " · " +
            clip(names.subjects.get(lesson.subjectId) || "Занятие"),
        ),
      );
      const room = names.rooms.get(lesson.roomId);
      const teacher = names.teachers.get(lesson.teacherId);
      const status = lesson.cancelled
        ? "Отменено"
        : lesson.exception
          ? "Перенос или замена"
          : "";
      const details = [
        status,
        subgroup === "all" &&
          lesson.subgroup &&
          lesson.subgroup !== "all" &&
          "Подгруппа " + clip(lesson.subgroup, 24),
        room && "📍 " + clip(room, 40),
        teacher && clip(teacher, 60),
      ].filter(Boolean);
      if (details.length) lines.push(details.join(" · "));
    }
  }
  if (period !== "week")
    lines.push(
      "",
      "Ответь на это сообщение, чтобы задать вопрос о расписании.",
    );
  return lines;
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
      return menu(
        [bold(clip(faculty.name)), "", "Выбери свою группу."],
        [...rows, facultyButton()],
      );
    }
  }
  if (["group", "time"].includes(action)) {
    const group = await byKey(groups, first);
    if (group) {
      const subgroups = ["all", ...group.subgroups];
      const subgroupKeys = await Promise.all(subgroups.map(key));
      const facultyId = groupFaculty(group);
      const groupIndex = groups
        .filter((item) => groupFaculty(item) === facultyId)
        .findIndex((item) => item.id === group.id);
      const groupsPage =
        "faculty:" +
        (await key(facultyId)) +
        ":" +
        Math.floor(groupIndex / pageSize);
      if (action === "group" && subgroups.length > 1)
        return menu(
          [bold("Группа " + clip(group.name)), "", "Какая у тебя подгруппа?"],
          [
            ...subgroups.map((subgroup, i) => [
              button(
                subgroup === "all" ? "Все подгруппы" : subgroup,
                "time:" + first + ":" + subgroupKeys[i] + ":today",
              ),
            ]),
            [button("‹ К группам", groupsPage)],
          ],
        );
      const period = action === "group" ? "today" : third;
      const subgroupIndex =
        action === "group" ? 0 : subgroupKeys.indexOf(second);
      const subgroup = subgroups[subgroupIndex];
      if (subgroup && Object.hasOwn(periodLabels, period)) {
        const url = new URL(site);
        url.searchParams.set("g", group.id);
        url.searchParams.set("subgroup", subgroup);
        return menu(timetable(data, group, subgroup, period, now), [
          Object.entries(periodLabels).map(([option, label]) => ({
            ...button(
              option === period ? "✓ " + label : label,
              "time:" +
                first +
                ":" +
                subgroupKeys[subgroupIndex] +
                ":" +
                option,
            ),
            ...(option === period ? { style: "primary" } : {}),
          })),
          [
            button("Сменить группу", groupsPage),
            ...(subgroups.length > 1
              ? [button("Подгруппа", "group:" + first)]
              : []),
          ],
          [siteButton(url.href)],
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
    [
      bold("📅 Расписание UniFlow"),
      "",
      rows.length
        ? "Привет! Выбери факультет, чтобы найти расписание своей группы."
        : "Расписание пока не опубликовано. Загляни чуть позже.",
      ...(rows.length
        ? [
            "",
            "Можно написать вопрос о расписании и указать номер своей группы.",
          ]
        : []),
    ],
    rows.length ? rows : [[siteButton()]],
  );
}

function scheduleQuestionMenu(data, message, now) {
  const reply = message.reply_to_message;
  let context;
  if (
    reply?.from?.is_bot === true &&
    reply.chat?.id === message.chat.id &&
    !reply.forward_origin &&
    typeof reply.text === "string"
  ) {
    const [title, scope] = reply.text.split("\n", 2);
    const divider = title.indexOf(" · ");
    const name = divider >= 0 ? title.slice(divider + 3) : "";
    const group = data.groups.find(
      (item) => isGroupActive(item) && name === clip(item.name),
    );
    if (group) {
      const subgroup = group.subgroups?.find((item) =>
        ["Подгруппа ", "Кіші топ "].some(
          (prefix) => scope === prefix + clip(item, 24),
        ),
      );
      context = { groupId: group.id, subgroup };
    }
  }
  const answer = answerScheduleQuestion(data, message.text, { now, context });
  if (!answer) return null;
  const rows = [
    [
      button(
        answer.language === "kk" ? "Топты таңдау" : "Выбрать группу",
        "faculties:0",
      ),
    ],
  ];
  if (!answer.groupId) return menu(answer.lines, rows);
  const url = new URL(site);
  url.searchParams.set("g", answer.groupId);
  url.searchParams.set("subgroup", answer.subgroup);
  rows.push([
    answer.language === "kk"
      ? { text: "Сайттан ашу", url: url.href }
      : siteButton(url.href),
  ]);
  return menu(
    [bold(answer.lines[0]), ...answer.lines.slice(1)],
    rows,
    answer.language === "kk" ? "Қалған сабақтар сайтта." : undefined,
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
    const command = /^\/(start|help|schedule)(?:@\w+)?(?:\s|$)/i
      .exec(message.text || "")?.[1]
      .toLowerCase();
    const at = now();
    const question =
      !callback && !command && parseScheduleQuestion(message.text, at);
    if (!callback && !command && !question)
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
      let settings;
      if (!callback && command === "help") {
        settings = helpMenu();
      } else {
        const state = await post(
          project.origin + "/functions/v1/uniflow-api",
          { action: "state", subgroup: "all" },
          { apikey: publishable },
        );
        if (state.user?.role !== "guest" || !Array.isArray(state.data?.groups))
          throw Error("Published schedule is unavailable");
        settings = question
          ? scheduleQuestionMenu(state.data, message, at)
          : await telegramScheduleMenu(state.data, callback?.data, at);
        if (!settings) return new Response(null, { status: 204 });
      }
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
