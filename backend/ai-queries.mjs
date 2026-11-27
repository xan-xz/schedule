import { isGroupActive } from "./group-state.mjs";
import {
  addDays,
  changesForDate,
  dayOf,
  lessonsForDate,
  localDate,
  monday,
  validDate,
} from "../app/lib/time.mjs";

const months = [
  ["января", "қаңтар"],
  ["февраля", "ақпан"],
  ["марта", "наурыз"],
  ["апреля", "сәуір"],
  ["мая", "мамыр"],
  ["июня", "маусым"],
  ["июля", "шілде"],
  ["августа", "тамыз"],
  ["сентября", "қыркүйек"],
  ["октября", "қазан"],
  ["ноября", "қараша"],
  ["декабря", "желтоқсан"],
];
const weekdays = [
  /^(?:понедельник|дүйсенбі)/u,
  /^(?:вторник|сейсенбі)/u,
  /^(?:сред[ауые]|сәрсенбі)/u,
  /^(?:четверг|бейсенбі)/u,
  /^(?:пятниц|жұма)/u,
  /^(?:суббот|сенбі)/u,
  /^(?:воскресень|жексенбі)/u,
];
const lessonTypes = {
  laboratory: /^(?:лаборатор|зертхан)/u,
  lecture: /^(?:лекци|дәріс)/u,
  practice: /^(?:практи|тәжіриб)/u,
  seminar: /^(?:семинар)/u,
};
const weekWord = /^(?:недел|апта)/u;
const nextWord = /^(?:следующ|ближайш|келесі)/u;
const relativeDays = [
  /^(?:вчера|кеше)$/u,
  /^(?:сегодня|бүгін)(?:гі)?$/u,
  /^(?:завтра|ертең)(?:гі)?$/u,
  /^(?:послезавтра|бүрсігүні)$/u,
];
const copies = {
  ru: {
    day: "Расписание",
    week: "Расписание на неделю",
    next: "Ближайшие занятия",
    current: "Занятия сейчас",
    room: "Где проходят занятия",
    changes: "Изменения в расписании",
    group:
      "Укажи группу в вопросе или ответь на сообщение бота с её расписанием.",
    subgroup: "Уточни подгруппу или напиши «все подгруппы».",
    subject:
      "Уточни название предмета. В расписании группы есть несколько совпадений.",
    subgroupLabel: "Подгруппа",
    all: "Все подгруппы",
    invalidDate: "Укажи реальную дату, например 27.11.2026.",
    empty: "Подходящих занятий не найдено.",
    noChanges: "В этот период переносов и отмен не найдено.",
    noRoom: "Аудитория не указана",
    lesson: "Занятие",
    cancelled: "Отменено",
    moved: "Перенос или замена",
  },
  kk: {
    day: "Сабақ кестесі",
    week: "Апталық сабақ кестесі",
    next: "Келесі сабақтар",
    current: "Қазір өтіп жатқан сабақтар",
    room: "Сабақ өтетін аудиториялар",
    changes: "Сабақ кестесіндегі өзгерістер",
    group:
      "Сұрағыңда топты көрсет немесе боттың сол топтың кестесі бар хабарына жауап бер.",
    subgroup: "Кіші топты нақтыла немесе «барлық кіші топ» деп жаз.",
    subject: "Пән атауын нақтыла. Топ кестесінде бірнеше сәйкестік бар.",
    subgroupLabel: "Кіші топ",
    all: "Барлық кіші топ",
    invalidDate: "Дұрыс күнді көрсет, мысалы 27.11.2026.",
    empty: "Сұрағыңа сәйкес сабақ табылмады.",
    noChanges: "Бұл аралықта ауыстырылған немесе өтпейтін сабақ жоқ.",
    noRoom: "Аудитория көрсетілмеген",
    lesson: "Сабақ",
    cancelled: "Өтпейді",
    moved: "Ауыстырылды",
  },
};

const normal = (value) =>
  String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll("ё", "е");
const toWords = (value) => normal(value).match(/[\p{L}\p{N}]+/gu) || [];
const wordsWithSpaces = (words) => ` ${words.join(" ")} `;
const contains = (phrase, value) =>
  !!value && phrase.includes(wordsWithSpaces(toWords(value)));
const label = (value, maximum = 90) =>
  Array.from(
    String(value ?? "")
      .replaceAll(/\s+/gu, " ")
      .trim(),
  )
    .slice(0, maximum)
    .join("");
function dateText(date, language) {
  const [, month, day] = date.split("-");
  return `${Number(day)} ${months[Number(month) - 1][language === "kk" ? 1 : 0]}`;
}

function requestedDate(text, words, today) {
  const year = today.slice(0, 4);
  const iso = /\b(\d{4}-\d{2}-\d{2})(?![\d-])/u.exec(text);
  if (iso) return { date: iso[1], days: 1 };
  const numeric = /\b(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?(?![.\d])/u.exec(text);
  if (numeric)
    return {
      date: `${numeric[3] || year}-${numeric[2].padStart(2, "0")}-${numeric[1].padStart(2, "0")}`,
      days: 1,
    };
  for (const [index, word] of words.entries()) {
    const month = months.findIndex((names) => names.includes(word));
    const day = words[index - 1];
    if (month >= 0 && /^\d{1,2}$/u.test(day || "")) {
      const requestedYear = /^\d{4}$/u.test(words[index + 1] || "")
        ? words[index + 1]
        : year;
      return {
        date: `${requestedYear}-${String(month + 1).padStart(2, "0")}-${day.padStart(2, "0")}`,
        days: 1,
      };
    }
  }
  const relative = relativeDays.findIndex((rule) =>
    words.some((word) => rule.test(word)),
  );
  if (relative >= 0) return { date: addDays(today, relative - 1), days: 1 };
  const weekday = weekdays.findIndex((rule) =>
    words.some((word) => rule.test(word)),
  );
  if (weekday >= 0) {
    const index = words.findIndex((word) => weekdays[weekday].test(word));
    const offset = (weekday - dayOf(today) + 7) % 7;
    const next = nextWord.test(words[index - 1] || "");
    return {
      date: addDays(today, offset || (next ? 7 : 0)),
      days: 1,
      nextWeekday: next,
    };
  }
  const weekIndex = words.findIndex((word) => weekWord.test(word));
  if (weekIndex >= 0)
    return {
      date: addDays(
        monday(today),
        nextWord.test(words[weekIndex - 1] || "") ? 7 : 0,
      ),
      days: 7,
    };
  return null;
}

/** Parse public schedule requests locally. No remote inference or message storage. */
export function parseScheduleQuestion(value, now = new Date()) {
  if (typeof value !== "string" || value.length > 300 || /^\s*\//u.test(value))
    return null;
  const text = normal(value);
  const words = toWords(text);
  if (!words.length) return null;
  const today = localDate(now);
  const range = requestedDate(text, words, today);
  const has = (pattern) => words.some((word) => pattern.test(word));
  const language =
    /[әіңғүұқөһ]/u.test(text) || has(/^(?:сабақ|апта|қай|қазір)/u)
      ? "kk"
      : "ru";
  const changes = has(
    /^(?:измен|перене|перенос|замен|отмен|өзгер|ауыстыр|өтпей|болмай)/u,
  );
  const current = has(/^(?:сейчас|қазір)$/u);
  const when = has(/^(?:когда|қашан)$/u);
  const next =
    (!range || (range.days === 1 && !range.nextWeekday)) &&
    (has(nextWord) || (!range && when));
  const room = has(/^(?:где|аудитори|кабинет|қайда|қайсы|бөлме)/u);
  const type =
    Object.keys(lessonTypes).find((key) => has(lessonTypes[key])) || null;
  const schedule =
    has(/^(?:расписани|заняти|пара|пару|паре|пары|урок|кесте|сабақ)/u) ||
    words.includes("пар");
  if (!changes && !current && !next && !room && !schedule && !type && !range)
    return null;
  const kind = changes
    ? "changes"
    : current
      ? "current"
      : next
        ? "next"
        : room
          ? "room"
          : range?.days === 7
            ? "week"
            : "day";
  return {
    kind,
    language,
    date: range?.date || (changes ? monday(today) : today),
    days: range?.days || (changes ? 7 : 1),
    explicitDate: Boolean(range),
    words,
    type,
  };
}

// Handle common Russian case endings while keeping a full word match for short names.
const stem = (value) =>
  /^[а-я]{5,}$/u.test(value)
    ? value.replace(
        /(?:иями|ами|ями|иям|ием|ией|и[яеюи]|ой|ом|ам|ах|[аяуеиы])$/u,
        "",
      )
    : value;

function selectSubjects(data, group, query, phrase) {
  const catalog = data.subjects || [];
  const full = catalog.filter((item) =>
    [item.name, item.shortName].some((value) => contains(phrase, value)),
  );
  if (full.length) return full.map((item) => item.id);
  const lessons = (data.lessons || []).filter(
    (item) => item.groupId === group.id,
  );
  const ids = new Set(lessons.map((item) => item.id));
  const offered = new Set(lessons.map((item) => item.subjectId));
  for (const override of data.exceptions || data.overrides || []) {
    if (ids.has(override.lessonId) && override.subjectId)
      offered.add(override.subjectId);
  }
  const keywords = new Set(
    query.words.map(stem).filter((word) => word.length >= 4),
  );
  const matches = catalog.filter(
    (item) =>
      offered.has(item.id) &&
      toWords(item.name).some((word) => keywords.has(stem(word))),
  );
  return matches.length > 1 ? null : matches.map((item) => item.id);
}

function selectSubgroup(group, question, fromContext) {
  const words = question.words;
  const phrase = wordsWithSpaces(words);
  const subgroups = group.subgroups || [];
  if (
    !subgroups.length ||
    contains(phrase, "все подгруппы") ||
    contains(phrase, "барлық кіші топ")
  )
    return "all";
  const marker = words.findIndex(
    (word, index) =>
      word.startsWith("подгрупп") ||
      (word === "топ" && words[index - 1] === "кіші"),
  );
  if (marker >= 0)
    return subgroups.find((item) => normal(item) === words[marker + 1]) || null;
  return subgroups.includes(fromContext) ? fromContext : "all";
}

function selectLessons(data, query, now, scope, filter) {
  if (query.kind === "current") {
    return [addDays(query.date, -1), query.date]
      .flatMap((date) => lessonsForDate(data, date, scope))
      .filter(
        (item) =>
          !item.cancelled &&
          item.startAt <= now.getTime() &&
          now.getTime() < item.endAt &&
          filter(item),
      );
  }
  if (query.kind === "next") {
    // Match the site's one-academic-year search without scanning beyond a requested date.
    const horizon = query.explicitDate ? 1 : 371;
    for (let offset = 0; offset < horizon; offset++) {
      const matches = lessonsForDate(
        data,
        addDays(query.date, offset),
        scope,
      ).filter(
        (item) =>
          !item.cancelled && item.startAt > now.getTime() && filter(item),
      );
      if (matches.length)
        return matches.filter((item) => item.startAt === matches[0].startAt);
    }
    return [];
  }
  const lookup = query.kind === "changes" ? changesForDate : lessonsForDate;
  const result = Array.from({ length: query.days }, (_, offset) =>
    lookup(data, addDays(query.date, offset), scope),
  )
    .flat()
    .filter(filter);
  if (query.kind !== "changes") return result;
  const byOccurrence = new Map(
    result.map((item) => [JSON.stringify([item.id, item.sourceDate]), item]),
  );
  return [...byOccurrence.values()].sort(
    (a, b) => a.sourceDate.localeCompare(b.sourceDate) || a.startAt - b.startAt,
  );
}

function describeLessons(records, query, copies, data, subgroup) {
  const index = (kind) =>
    new Map((data[kind] || []).map((entry) => [entry.id, entry.name]));
  const subjects = index("subjects"),
    rooms = index("rooms"),
    teachers = index("teachers");
  return records.map((item) => {
    const title = label(subjects.get(item.subjectId)) || copies.lesson;
    const room = label(rooms.get(item.roomId), 40);
    const teacher = label(teachers.get(item.teacherId), 60);
    const when = (entry) =>
      `${dateText(entry.date, query.language)}, ${entry.start}–${entry.end}${entry.endDayOffset ? " (+1)" : ""}`;
    const details = [
      subgroup === "all" &&
        item.subgroup &&
        item.subgroup !== "all" &&
        `${copies.subgroupLabel} ${label(item.subgroup, 24)}`,
      teacher,
    ];
    if (query.kind === "changes" && !item.cancelled) {
      const beforeRoom = label(rooms.get(item.original.roomId), 40);
      return `${title} · ${copies.moved}\n${when(item.original)}${beforeRoom ? ` · ${beforeRoom}` : ""}\n→ ${when(item)}${room ? ` · ${room}` : ""}${details
        .filter(Boolean)
        .map((entry) => ` · ${entry}`)
        .join("")}`;
    }
    const place = room
      ? `📍 ${room}`
      : query.kind === "room"
        ? copies.noRoom
        : "";
    return [
      when(item),
      title,
      item.cancelled ? copies.cancelled : item.exception ? copies.moved : "",
      place,
      ...details,
    ]
      .filter(Boolean)
      .join(" · ");
  });
}

/** Resolve a recognized question against authoritative, already-projected schedule data. */
export function answerScheduleQuestion(
  data,
  value,
  { now = new Date(), context } = {},
) {
  const query = parseScheduleQuestion(value, now);
  if (!query) return null;
  const copy = copies[query.language];
  const clarify = (message) => ({ language: query.language, lines: [message] });
  if (!validDate(query.date)) return clarify(copy.invalidDate);
  const phrase = wordsWithSpaces(query.words);
  const active = (data.groups || []).filter(isGroupActive);
  const named = active.filter((item) =>
    [item.name, item.code, item.id].some((value) => contains(phrase, value)),
  );
  const explicitCode =
    /(?:^|[^\p{L}\p{N}])(?:групп[ауые]|топ)\s+[«"]?[\p{L}]*[- ]?\d/u.test(
      normal(value),
    );
  const group =
    named.length === 1
      ? named[0]
      : named.length || explicitCode
        ? null
        : active.find((item) => item.id === context?.groupId);
  if (!group) return clarify(copy.group);
  const subgroup = selectSubgroup(
    group,
    query,
    context?.groupId === group.id && context.subgroup,
  );
  if (!subgroup) return clarify(copy.subgroup);
  const selectedSubjects = selectSubjects(data, group, query, phrase);
  if (!selectedSubjects) return clarify(copy.subject);
  const subjects = new Set(selectedSubjects);
  const filter = (item) =>
    (!subjects.size ||
      subjects.has(item.subjectId) ||
      (query.kind === "changes" && subjects.has(item.original.subjectId))) &&
    (!query.type ||
      toWords(item.type).some((word) => lessonTypes[query.type].test(word)));
  const lessons = selectLessons(
    data,
    query,
    now,
    { groupId: group.id, subgroup },
    filter,
  );
  const heading = `${copy[query.kind]} · ${label(group.name)}`;
  const dates =
    query.days > 1
      ? `${dateText(query.date, query.language)} – ${dateText(addDays(query.date, query.days - 1), query.language)}`
      : dateText(query.date, query.language);
  return {
    language: query.language,
    groupId: group.id,
    subgroup,
    lines: [
      heading,
      ...(group.subgroups?.length
        ? [
            subgroup === "all"
              ? copy.all
              : `${copy.subgroupLabel} ${label(subgroup, 24)}`,
          ]
        : []),
      ...(!["next", "current"].includes(query.kind) ? [dates] : []),
      "",
      ...(lessons.length
        ? describeLessons(lessons, query, copy, data, subgroup)
        : [query.kind === "changes" ? copy.noChanges : copy.empty]),
    ],
  };
}
