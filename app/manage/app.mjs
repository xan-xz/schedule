import {
  teachingSettings,
  lessonTypeSuggestions,
  validateTeachingSettings,
} from "../teaching-settings.mjs";
import { busyRoomIds } from "./resources.mjs";
import { setMarkup } from "./safe-dom.mjs";
import {
  createDraftJournal,
  draftChanges,
  recoverChanges,
  catalogReplacementIntents,
} from "./drafts.mjs";
import {
  getOwnerSession,
  clearOwnerSession,
} from "../admin/session-bridge.mjs";
const ownerSession = getOwnerSession();
let ownerEnding = false;
import {
  el as dom,
  button as domButton,
  field as domField,
  select as domSelect,
  download as fileDownload,
} from "../lib/dom.mjs";
let draft = null;
let draftFormDirty = false;
const draftJournal = createDraftJournal();
let savedDrafts = [],
  localDraftLoadError = "",
  draftSaveQueue = Promise.resolve();
import {
  DAYS,
  SHORT,
  ROLES,
  clone,
  uid,
  localDate,
  addDays,
  dayOf,
  monday,
  isoWeek,
  time,
  occurrences,
  catalogImpact,
  previewLessonBatch,
  isGroupActive,
  mutate,
  validate,
  visible,
} from "../core.mjs";
import {
  findConflicts,
  conflictMessage,
  candidateConflicts,
} from "../conflicts.mjs";
const API = "https://anfwdrcazwbkkayczkxg.supabase.co",
  KEY = "sb_publishable_NkbuSbf1LxiCGvgz48fPjg_aVVwDU_G";
const $ = (id) => document.getElementById(id),
  h = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
const paths = {
  home: "M3 10 12 3l9 7M5 9v12h5v-7h4v7h5V9",
  calendar: "M4 5h16v16H4zM8 3v4m8-4v4M4 10h16",
  task: "M9 11l3 3 8-9M20 13v8H4V5h10",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4",
  request: "M6 3h9l4 4v14H6zM14 3v5h5M9 12h6m-6 4h6",
  book: "M3 4c4-1 6 0 9 2 3-2 5-3 9-2v16c-4-1-6 0-9 2-3-2-5-3-9-2zM12 6v16",
  layers: "m3 7 9-5 9 5-9 5zM3 12l9 5 9-5M3 17l9 5 9-5",
  history: "M3 6v5h5M4 10a9 9 0 1 1 0 5M12 7v5l4 2",
  users:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M17 4a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-4",
  help: "M9 9a3 3 0 0 1 6 0c0 2-3 2-3 5M12 18h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  search: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  plus: "M12 5v14M5 12h14",
  close: "m6 6 12 12M6 18 18 6",
  arrow: "m9 5 7 7-7 7",
  back: "m15 5-7 7 7 7",
  clock: "M12 6v6l4 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  pin: "M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0M15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  edit: "m4 16-1 5 5-1L21 7l-4-4zM14 6l4 4",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
  download: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5",
  sun: "M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0",
  logout: "M9 3H4v18h5m7-15 5 6-5 6m-9-6h14",
  flask: "M9 3h6M10 3v6L4 19c-1 2 1 2 2 2h12c1 0 3 0 2-2L14 9V3M7 15h10",
  check: "m5 12 4 4L20 5",
  print: "M6 9V3h12v6M6 17H3V9h18v8h-3M6 14h12v7H6z",
  share:
    "M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6M6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6M9 10l6-4M9 14l6 4",
};
function icon(n) {
  return `<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${paths[n] || paths.help}"/></svg></span>`;
}
function button(label, action, args = {}, style = "", ico = "") {
  return `<button class="btn ${style}" aria-label="${h(label)}" data-action="${action}" data-args="${h(encodeURIComponent(JSON.stringify(args)))}">${ico ? icon(ico) : ""}<span>${h(label)}</span></button>`;
}
const empty = (message, ico = "calendar") =>
  `<div class="empty">${icon(ico)}${h(message)}</div>`;
const tag = (label, color = "") =>
  `<span class="tag ${color}">${h(label)}</span>`;
const storage = {
  get(k, fallback) {
    try {
      return JSON.parse(localStorage.getItem(k)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* Browser storage or malformed optional UI arguments. */
    }
  },
};
const S = {
  page: "overview",
  date: localDate(),
  data: null,
  user: { id: "guest", role: "guest", name: "Посетитель" },
  versions: [],
  revision: 0,
  token: "",
  groupId: storage.get("uf.group", "g-main"),
  subgroup: storage.get("uf.subgroup", "А"),
  teacherId: "",
  scope: "group",
  search: "",
  weekView: false,
  taskFilter: "all",
  catalog: "groups",
  catalogQuery: "",
  catalogFilter: "active",
  online: false,
  busy: false,
  rollbackBusy: false,
  epoch: 0,
  draftConflicts: [],
};
const nav = [
  ["overview", "Обзор", "home"],
  ["schedule", "Расписание", "calendar"],
  ["tasks", "Задания", "task"],
  ["notifications", "Уведомления", "bell"],
  ["catalogs", "Справочники", "layers"],
  ["conflicts", "Конфликты", "layers"],
  ["history", "История", "history"],
  ["guide", "Инструкция", "help"],
];
const isAdmin = () => S.user.role === "admin",
  isTeacher = () => S.user.role === "teacher";
const name = (kind, id, unknown = "Не назначено") =>
  S.data?.[kind]?.find((x) => x.id === id)?.name || unknown;
const niceDate = (date, long = false) =>
  new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: long ? "long" : "short",
    ...(long ? { weekday: "long" } : {}),
  }).format(new Date(date + "T12:00:00Z"));
const myKey = (key) => "uf." + key + ".live." + S.user.id;
function viewedGroup() {
  return S.data?.groups.find((g) => g.id === S.groupId) || S.data?.groups[0];
}
function teacherSubject() {
  return (
    S.data?.teachers
      .find((t) => t.id === S.user.teacherId)
      ?.subjects.map((id) => name("subjects", id))
      .join(", ") || "Предмет не назначен"
  );
}
function scopedLessons(date = S.date) {
  return occurrences(S.data, date).filter((l) => {
    const group =
      S.scope === "teacher" || isTeacher()
        ? !S.teacherId || l.teacherId === S.teacherId
        : l.groupId === S.groupId &&
          (S.subgroup === "all" ||
            l.subgroup === "all" ||
            l.subgroup === S.subgroup);
    const query = [
      name("subjects", l.subjectId),
      name("teachers", l.teacherId, ""),
      name("rooms", l.roomId, ""),
      name("groups", l.groupId),
    ]
      .join(" ")
      .toLowerCase();
    return group && (!S.search || query.includes(S.search.toLowerCase()));
  });
}
function unread() {
  const read = new Set(storage.get(myKey("read"), []));
  return (S.data?.announcements || []).filter((n) => !read.has(n.id)).length;
}
let toastTimer;
function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 4200);
}
async function api(action, extra = {}) {
  if (!ownerSession) throw Error("Войдите в кабинет владельца.");
  if (ownerEnding) throw Error("Сессия завершена. Войдите заново.");
  if (ownerSession && ["logout", "logout.all"].includes(action)) {
    ownerEnding = true;
    let confirmed = true;
    try {
      await (action === "logout.all"
        ? ownerSession.logoutAll()
        : ownerSession.logout());
    } catch {
      confirmed = false;
    } finally {
      clearOwnerSession();
      S.token = "";
      S.data = null;
      S.versions = [];
      $("app").replaceChildren();
      const destination = new URL("../admin/", import.meta.url);
      if (!confirmed)
        destination.searchParams.set("notice", "logout-unconfirmed");
      location.replace(destination.href);
    }
    return { ok: true };
  }
  if (ownerSession) {
    try {
      S.token = await ownerSession.getAccessToken();
    } catch (error) {
      if (error.code === "INVALID_PROOF" || error.code === "ACCESS_DENIED") {
        ownerEnding = true;
        clearOwnerSession();
        S.token = "";
        S.data = null;
        S.versions = [];
        $("app").replaceChildren();
        location.replace(new URL("../admin/", import.meta.url).href);
      }
      throw error;
    }
  }
  const r = await fetch(API + "/functions/v1/uniflow-api", {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: KEY },
    body: JSON.stringify({ action, token: S.token, ...extra }),
    signal: AbortSignal.timeout(20000),
  });
  let data;
  try {
    data = await r.json();
  } catch {
    throw Error("Сервер не ответил. Попробуй ещё раз.");
  }
  if (!r.ok) {
    if (ownerSession && r.status === 401) {
      ownerEnding = true;
      clearOwnerSession();
      S.token = "";
      S.data = null;
      S.versions = [];
      $("app").replaceChildren();
      location.replace(new URL("../admin/", import.meta.url).href);
    }
    const e = Error(data.error || "Ошибка сервера");
    e.status = r.status;
    throw e;
  }
  return data;
}
function install(result) {
  S.capabilities = result.capabilities || {};
  S.data = result.data;
  S.revision = result.revision;
  S.user = result.user;
  S.versions = result.versions || [];
  S.online = true;
  if (S.user.role === "student") {
    S.groupId = S.user.groupId;
    S.subgroup = S.user.subgroup;
    S.scope = "group";
    S.teacherId = "";
  }
  if (isTeacher()) {
    S.scope = "teacher";
    S.teacherId = S.user.teacherId;
  }
  if (!S.data.groups.some((g) => g.id === S.groupId))
    S.groupId = S.data.groups[0]?.id || "";
  if (
    !S.data.groups
      .find((g) => g.id === S.groupId)
      ?.subgroups.includes(S.subgroup) &&
    S.subgroup !== "all"
  )
    S.subgroup =
      S.data.groups.find((g) => g.id === S.groupId)?.subgroups[0] || "";
}
let refreshing = false;
async function refresh(silent = false) {
  if (ownerEnding) return;
  if (draft) return;
  if (refreshing || document.hidden) return;
  refreshing = true;
  const epoch = S.epoch;
  try {
    const result = await api("state", {
      groupId: S.groupId,
      subgroup: S.subgroup,
    });
    if (epoch === S.epoch) {
      install(result);
      if (
        !$("modal").open &&
        !["INPUT", "SELECT", "TEXTAREA"].includes(
          document.activeElement?.tagName,
        )
      )
        render();
      if (
        $("modal").open &&
        $("modal").dataset.revision &&
        Number($("modal").dataset.revision) !== S.revision
      ) {
        const e = $("form-error");
        if (e)
          e.textContent =
            "Данные изменились. Закрой и открой форму заново перед сохранением.";
      }
    }
  } catch (e) {
    if (epoch === S.epoch) {
      S.online = false;
      if (e.status === 401) {
        S.token = "";
        S.user = { id: "guest", role: "guest", name: "Посетитель" };
        S.data = null;
        setTimeout(() => refresh(), 100);
      }
      if (!silent) toast(e.message);
      render();
    }
  } finally {
    refreshing = false;
  }
}
function connectRealtime() {
  if (!window.supabase) return;
  const client = window.supabase.createClient(API, KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  client
    .channel("uniflow-signal")
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "uf_signal",
        filter: "id=eq.1",
      },
      () => refresh(true),
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") refresh(true);
    });
}
async function act(op, payload, expected = S.revision) {
  if (S.busy) throw Error("Дождись сохранения");
  const catalogOperation =
    op.startsWith("catalog.") ||
    ["group.archive", "teaching.save", "lesson.batch"].includes(op);
  if (catalogOperation && !draft) startDraft();
  let replacements = draft?.catalogReplacements || [];
  if (
    ["catalog.replace", "catalog.delete"].includes(op) &&
    replacements.some(
      (item) =>
        item.entity === payload.entity && item.replacementId === payload.id,
    )
  )
    throw Error(
      "Эта запись — конечная цель замены в черновике. Цепочки замен и удаление цели не поддерживаются.",
    );
  if (
    op === "catalog.replace" &&
    draft.before[payload.entity].some((row) => row.id === payload.id)
  )
    replacements = catalogReplacementIntents([...replacements, payload]);
  if (
    draft &&
    [
      "lesson.save",
      "lesson.delete",
      "exception.save",
      "exception.delete",
      "catalog.save",
      "catalog.delete",
      "catalog.replace",
      "catalog.duplicate",
      "group.archive",
      "teaching.save",
      "lesson.batch",
      "import",
    ].includes(op)
  ) {
    const result = mutate(draft.data, S.user, op, payload);
    draft.data = result.data;
    draft.catalogReplacements = replacements;
    S.data = visible(draft.data, S.user);
    render();
    toast("Сохранено в черновике. Опубликуй, чтобы увидели студенты.");
    return;
  }
  if (S.busy) throw Error("Дождись сохранения");
  if (!S.online) throw Error("Нет связи с сервером. Изменения не отправлены.");
  S.busy = true;
  try {
    if (isAdmin()) {
      const conflicts = candidateConflicts(S.data, op, payload);
      if (conflicts.length) {
        S.draftConflicts = conflicts;
        render();
        throw Error(
          "Конфликт. Изменения не сохранены.\n" +
            conflicts
              .slice(0, 6)
              .map((c) => conflictMessage(S.data, c))
              .join("\n"),
        );
      }
    }
    install(await api("mutate", { op, payload, revision: expected }));
    render();
    S.draftConflicts = [];
    toast("Сохранено для участников");
  } catch (error) {
    if (error.status === 409) await refresh(true);
    throw error;
  } finally {
    S.busy = false;
  }
}
function allowedPage(page) {
  if (!nav.some(([name]) => name === page)) return false;
  if (page === "conflicts") return isAdmin();
  if (page === "history") return isAdmin();
  return true;
}
function shell(content) {
  const userLabel =
    S.user.role === "guest" ? "Открытое расписание" : S.user.name;
  return `<div class="layout"><aside class="sidebar"><div class="brand">UniFlow</div><div class="brand-sub">Учёба в одном ритме</div><nav class="nav" aria-label="Разделы">${nav
    .filter(([p]) => allowedPage(p))
    .map(
      ([p, t, i]) =>
        `<button data-page="${p}" class="${S.page === p ? "active" : ""}" ${S.page === p ? 'aria-current="page"' : ""}>${icon(i)}${t}${p === "notifications" && unread() ? `<span class="count">${unread()}</span>` : ""}</button>`,
    )
    .join(
      "",
    )}</nav><div class="sidebar-foot"><b>UniFlow · Управление</b><br>Автор: Азат Араппаев<br>Казахстан · UTC+5</div></aside><div class="workspace"><header class="topbar"><span class="breadcrumb">${icon("home")}Рабочее пространство</span><label class="global-search">${icon("search")}<input id="global-search" type="search" value="${h(S.search)}" placeholder="Поиск по расписанию…" aria-label="Поиск по расписанию"></label><div class="top-actions">${button(S.user.role === "guest" ? "Войти" : "Кабинет", S.user.role === "guest" ? "login" : "profile", {}, "", "users")}<button class="avatar" data-action="profile" aria-label="Открыть профиль">${h(
    S.user.name
      .split(" ")
      .map((x) => x[0])
      .slice(0, 2)
      .join(""),
  )}</button></div></header><main class="main" id="main"><div class="heading"><div><h1>${headingTitle()}</h1><p>${h(userLabel)} · ${h(ROLES[S.user.role])}</p></div><div class="heading-actions">${button("Инструкция", "page", { page: "guide" }, "ghost", "help")}${S.page === "schedule" && isAdmin() ? button("Добавить занятие", "lesson", {}, "primary", "plus") : ""}</div></div>${groupChooser()}${content}<div class="sync ${S.online ? "" : "offline"}" role="status">${S.online ? "Подключено · общие изменения обновляются автоматически" : "Нет связи · запись временно недоступна"}</div><footer class="footer"><span>UniFlow · меньше суеты, больше ясности</span><span>Время Казахстана · UTC+5</span></footer></main></div></div>`;
}
function headingTitle() {
  if (S.page === "conflicts") return "Конфликты расписания.";
  if (isTeacher() && ["overview", "schedule"].includes(S.page))
    return "Мои группы · " + teacherSubject();
  return (
    {
      overview: "Всё для учебной недели.",
      schedule: "Твоё расписание.",
      tasks: "Задания и дедлайны.",
      notifications: "Важное — в одном месте.",
      catalogs: "Учебное пространство.",
      history: "История изменений.",
      guide: "Как работает UniFlow.",
    }[S.page] || "UniFlow"
  );
}
function optionList(items, value, label = "name", blank = "") {
  const start =
    blank !== false
      ? `<option value="">${h(blank || "Не назначено")}</option>`
      : "";
  const option = (i) =>
    `<option value="${h(i.id)}" ${i.id === value ? "selected" : ""}>${h(i[label])}</option>`;
  if (label === "name" && items.some((i) => i.specialty)) {
    const buckets = new Map();
    for (const item of items) {
      const key =
        (item.specialty || "Другие группы") +
        " · " +
        (item.language === "kk"
          ? "Казахский"
          : item.language === "ru"
            ? "Русский"
            : "Язык не указан");
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(item);
    }
    return (
      start +
      [...buckets]
        .map(
          ([key, rows]) =>
            `<optgroup label="${h(key)}">${rows.map(option).join("")}</optgroup>`,
        )
        .join("")
    );
  }
  return start + items.map(option).join("");
}
function groupChooser() {
  if (!S.data || isTeacher() || !["overview", "schedule"].includes(S.page))
    return "";
  const g = viewedGroup(),
    locked = S.user.role === "student";
  const pending = !S.data.lessons.some((l) => l.groupId === g?.id);
  return `<section class="panel scope-filter"><div class="toolbar"><label class="field-inline">Моя группа<select data-filter="groupId" ${locked ? "disabled" : ""}>${optionList(S.data.groups, S.groupId, "name", false)}</select></label><label class="field-inline">Подгруппа<select data-filter="subgroup" ${locked ? "disabled" : ""}>${(g?.subgroups || []).map((v) => `<option value="${h(v)}" ${v === S.subgroup ? "selected" : ""}>${h(v)}</option>`).join("")}</select></label></div><p class="small muted">${h(g?.specialty || "Специальность не указана")} · ${g?.language === "kk" ? "Казахский язык обучения" : g?.language === "ru" ? "Русский язык обучения" : "Язык не указан"}${pending ? " · Расписание этой группы ещё не загружено. Это не означает, что занятий нет." : ""}</p></section>`;
}
function filters() {
  const group = viewedGroup(),
    locked = S.user.role === "student";
  return `<div class="toolbar">${!isTeacher() && S.user.role !== "student" ? `<label class="field-inline">Режим<select data-filter="scope"><option value="group" ${S.scope === "group" ? "selected" : ""}>По группе</option><option value="teacher" ${S.scope === "teacher" ? "selected" : ""}>По преподавателю</option></select></label>` : ""}${S.scope === "teacher" || isTeacher() ? `<label class="field-inline">Преподаватель<select data-filter="teacherId" ${isTeacher() ? "disabled" : ""}>${optionList(S.data.teachers, S.teacherId, "name", "Все преподаватели")}</select></label>` : `<label class="field-inline">Группа<select data-filter="groupId" ${locked ? "disabled" : ""}>${optionList(S.data.groups, S.groupId, "name", false)}</select></label><label class="field-inline">Подгруппа<select data-filter="subgroup" ${locked ? "disabled" : ""}>${["all", ...(group?.subgroups || [])].map((g) => `<option value="${h(g)}" ${g === S.subgroup ? "selected" : ""}>${g === "all" ? "Все подгруппы" : h(g)}</option>`).join("")}</select></label>`}<span class="spacer"></span>${button("Назад", "week", { offset: -7 }, "btn-square", "back")}<span class="small muted">${h(niceDate(monday(S.date)))} — ${h(niceDate(addDays(monday(S.date), 6)))} · ${isoWeek(S.date) % 2 ? "нечётная" : "чётная"}</span>${button("Вперёд", "week", { offset: 7 }, "btn-square", "arrow")}${button("Сегодня", "today", {}, "")}${button(S.weekView ? "День" : "Неделя", "toggleWeek", {}, "")}</div>`;
}
function dayButtons() {
  return `<div class="days" aria-label="Дни недели">${SHORT.map((d, i) => {
    const date = addDays(monday(S.date), i);
    return `<button data-action="day" data-date="${date}" class="${date === S.date ? "active" : ""} ${date === localDate() ? "today" : ""}" aria-label="${DAYS[i]}" aria-pressed="${date === S.date}">${d}</button>`;
  }).join("")}</div>`;
}
function lessonTable(list, date, editable = true) {
  if (!list.length)
    return empty(
      S.search ? "По этому запросу занятий нет" : "На этот день занятий нет.",
    );
  const teacherView = isTeacher(),
    now = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Almaty",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date());
  return (
    '<div class="table-scroll"><table class="table schedule-table"><thead><tr><th>ВРЕМЯ</th><th>' +
    (teacherView ? "ГРУППА" : "ДИСЦИПЛИНА") +
    "</th><th>" +
    (teacherView ? "ТИП ЗАНЯТИЯ" : "ПРЕПОДАВАТЕЛЬ") +
    "</th><th>АУДИТОРИЯ</th>" +
    (editable && isAdmin() ? "<th>ДЕЙСТВИЯ</th>" : "") +
    "</tr></thead><tbody>" +
    list
      .map(
        (l) =>
          '<tr class="' +
          (l.cancelled
            ? "cancelled"
            : date === localDate() && l.start <= now && l.end > now
              ? "current"
              : "") +
          '"><td class="time-cell">' +
          h(l.start) +
          "–" +
          h(l.end) +
          "<small>" +
          (time(l.end) - time(l.start)) +
          " мин</small></td><td><strong>" +
          h(
            teacherView
              ? name("groups", l.groupId)
              : name("subjects", l.subjectId),
          ) +
          '</strong><div class="subline">' +
          h(
            teacherView
              ? "Подгруппа " + (l.subgroup === "all" ? "А и Б" : l.subgroup)
              : l.type +
                  " · " +
                  name("groups", l.groupId) +
                  " · " +
                  (l.subgroup === "all" ? "А и Б" : l.subgroup),
          ) +
          (l.week !== "all"
            ? " · " + (l.week === "odd" ? "нечётная" : "чётная")
            : "") +
          "</div>" +
          (l.cancelled
            ? tag("Отменено", "red")
            : l.exception
              ? tag("Перенос на эту дату", "amber")
              : "") +
          "</td><td>" +
          h(teacherView ? l.type : name("teachers", l.teacherId)) +
          "</td><td>" +
          tag(name("rooms", l.roomId, "Не указана")) +
          "</td>" +
          (editable && isAdmin()
            ? '<td><div class="actions">' +
              button("Изменить", "lesson", { id: l.id }, "tiny", "edit") +
              button("По дате", "exception", { id: l.id, date }, "tiny") +
              "</div></td>"
            : "") +
          "</tr>",
      )
      .join("") +
    "</tbody></table></div>"
  );
}
function weekGrid() {
  return `<div class="week-grid">${SHORT.map((label, i) => {
    const date = addDays(monday(S.date), i);
    return `<div class="week-col"><h3>${label} · ${niceDate(date)}</h3>${
      scopedLessons(date)
        .map(
          (l) =>
            `<div class="week-lesson ${l.cancelled ? "cancelled" : ""}" data-action="day" data-date="${date}" tabindex="0" role="button"><span>${h(l.start)}–${h(l.end)}</span><strong>${h(isTeacher() ? name("groups", l.groupId) : name("subjects", l.subjectId))}</strong><small>${h(name("rooms", l.roomId))} · ${l.subgroup === "all" ? "А и Б" : h(l.subgroup)}</small></div>`,
        )
        .join("") || '<div class="empty">Нет занятий</div>'
    }</div>`;
  }).join("")}</div>`;
}
function schedule() {
  return (
    filters() +
    `<div class="toolbar">${button("Календарь .ics", "exportIcs", {}, "", "download")}${button("Печать", "print", {}, "", "print")}${button("Поделиться", "share", {}, "", "share")}${isAdmin() ? button("Массовая правка", "lessonBatch", {}, "") + button("Экспорт JSON", "exportJson", {}, "", "download") + button("Импорт JSON", "import", {}, "") : ""}</div>` +
    (S.weekView
      ? weekGrid()
      : `<section class="panel"><div class="panel-head"><h2>${icon("calendar")}Расписание на неделю</h2>${dayButtons()}</div><div class="day-caption"><span>${h(niceDate(S.date, true))}</span><span>${scopedLessons().length} занятий</span></div>${lessonTable(scopedLessons(), S.date)}</section>`)
  );
}
function conflictRows(rows) {
  const data = S.data;
  const link = (l, label) =>
    data.lessons.some((x) => x.id === l.id)
      ? button(label, "lesson", { id: l.id }, "tiny")
      : '<span class="small muted">Несохранённая пара</span>';
  return rows
    .map(
      (c) =>
        '<article class="notice"><h3>' +
        h(
          {
            teacher: "Конфликт преподавателя",
            room: "Конфликт аудитории",
            group: "Конфликт группы",
          }[c.kind],
        ) +
        "</h3><p>" +
        h(conflictMessage(data, c)) +
        '</p><div class="row section-space">' +
        link(c.a, "Открыть первую пару") +
        link(c.b, "Открыть вторую пару") +
        "</div></article>",
    )
    .join("");
}
function conflictSummary() {
  if (!isAdmin()) return "";
  const conflicts = findConflicts(S.data);
  return (
    '<div class="notice-info row section-space conflict-summary"><span>Проверка расписания: ' +
    (conflicts.length ? conflicts.length + " пересечений" : "конфликтов нет") +
    "</span>" +
    button("Проверить конфликты", "page", { page: "conflicts" }, "tiny") +
    "</div>"
  );
}
function sourceWarnings() {
  const d = S.data;
  const rows = d.sourceWarnings || [];
  return (
    '<section class="panel section-space"><div class="panel-head"><h2>Проверка исходного файла</h2>' +
    tag(rows.length + " замечаний", rows.length ? "amber" : "green") +
    '</div><p class="small muted source-explanation">Совпадающие лекции разных групп с одним предметом, преподавателем, кабинетом и временем показаны как общие занятия. Остальные пересечения требуют проверки. Исходные часы сохранены.</p>' +
    rows
      .map(
        (w) =>
          '<article class="notice"><h3>' +
          h(w.groupName || "Исходное расписание") +
          "</h3><p>" +
          h(w.message) +
          "</p><small>" +
          h(w.source?.sheet || "") +
          " · " +
          h(w.source?.subjectCell || w.source?.cell || "") +
          "</small></article>",
      )
      .join("") +
    "</section>"
  );
}
function conflictsPage() {
  const actual = findConflicts(S.data);
  return (
    sourceWarnings() +
    '<div class="toolbar"><span class="small muted">Проверяются кабинеты, преподаватели, группы и изменения по датам.</span><span class="spacer"></span>' +
    '</div><section class="panel"><div class="panel-head"><h2>Сохранённое расписание</h2>' +
    tag(
      actual.length ? actual.length + " конфликтов" : "Конфликтов нет",
      actual.length ? "red" : "green",
    ) +
    "</div>" +
    (actual.length
      ? conflictRows(actual)
      : empty("Кабинеты и преподаватели свободны в назначенное время.")) +
    "</section>" +
    (S.draftConflicts.length
      ? '<section class="panel section-space"><div class="panel-head"><h2>Несохранённая проверка</h2>' +
        button("Очистить", "clearConflicts", {}, "tiny") +
        '</div><div class="notice-info">Эти изменения не записаны в расписание. Исправь время, преподавателя или кабинет.</div>' +
        conflictRows(S.draftConflicts) +
        "</section>"
      : "")
  );
}
function dashboard() {
  const today = localDate();
  const now = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Almaty",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date());
  const list = scopedLessons(today).filter((l) => !l.cancelled),
    current = list.find((l) => l.start <= now && l.end > now);
  let next, nextDate;
  for (let n = 0; n < 15; n++) {
    const date = addDays(today, n);
    const lesson = scopedLessons(date).find(
      (l) => !l.cancelled && (n > 0 || l.start > now),
    );
    if (lesson) {
      next = lesson;
      nextDate = date;
      break;
    }
  }
  const tasks = S.data.tasks
    .slice()
    .sort((a, b) => a.due.localeCompare(b.due))
    .slice(0, 3);
  const notices = S.data.announcements.slice(0, 3);
  const week = Array.from({ length: 7 }, (_, i) =>
    scopedLessons(addDays(monday(S.date), i)).filter((l) => !l.cancelled),
  ).flat();
  return `${conflictSummary()}${isAdmin() ? `<div class="stats"><div class="stat"><small>ГРУППЫ</small><strong>${S.data.groups.length}</strong><span>в учебном пространстве</span></div><div class="stat"><small>ЗАНЯТИЯ НЕДЕЛИ</small><strong>${week.length}</strong><span>по выбранному фильтру</span></div><div class="stat"><small>УЧЕБНЫЕ ЧАСЫ</small><strong>${(week.reduce((n, l) => n + time(l.end) - time(l.start), 0) / 60).toFixed(1)}</strong><span>астрономические часы</span></div></div>` : ""}<div class="dashboard"><div><div class="hero-grid"><section class="panel live">${tag(current ? "Текущее занятие" : "Сейчас нет занятий")}<h2>${h(current ? (isTeacher() ? name("groups", current.groupId) : name("subjects", current.subjectId)) : "Время выдохнуть.")}</h2><div class="class-meta">${current ? `<span>${icon("clock")}${h(current.start)}–${h(current.end)}</span><span>${icon("pin")}${h(name("rooms", current.roomId))}</span>` : "Пары определяются по времени Казахстана"}</div></section><section class="panel next">${tag("Следующее занятие")}<h2>${h(next ? (isTeacher() ? name("groups", next.groupId) : name("subjects", next.subjectId)) : "Свободное время")}</h2><div class="class-meta">${next ? `${h(niceDate(nextDate))} · ${h(next.start)}–${h(next.end)}<br>${h(name("rooms", next.roomId))}` : "В ближайшие две недели занятий нет"}</div></section></div><section class="panel"><div class="panel-head"><h2>${icon("calendar")}Твоя учебная неделя</h2>${dayButtons()}</div><div class="day-caption"><span>${h(niceDate(S.date, true))}</span><span>${h(S.scope === "teacher" ? name("teachers", S.teacherId, "Все преподаватели") : name("groups", S.groupId))} · ${h(S.subgroup === "all" ? "А и Б" : S.subgroup)}</span></div>${lessonTable(scopedLessons(), S.date)}</section><div class="notice-info section-space row">${icon("users")}<span>Студенты открывают расписание своей группы, а владелец управляет назначениями и изменениями по датам.</span>${button("Открыть расписание", "page", { page: "schedule" }, "tiny")}</div>${isAdmin() ? workload() : ""}</div><aside class="stack"><section class="panel"><div class="panel-head"><h2>${icon("task")}Ближайшие задания</h2></div>${tasks.length ? `<div class="list">${tasks.map((t) => `<div class="list-item">${icon("request")}<div><h3>${h(t.title)}</h3><p>До ${niceDate(t.due)} · ${h(name("subjects", t.subjectId))}</p></div></div>`).join("")}</div>` : empty("Новых заданий пока нет", "task")}</section><section class="panel"><div class="panel-head"><h2>${icon("bell")}Изменения</h2></div>${notices.length ? `<div class="list">${notices.map((n) => `<div class="list-item">${icon("bell")}<div><h3>${h(n.title)}</h3><p>${h(n.body.slice(0, 140))}</p></div></div>`).join("")}</div>` : empty("Здесь появятся объявления и изменения", "bell")}</section><section class="panel panel-pad"><h3>Быстрые действия</h3><div class="row section-space">${button("Мои задания", "page", { page: "tasks" }, "tiny", "task")}</div></section></aside></div>`;
}
function workload() {
  return `<section class="panel section-space"><div class="panel-head"><h2>Нагрузка преподавателей</h2>${button("Свободные аудитории", "freeRooms", {}, "tiny", "search")}</div><div class="table-scroll"><table class="table"><thead><tr><th>ПРЕПОДАВАТЕЛЬ</th><th>ПАР / НЕДЕЛЮ</th><th>ЧАСЫ</th></tr></thead><tbody>${S.data.teachers
    .map((t) => {
      const ls = Array.from({ length: 7 }, (_, i) =>
        occurrences(S.data, addDays(monday(S.date), i)),
      )
        .flat()
        .filter((l) => !l.cancelled && l.teacherId === t.id);
      return `<tr><td>${h(t.name)}</td><td>${ls.length}</td><td>${(ls.reduce((n, l) => n + time(l.end) - time(l.start), 0) / 60).toFixed(1)}</td></tr>`;
    })
    .join(
      "",
    )}</tbody></table></div>${!S.data.teachers.length ? empty("Добавь преподавателей и назначь им пары") : ""}</section>`;
}
function tasks() {
  const done = new Set(storage.get(myKey("tasks"), [])),
    today = localDate();
  const list = S.data.tasks
    .filter((t) =>
      S.taskFilter === "done"
        ? done.has(t.id)
        : S.taskFilter === "overdue"
          ? t.due < today && !done.has(t.id)
          : S.taskFilter === "open"
            ? !done.has(t.id)
            : true,
    )
    .sort((a, b) => a.due.localeCompare(b.due));
  return `<div class="toolbar"><div class="tabs">${[
    ["all", "Все"],
    ["open", "К выполнению"],
    ["overdue", "Просрочено"],
    ["done", "Готово"],
  ]
    .map(
      ([v, t]) =>
        `<button data-action="taskFilter" data-value="${v}" class="${S.taskFilter === v ? "active" : ""}">${t}</button>`,
    )
    .join(
      "",
    )}</div><span class="spacer"></span>${isAdmin() ? button("Новое задание", "task", {}, "primary", "plus") : ""}</div><section class="panel">${list.length ? list.map((t) => `<article class="task ${done.has(t.id) ? "done" : ""}"><label class="check"><input type="checkbox" data-task-check="${h(t.id)}" ${done.has(t.id) ? "checked" : ""} aria-label="Отметить задание выполненным"></label><div class="grow"><h3>${h(t.title)}</h3><p>${h(t.description)}</p><div class="task-meta">${tag("До " + niceDate(t.due), t.due < today && !done.has(t.id) ? "red" : "")}${tag(name("subjects", t.subjectId))}${tag(name("groups", t.groupId) + " · " + (t.subgroup === "all" ? "А и Б" : t.subgroup))}</div></div>${isAdmin() ? `<div class="actions">${button("Изменить", "task", { id: t.id }, "tiny", "edit")}${button("Удалить", "deleteTask", { id: t.id }, "tiny danger", "trash")}</div>` : ""}</article>`).join("") : empty("Заданий по этому фильтру пока нет", "task")}</section><p class="small muted section-space">Отметки выполнения — личные, сохраняются на этом устройстве. Это не отправка работы преподавателю.</p>`;
}
function notifications() {
  const read = new Set(storage.get(myKey("read"), []));
  return `<div class="toolbar"><span class="small muted">${unread()} непрочитанных · уведомления внутри сайта</span><span class="spacer"></span>${button("Прочитать все", "readAll", {}, "", "check")}${isAdmin() ? button("Объявление", "announcement", {}, "primary", "plus") : ""}</div><section class="panel">${S.data.announcements.length ? S.data.announcements.map((n) => `<article class="notice ${read.has(n.id) ? "" : "unread"}"><div class="notice-top"><h3>${h(n.title)}</h3><small>${h(niceDate(n.createdAt.slice(0, 10)))}</small></div><p>${h(n.body)}</p>${tag(n.groupId ? name("groups", n.groupId) : n.teacherId ? name("teachers", n.teacherId) : "Получатели: " + n.roles.map((r) => ROLES[r]).join(", "))}${!read.has(n.id) ? `<div class="notice-action">${button("Прочитано", "read", { id: n.id }, "tiny")}</div>` : ""}</article>`).join("") : empty("Нет уведомлений для твоей роли", "bell")}</section>`;
}
const catalogLabels = {
  groups: "Группы",
  teachers: "Преподаватели",
  subjects: "Предметы",
  rooms: "Аудитории",
};
function catalogDetails(kind, x) {
  if (kind === "groups")
    return [
      x.code,
      x.specialty || "Специальность не указана",
      { ru: "Русский", kk: "Казахский", en: "Английский" }[x.language] ||
        "Язык не указан",
      "Подгруппы: " + x.subgroups.join(", "),
      isGroupActive(x) ? "Активна" : "В архиве / недоступна",
    ]
      .filter(Boolean)
      .join(" · ");
  if (kind === "teachers")
    return (
      x.subjects.map((id) => name("subjects", id)).join(", ") ||
      "Предметы не назначены"
    );
  if (kind === "subjects")
    return (
      [x.shortName, x.color].filter(Boolean).join(" · ") || "Учебная дисциплина"
    );
  return [
    x.capacityEstimated
      ? "Вместимость не подтверждена (оценка: " + x.capacity + ")"
      : "Мест: " + x.capacity,
    x.building && "Корпус: " + x.building,
    x.floor && "Этаж: " + x.floor,
  ]
    .filter(Boolean)
    .join(" · ");
}
function catalogs() {
  const kind = S.catalog,
    query = S.catalogQuery.trim().toLocaleLowerCase("ru"),
    rows = S.data[kind].filter(
      (x) =>
        (kind !== "groups" ||
          S.catalogFilter === "all" ||
          isGroupActive(x) === (S.catalogFilter === "active")) &&
        (!query ||
          (x.name + " " + catalogDetails(kind, x))
            .toLocaleLowerCase("ru")
            .includes(query)),
    );
  return `<div class="toolbar"><div class="tabs">${Object.entries(catalogLabels)
    .map(
      ([k, t]) =>
        `<button data-action="catalogTab" data-kind="${k}" class="${k === kind ? "active" : ""}">${t}</button>`,
    )
    .join(
      "",
    )}</div><span class="spacer"></span>${isAdmin() ? button("Звонки и типы", "teachingSettings", {}, "") : ""}${kind === "rooms" ? button("Найти свободную", "freeRooms", {}, "", "search") : ""}${isAdmin() ? button("Добавить", "catalog", { entity: kind }, "primary", "plus") : ""}</div>
  <div class="toolbar catalog-filters"><label class="form-label">Поиск в справочнике<input id="catalog-search" type="search" value="${h(S.catalogQuery)}" aria-label="Найти в справочнике" placeholder="Название, код, специальность…"></label>${
    kind === "groups"
      ? `<label class="form-label">Состояние групп<select id="catalog-visibility" aria-label="Состояние групп">${[
          ["active", "Активные"],
          ["archived", "Архивные и недоступные"],
          ["all", "Все группы"],
        ]
          .map(
            ([v, t]) =>
              `<option value="${v}" ${S.catalogFilter === v ? "selected" : ""}>${t}</option>`,
          )
          .join("")}</select></label>`
      : ""
  }<span class="small muted">Найдено: ${rows.length} из ${S.data[kind].length}</span></div>
  <p class="small muted">Правки справочников сохраняются в локальном черновике. Студенты увидят их после отдельной публикации.</p>
  <section class="panel"><div class="table-scroll"><table class="table"><thead><tr><th>НАЗВАНИЕ</th><th>ПОДРОБНОСТИ</th>${isAdmin() ? "<th>ДЕЙСТВИЯ</th>" : ""}</tr></thead><tbody>${rows.map((x) => `<tr><td><strong>${h(x.name)}</strong></td><td>${h(catalogDetails(kind, x))}</td>${isAdmin() ? `<td><div class="actions">${button("Изменить", "catalog", { entity: kind, id: x.id }, "tiny", "edit")}${button("Дублировать без расписания", "duplicateCatalog", { entity: kind, id: x.id }, "tiny")}${kind === "groups" ? button("Ссылка / QR", "groupShare", { id: x.id }, "tiny", "share") : ""}${kind === "groups" && !x.deletedAt && !x.deleted_at && x.deleted !== true && x.status !== "deleted" ? button(isGroupActive(x) ? "В архив" : "Восстановить", "archiveGroup", { id: x.id, archived: isGroupActive(x) }, "tiny") : ""}${button("Удалить", "deleteCatalog", { entity: kind, id: x.id }, "tiny danger", "trash")}</div></td>` : ""}</tr>`).join("")}</tbody></table></div>${!rows.length ? empty("По этому фильтру записей нет", "layers") : ""}</section>`;
}
function historyPage() {
  return `<div class="notice-info">Сохраняются последние 30 версий. Откат восстанавливает расписание, задания, объявления и журнал. Настройки входа владельца не откатываются.</div><section class="panel section-space"><div class="panel-head"><h2>Версии пространства</h2></div>${S.versions.length ? `<div class="list">${S.versions.map((v) => `<div class="list-item">${icon("history")}<div><h3>Версия ${v.revision} · ${h(v.reason)}</h3><p>${h(v.actor)} · ${h(new Date(v.created_at).toLocaleString("ru-RU"))}</p></div><div class="end">${button("Восстановить", "rollback", { revision: v.revision }, "tiny")}</div></div>`).join("")}</div>` : empty("После первого изменения здесь появится версия для восстановления", "history")}</section><section class="panel section-space"><div class="panel-head"><h2>Журнал действий</h2></div><div class="list">${S.data.history.map((e) => `<div class="list-item"><div><h3>${h(e.summary)}</h3><p>${h(e.actor)} · ${h(new Date(e.at).toLocaleString("ru-RU"))}</p></div></div>`).join("")}</div></section>`;
}
function guide() {
  return `<section class="panel guide"><h2>Управление учебной неделей</h2><p>UniFlow объединяет расписание, задания, объявления и изменения по датам. Время показывается по Казахстану, UTC+5.</p><h3>Публикация расписания</h3><ol><li>Выберите группу, подгруппу и нужный день.</li><li>Создайте черновик. Редактируйте регулярные пары или применяйте изменения только на выбранную дату.</li><li>Проверьте предпросмотр студента и конфликты, затем нажмите «Опубликовать».</li><li>Предыдущая версия остаётся в истории. Восстановление затрагивает весь документ расписания.</li></ol><h3>Шаблоны и справочники</h3><p>Шаблоны дня и недели сохраняются только в этом браузере. Применение добавляет занятия в черновик и проверяет пересечения. В справочниках можно изменять группы, аудитории, предметы и назначения преподавателей. Доступ к управлению есть только у подтверждённого владельца. Публичная регистрация и создание дополнительных аккаунтов через этот экран недоступны.</p><h3>Разовые изменения</h3><p>«Изменить» меняет регулярное занятие. «По дате» отменяет или переносит одну встречу. Перенос сохраняет уведомление на исходную дату и показывает занятие на новой дате.</p><h3>Сохранение и доступ</h3><p>Права проверяет сервер. Вход владельца требует пароль, подтверждение почты и TOTP. Сессия хранится только в памяти вкладки; access token действует 15 минут, refresh token — до одного часа. Перезагрузка потребует повторного входа и явного восстановления локальной копии. Применённые правки черновика сохраняются на устройстве; незавершённый ввод в открытой форме требует подтверждения. Публикация требует связи. При одновременном редактировании устаревшая версия не перезапишет новую.</p><h3>Инструменты</h3><ul><li>Поиск, просмотр дня или недели, подбор свободного кабинета.</li><li>Экспорт календаря .ics на ближайшие 28 дней по текущему фильтру, с учётом переносов и ночных пар; печать расписания.</li><li>Импорт CSV или JSON проходит через черновик и проверку перед публикацией.</li><li>Личные заметки и шаблоны остаются на устройстве; это не облачная резервная копия.</li></ul><h3>Уведомления</h3><p>Изменения и объявления доступны внутри сайта. Внешние уведомления, Telegram-клиент и фоновая доставка пока не подключены.</p><a class="btn" href="https://github.com/xan-xz/schedule" target="_blank" rel="noopener">GitHub проекта</a></section>`;
}
function render() {
  if (!S.data) {
    setMarkup(
      $("app"),
      shell(
        `<section class="panel"><div class="empty">${S.online ? "Загружаем данные…" : "Подключаем учебное пространство…"}<div class="row section-space loading-actions">${button("Повторить", "refresh", {}, "")}</div></div></section>`,
      ),
    );
    return;
  }
  if (!allowedPage(S.page)) S.page = "overview";
  const pages = {
    overview: dashboard,
    schedule,
    tasks,
    notifications,
    catalogs,
    conflicts: conflictsPage,
    history: historyPage,
    guide,
  };
  const search = ["global-search", "catalog-search"].includes(
      document.activeElement?.id,
    )
      ? document.activeElement.id
      : null,
    pos = search ? document.activeElement.selectionStart : null;
  setMarkup($("app"), shell(pages[S.page]()));
  enhanceWorkspace();
  if (S.rollbackBusy)
    $("app")
      .querySelectorAll("button:not([data-page])")
      .forEach((control) => {
        control.disabled = true;
      });
  queueDraftSave();
  if (search) {
    $(search)?.focus();
    if (pos !== null) $(search)?.setSelectionRange(pos, pos);
  }
}
function closeModal() {
  draftFormDirty = false;
  $("modal").close();
  $("modal").replaceChildren();
  $("modal").dataset.revision = "";
}
function showForm(
  title,
  fields,
  onSubmit,
  submit = "Сохранить",
  subtitle = "",
) {
  draftFormDirty = false;
  const revision = S.revision;
  const field = (f) => {
    const id = "field-" + f.name;
    const accessible = `aria-label="${h(f.label)}"${f.help ? ` aria-describedby="${id}-help"` : ""}`;
    let input;
    if (f.type === "select")
      input = `<select name="${f.name}" id="${id}" ${accessible} ${f.required ? "required" : ""}>${f.options.map((o) => `<option value="${h(o.value)}" ${o.value === String(f.value ?? "") ? "selected" : ""}>${h(o.label)}</option>`).join("")}</select>`;
    else if (f.type === "checks")
      input = `<div class="checklist">${f.options.map((o) => `<label><input type="checkbox" name="${f.name}" value="${h(o.value)}" ${(f.value || []).includes(o.value) ? "checked" : ""}>${h(o.label)}</label>`).join("")}</div>`;
    else if (f.type === "textarea")
      input = `<textarea name="${f.name}" id="${id}" ${accessible} maxlength="${f.max || 4000}" ${f.required ? "required" : ""}>${h(f.value || "")}</textarea>`;
    else
      input = `<input name="${f.name}" id="${id}" ${accessible} type="${f.type || "text"}" value="${h(f.value ?? "")}" ${f.required ? "required" : ""} ${f.min !== undefined ? 'min="' + f.min + '"' : ""} ${f.max !== undefined && f.type === "number" ? 'max="' + f.max + '"' : ""} maxlength="${f.type === "password" ? 200 : f.maxLength || 160}" ${f.type === "password" ? 'autocomplete="new-password"' : ""}>`;
    return `<label class="form-label ${f.full ? "full" : ""}" for="${id}">${h(f.label)}${input}${f.help ? `<small id="${id}-help">${h(f.help)}</small>` : ""}</label>`;
  };
  setMarkup(
    $("modal"),
    `<div class="dialog-head"><h2>${h(title)}</h2>${button("Закрыть", "closeModal", {}, "btn-square", "close")}</div>${subtitle ? `<p class="dialog-sub">${h(subtitle)}</p>` : ""}<form id="dialog-form"><div class="form-grid">${fields.map(field).join("")}</div><div class="form-error" id="form-error" role="alert"></div><div class="form-actions">${button("Отмена", "closeModal", {}, "")}<button class="btn primary" type="submit">${h(submit)}</button></div></form>`,
  );
  $("modal").dataset.revision = String(revision);
  $("modal").showModal();
  $("dialog-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget,
      button = form.querySelector("[type=submit]");
    button.disabled = true;
    $("form-error").textContent = "";
    try {
      const fd = new FormData(form),
        values = Object.fromEntries(
          fields.map((f) => [
            f.name,
            f.type === "checks"
              ? fd.getAll(f.name)
              : f.type === "number"
                ? Number(fd.get(f.name))
                : String(fd.get(f.name) ?? "").trim(),
          ]),
        );
      const keep = await onSubmit(values, revision);
      if (keep !== false) {
        closeModal();
        render();
      }
    } catch (error) {
      const output = form.querySelector("#form-error");
      if (form.isConnected && output) output.textContent = error.message;
      else toast(error.message);
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  };
}
const selectField = (name_, label, items, value, blank = "Не назначено") => ({
  name: name_,
  label,
  type: "select",
  value: value || "",
  options: [
    ...(blank === false ? [] : [{ value: "", label: blank }]),
    ...items.map((x) => ({ value: x.id, label: x.name })),
  ],
});
function lessonForm(id) {
  if (!isAdmin()) throw Error("Нужны права администратора");
  const old = S.data.lessons.find((l) => l.id === id);
  if (!S.data.subjects.length || !S.data.groups.length)
    throw Error("Сначала добавь предметы и группы в справочники");
  const fields = [
    selectField(
      "groupId",
      "Учебная группа",
      S.data.groups,
      old?.groupId || S.groupId,
      false,
    ),
    {
      name: "subgroup",
      label: "Подгруппа",
      type: "select",
      value: old?.subgroup || "all",
      options: [
        "all",
        ...new Set(S.data.groups.flatMap((g) => g.subgroups)),
      ].map((value) => ({
        value,
        label: value === "all" ? "Общая · все подгруппы" : value,
      })),
    },
    selectField(
      "subjectId",
      "Предмет",
      S.data.subjects,
      old?.subjectId || S.data.subjects[0].id,
      false,
    ),
    selectField("teacherId", "Преподаватель", S.data.teachers, old?.teacherId),
    selectField("roomId", "Аудитория", S.data.rooms, old?.roomId),
    {
      name: "type",
      label: "Тип занятия",
      value:
        old?.type ??
        teachingSettings(S.data).lessonTypes.find((item) => item.enabled)
          ?.name ??
        "",
      maxLength: 40,
      required: true,
    },
    {
      name: "day",
      label: "День недели",
      type: "select",
      value: String(old?.day ?? dayOf(S.date)),
      options: DAYS.map((label, i) => ({ value: String(i), label })),
    },
    {
      name: "week",
      label: "Повторение",
      type: "select",
      value: old?.week || "all",
      options: [
        { value: "all", label: "Каждую неделю" },
        { value: "odd", label: "Нечётные недели" },
        { value: "even", label: "Чётные недели" },
      ],
    },
    {
      name: "start",
      label: "Начало",
      type: "time",
      value: old?.start || "09:00",
      required: true,
    },
    {
      name: "end",
      label: "Конец",
      type: "time",
      value: old?.end || "09:50",
      required: true,
    },
    {
      name: "endDayOffset",
      label: "Окончание",
      type: "select",
      value: String(old?.endDayOffset || 0),
      options: [
        { value: "0", label: "В тот же день" },
        { value: "1", label: "На следующие сутки" },
      ],
    },
  ];
  showForm(
    old ? "Изменить занятие" : "Новое занятие",
    fields,
    async (v, rev) => {
      v.day = Number(v.day);
      v.endDayOffset = Number(v.endDayOffset);
      if (old && $("field-type").value === old.type) v.type = old.type;
      await act(
        "lesson.save",
        { ...old, ...v, ...(old ? { id: old.id } : {}) },
        rev,
      );
    },
    "Сохранить для участников",
    "Будут проверены занятость группы, преподавателя, аудитории и назначенные предметы.",
  );
  enhanceLessonForm(old?.type ?? "");
  if (old) {
    const action = document.createElement("div");
    action.className = "section-space";
    setMarkup(
      action,
      button(
        "Удалить это занятие",
        "deleteLesson",
        { id: old.id },
        "danger tiny",
        "trash",
      ),
    );
    $("dialog-form").append(action);
  }
}
function exceptionForm(id, date) {
  const l = S.data.lessons.find((l) => l.id === id);
  if (!l) throw Error("Пара не найдена");
  if (!isAdmin() && !(isTeacher() && l.teacherId === S.user.teacherId))
    throw Error("Можно менять только свою пару");
  const ex = S.data.exceptions.find(
    (e) => e.lessonId === id && e.date === date,
  );
  const fields = [
    {
      name: "date",
      label: "Исходная дата занятия",
      type: "date",
      value: date,
      required: true,
    },
    {
      name: "status",
      label: "Действие",
      type: "select",
      value: ex?.status || "moved",
      options: [
        { value: "moved", label: "Замена / перенос" },
        { value: "cancelled", label: "Отменить занятие" },
      ],
    },
    {
      name: "targetDate",
      label: "Новая дата",
      type: "date",
      value: ex?.targetDate || date,
      required: true,
    },
    {
      name: "start",
      label: "Новое начало",
      type: "time",
      value: ex?.start || l.start,
    },
    {
      name: "end",
      label: "Новый конец",
      type: "time",
      value: ex?.end || l.end,
    },
    {
      name: "endDayOffset",
      label: "Окончание",
      type: "select",
      value: String(ex?.endDayOffset ?? l.endDayOffset ?? 0),
      options: [
        { value: "0", label: "В тот же день" },
        { value: "1", label: "На следующие сутки" },
      ],
    },
    selectField("roomId", "Аудитория", S.data.rooms, ex?.roomId ?? l.roomId),
    ...(isAdmin()
      ? [
          selectField(
            "subjectId",
            "Предмет",
            S.data.subjects,
            ex?.subjectId || l.subjectId,
            false,
          ),
          selectField(
            "teacherId",
            "Преподаватель",
            S.data.teachers,
            ex?.teacherId ?? l.teacherId,
          ),
        ]
      : []),
    {
      name: "note",
      label: "Причина / комментарий",
      value: ex?.note || "",
      full: true,
    },
  ];
  showForm(
    "Изменение на одну дату",
    fields,
    async (v, rev) =>
      act(
        "exception.save",
        { ...v, endDayOffset: Number(v.endDayOffset), lessonId: id },
        rev,
      ),
    "Применить на дату",
    "Проверь исходную и новую даты. Регулярное расписание остальных недель не изменится.",
  );
  if (ex) {
    const actions = document.createElement("div");
    actions.className = "section-space";
    setMarkup(
      actions,
      button(
        "Убрать изменение на эту дату",
        "removeException",
        { id, date },
        "tiny danger",
      ),
    );
    $("dialog-form").append(actions);
  }
}

function taskForm(id) {
  const old = S.data.tasks.find((t) => t.id === id);
  const groups = isTeacher()
    ? S.data.groups.filter((g) =>
        S.data.lessons.some(
          (l) => l.teacherId === S.user.teacherId && l.groupId === g.id,
        ),
      )
    : S.data.groups;
  const subjects = isTeacher()
    ? S.data.subjects.filter((s) =>
        S.data.teachers
          .find((t) => t.id === S.user.teacherId)
          ?.subjects.includes(s.id),
      )
    : S.data.subjects;
  showForm(
    old ? "Изменить задание" : "Новое задание",
    [
      {
        name: "title",
        label: "Название",
        required: true,
        value: old?.title,
        full: true,
      },
      {
        name: "description",
        label: "Что нужно сделать",
        type: "textarea",
        value: old?.description || "",
        full: true,
      },
      selectField(
        "groupId",
        "Группа",
        groups,
        old?.groupId || groups[0]?.id,
        false,
      ),
      {
        name: "subgroup",
        label: "Подгруппа",
        type: "select",
        value: old?.subgroup || "all",
        options: [
          "all",
          ...new Set(S.data.groups.flatMap((g) => g.subgroups)),
        ].map((value) => ({
          value,
          label: value === "all" ? "Все подгруппы" : value,
        })),
      },
      selectField(
        "subjectId",
        "Предмет",
        subjects,
        old?.subjectId || subjects[0]?.id,
        false,
      ),
      {
        name: "due",
        label: "Сдать до",
        type: "date",
        required: true,
        value: old?.due || addDays(localDate(), 7),
      },
      ...(isAdmin()
        ? [
            selectField(
              "teacherId",
              "Преподаватель",
              S.data.teachers,
              old?.teacherId,
            ),
          ]
        : []),
    ],
    async (v, rev) =>
      act("task.save", { ...v, ...(old ? { id: old.id } : {}) }, rev),
    "Опубликовать",
  );
}
function announcementForm() {
  const groups = isTeacher()
    ? S.data.groups.filter((g) =>
        S.data.lessons.some(
          (l) => l.teacherId === S.user.teacherId && l.groupId === g.id,
        ),
      )
    : S.data.groups;
  showForm(
    "Новое объявление",
    [
      { name: "title", label: "Заголовок", required: true, full: true },
      {
        name: "body",
        label: "Сообщение",
        type: "textarea",
        required: true,
        full: true,
      },
      selectField(
        "groupId",
        "Группа-получатель",
        groups,
        isTeacher() ? groups[0]?.id : "",
        isAdmin() ? "Без ограничения по группе" : false,
      ),
      ...(isAdmin()
        ? [
            {
              name: "roles",
              label: "Кому показать",
              type: "checks",
              full: true,
              value: ["student", "teacher"],
              options: (ownerSession
                ? ["student", "teacher"]
                : ["student", "teacher", "admin"]
              ).map((value) => ({
                value,
                label: ROLES[value],
              })),
            },
            selectField(
              "teacherId",
              "Конкретный преподаватель",
              S.data.teachers,
              "",
              "Без ограничения",
            ),
          ]
        : []),
    ],
    async (v, rev) => {
      if (isAdmin() && !v.roles.length) throw Error("Выбери хотя бы одну роль");
      await act(
        "announcement.save",
        { ...v, roles: v.roles || ["student"] },
        rev,
      );
    },
    "Опубликовать",
    "Сообщение появится внутри сайта у указанных получателей. Внешние сообщения не отправляются.",
  );
}
function catalogForm(entity, id) {
  if (!isAdmin()) throw Error("Нужны права администратора");
  const old = S.data[entity].find((x) => x.id === id);
  const fields = [
    {
      name: "name",
      label: "Название / имя",
      required: true,
      value: old?.name,
      full: true,
    },
  ];
  if (entity === "groups")
    fields.push(
      {
        name: "code",
        label: "Публичный код группы",
        value: old?.code,
        maxLength: 80,
        help: "Стабильный код для ссылок; можно оставить пустым.",
      },
      { name: "specialty", label: "Специальность", value: old?.specialty },
      {
        name: "language",
        label: "Язык обучения",
        type: "select",
        value: old?.language || "",
        options: [
          { value: "", label: "Не указан" },
          { value: "ru", label: "Русский" },
          { value: "kk", label: "Казахский" },
          { value: "en", label: "Английский" },
        ],
      },
      {
        name: "subgroups",
        label: "Подгруппы через запятую",
        value: old?.subgroups.join(", ") || "А, Б",
        required: true,
        full: true,
        help: "Удаление используемой подгруппы блокируется проверкой связей.",
      },
    );
  if (entity === "teachers")
    fields.push({
      name: "subjects",
      label: "Назначенные предметы",
      type: "checks",
      value: old?.subjects || [],
      options: S.data.subjects.map((x) => ({ value: x.id, label: x.name })),
      full: true,
    });
  if (entity === "subjects")
    fields.push(
      {
        name: "shortName",
        label: "Короткое название",
        value: old?.shortName,
        maxLength: 60,
      },
      {
        name: "color",
        label: "Цвет (#RRGGBB)",
        value: old?.color || "#7957d5",
        maxLength: 7,
        required: true,
      },
    );
  if (entity === "rooms")
    fields.push(
      {
        name: "capacity",
        label: "Количество мест / оценка",
        type: "number",
        value: old?.capacity ?? 30,
        min: 1,
        max: 500,
        required: true,
      },
      {
        name: "capacityMode",
        label: "Достоверность вместимости",
        type: "select",
        value: !old || old.capacityEstimated ? "estimated" : "known",
        options: [
          { value: "estimated", label: "Не подтверждена — только оценка" },
          { value: "known", label: "Подтверждённое количество мест" },
        ],
      },
      {
        name: "building",
        label: "Корпус",
        value: old?.building,
        maxLength: 120,
      },
      { name: "floor", label: "Этаж", value: old?.floor, maxLength: 40 },
      {
        name: "note",
        label: "Примечание владельца (не показывается студентам)",
        type: "textarea",
        max: 1000,
        value: old?.note,
        full: true,
      },
    );
  showForm(
    (old ? "Изменить: " : "Добавить: ") +
      {
        groups: "Группа",
        teachers: "Преподаватель",
        subjects: "Предмет",
        rooms: "Аудитория",
      }[entity],
    fields,
    async (v, rev) => {
      if (entity === "groups") {
        v.subgroups = v.subgroups
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
        if (!v.language && !old?.language) delete v.language;
      }
      if (entity === "rooms") {
        v.capacityEstimated = v.capacityMode === "estimated";
        delete v.capacityMode;
      }
      const item = Object.fromEntries(
        Object.entries(v).filter(
          ([key, value]) =>
            !old ||
            (JSON.stringify(old[key]) !== JSON.stringify(value) &&
              !(value === "" && old[key] === undefined)),
        ),
      );
      if (old) item.id = old.id;
      await act("catalog.save", { entity, item }, rev);
    },
    "Сохранить",
    "Изменения останутся в черновике до публикации. Идентификатор и исходные сведения сохраняются.",
  );
}
const impactLabels = {
  lessons: "Занятия",
  exceptions: "Изменения по датам",
  tasks: "Задания",
  announcements: "Объявления",
  requests: "Архив заявок",
  attendance: "Архив посещаемости",
  holidays: "Каникулы",
  teachers: "Назначения преподавателей",
};
function impactText(entity, id) {
  const impact = catalogImpact(draft?.data || S.data, entity, id);
  return {
    impact,
    text:
      "По загруженным данным расписания. Затронутые записи: " +
      impact.total +
      ". " +
      Object.entries(impact.counts)
        .filter(([, count]) => count)
        .map(([key, count]) => impactLabels[key] + ": " + count)
        .join("; ") +
      ". Сервер повторно проверит связи при публикации.",
  };
}
function catalogRemovalForm({ entity, id }) {
  const old = S.data[entity].find((row) => row.id === id),
    { impact, text } = impactText(entity, id);
  if (!old) throw Error("Запись уже недоступна.");
  if (impact.blockers?.length)
    return showForm(
      "Сохраните историческую запись",
      [],
      async () => {},
      "Понятно",
      old.name +
        ". " +
        text +
        " Есть неизменяемые исторические ссылки. Удаление и замена заблокированы; для группы можно использовать архивирование.",
    );
  const targets = S.data[entity].filter(
    (row) =>
      row.id !== id &&
      (entity !== "groups" ||
        (isGroupActive(row) &&
          JSON.stringify([...row.subgroups].sort()) ===
            JSON.stringify([...old.subgroups].sort()))),
  );
  if (!impact.total)
    return showForm(
      "Удалить запись справочника",
      [],
      async (_, rev) => act("catalog.delete", { entity, id }, rev),
      "Удалить в черновике",
      old.name + ". " + text + " Удаление произойдёт после публикации.",
    );
  if (!targets.length)
    return showForm(
      "Запись используется",
      [],
      async () => {},
      "Понятно",
      old.name +
        ". " +
        text +
        " Удаление заблокировано. Сначала создайте совместимую запись для замены. Для группы нужны те же подгруппы.",
    );
  showForm(
    "Заменить ссылки и удалить",
    [
      {
        name: "replacementId",
        label: "Конечная запись для замены",
        type: "select",
        value: "",
        required: true,
        options: [
          { value: "", label: "Выберите замену" },
          ...targets.map((row) => ({ value: row.id, label: row.name })),
        ],
        full: true,
      },
    ],
    async (v, rev) =>
      act(
        "catalog.replace",
        { entity, id, replacementId: v.replacementId },
        rev,
      ),
    "Заменить в черновике",
    old.name +
      ". " +
      text +
      " Все ссылки будут перенесены на выбранную запись, исходная запись удалена. Цепочки замен не поддерживаются. Публикация — отдельным действием.",
  );
}
function catalogDuplicateForm({ entity, id }) {
  const old = S.data[entity].find((row) => row.id === id);
  showForm(
    "Дублировать без расписания",
    [
      {
        name: "name",
        label: "Название копии",
        value: old.name + " — копия",
        required: true,
        full: true,
      },
      ...(entity === "groups"
        ? [
            {
              name: "code",
              label: "Новый публичный код (необязательно)",
              maxLength: 80,
            },
          ]
        : []),
    ],
    async (v, rev) => {
      await act("catalog.duplicate", { entity, id, ...v }, rev);
      S.catalogQuery = "";
      S.catalogFilter = "active";
      render();
    },
    "Создать копию в черновике",
    "Копируются только редактируемые сведения. Расписание, задания, архивы и исходные ссылки не копируются. Назначения преподавателя нужно задать отдельно.",
  );
}
function archiveGroupForm({ id, archived }) {
  const group = S.data.groups.find((row) => row.id === id),
    { text } = impactText("groups", id);
  showForm(
    archived ? "Перенести группу в архив" : "Восстановить группу",
    [],
    async (_, rev) => act("group.archive", { id, archived }, rev),
    archived ? "В архив в черновике" : "Восстановить в черновике",
    group.name +
      ". " +
      text +
      (archived
        ? " Данные и расписание сохранятся; после публикации группа исчезнет из активного выбора студентов и расчёта ресурсов."
        : " После публикации группа снова станет доступна студентам. Проверьте конфликты перед публикацией."),
  );
}
function loginForm() {
  location.assign(new URL("../admin/", import.meta.url).href);
}
function profile() {
  const notes = storage.get(myKey("notes"), "");
  setMarkup(
    $("modal"),
    `<div class="dialog-head"><h2>Твой кабинет</h2>${button("Закрыть", "closeModal", {}, "btn-square", "close")}</div><h3>${h(S.user.name)}</h3><p class="dialog-sub profile-subtitle">${h(ROLES[S.user.role])}</p><div class="row">${button("Светлая / тёмная тема", "theme", {}, "", "sun")}${button("Выйти из аккаунта", "logout", {}, "", "logout")}</div><label class="form-label section-space">Личные заметки<textarea id="personal-notes" class="profile-notes" maxlength="10000" placeholder="Планы, вопросы к преподавателю, ссылки…">${h(notes)}</textarea><small>Сохраняются автоматически только в этом браузере для текущего профиля.</small></label><div class="notice-info section-space">Вход владельца подтверждён почтой, паролем и 2FA. Сессия хранится только в памяти вкладки. После её закрытия потребуется войти заново.</div>`,
  );
  if (S.capabilities?.logoutAll)
    $("modal")
      .querySelector(".row")
      .append(
        dom(
          "button",
          { type: "button", class: "btn", "data-action": "logoutAll" },
          "Выйти на всех устройствах",
        ),
      );
  $("modal").showModal();
}
function freeRooms() {
  showForm(
    "Найти свободную аудиторию",
    [
      {
        name: "date",
        label: "Дата",
        type: "date",
        value: S.date,
        required: true,
      },
      {
        name: "capacity",
        label: "Минимум мест",
        type: "number",
        value: 1,
        min: 1,
        max: 500,
      },
      {
        name: "start",
        label: "Начало",
        type: "time",
        value: "12:00",
        required: true,
      },
      {
        name: "end",
        label: "Конец",
        type: "time",
        value: "13:00",
        required: true,
      },
    ],
    async (v) => {
      $("free-results")?.remove();
      if (v.start >= v.end) throw Error("Конец должен быть позже начала");
      const busy = busyRoomIds(S.data, v.date, v.start, v.end);
      const free = S.data.rooms.filter((room) => !busy.has(room.id)),
        rooms = free.filter(
          (room) => !room.capacityEstimated && room.capacity >= v.capacity,
        ),
        unknown = free.filter((room) => room.capacityEstimated);
      let output = $("free-results");
      if (!output) {
        output = document.createElement("div");
        output.id = "free-results";
        output.className = "notice-info section-space";
        $("dialog-form").append(output);
      }
      output.textContent =
        (rooms.length
          ? "Свободны, подтверждённая вместимость подходит: " +
            rooms.map((r) => r.name + " (" + r.capacity + " мест)").join(", ")
          : "Свободных аудиторий с подтверждённой вместимостью по этим условиям нет.") +
        (unknown.length
          ? " Вместимость неизвестна; подтвердите отдельно: " +
            unknown.map((room) => room.name).join(", ") +
            ". Эти свободные аудитории не подтверждены по минимуму мест."
          : "");
      return false;
    },
    "Найти",
    "Поиск учитывает регулярное расписание, тип недели, отмены и переносы.",
  );
}
function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime }),
    url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function exportJson() {
  const data = clone(S.data);
  const allowed = Object.fromEntries(
    [
      "groups",
      "teachers",
      "subjects",
      "rooms",
      "lessons",
      "exceptions",
      "source",
      "sourceWarnings",
      "sourceConflictPairs",
      "holidays",
      "validFrom",
      "validUntil",
    ].map((k) => [k, data[k]]),
  );
  if (S.data.siteSettings?.teaching !== undefined)
    allowed.siteSettings = {
      teaching: validateTeachingSettings(S.data.siteSettings.teaching),
    };
  download(
    "uniflow-schedule.json",
    JSON.stringify(
      { format: "uniflow-2", exportedAt: new Date().toISOString(), ...allowed },
      null,
      2,
    ),
    "application/json",
  );
}
function importJson() {
  if (!isAdmin()) throw Error("Нужны права администратора");
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.onchange = async () => {
    try {
      const file = input.files[0];
      if (!file) return;
      if (file.size > 1000000)
        throw Error("Размер файла не должен превышать 1 МБ");
      const data = JSON.parse(await file.text());
      if (data.format !== "uniflow-2")
        throw Error("Нужен файл экспорта UniFlow 2");
      // The shared import engine validates a cloned candidate and applies the
      // same absent/present/null semantics as the server, without publishing.
      mutate(S.data, S.user, "import", {
        data,
      });
      showForm(
        "Подтвердить импорт",
        [],
        async (_, rev) => {
          if (!draft) startDraft();
          await act("import", { data }, rev);
        },
        "Добавить в черновик",
        data.groups.length +
          " групп, " +
          data.lessons.length +
          " занятий. Текущие назначения будут заменены. Предыдущая версия останется в истории.",
      );
    } catch (e) {
      toast(e.message);
    }
  };
  input.click();
}
async function exportIcs() {
  const data = S.data,
    epoch = S.epoch;
  const selection = () =>
    JSON.stringify([S.scope, S.groupId, S.subgroup, S.teacherId, S.search]);
  const selected = selection();
  const { generateManagementIcs } = await import("./calendar-export.mjs");
  if (ownerEnding || !S.data || S.epoch !== epoch) return;
  if (S.data !== data || selection() !== selected)
    throw Error("Фильтр или данные изменились. Повторите экспорт календаря.");
  const first = localDate();
  const rows = Array.from({ length: 28 }, (_, n) =>
    scopedLessons(addDays(first, n)),
  ).flat();
  download(
    "uniflow.ics",
    generateManagementIcs(data, rows),
    "text/calendar;charset=utf-8",
  );
  toast("Экспортированы ближайшие 28 дней по текущему фильтру");
}
async function rollback(revision) {
  if (!isAdmin() || ownerEnding) return;
  if (S.busy) throw Error("Дождись сохранения");
  if (!S.capabilities?.rollbackPreview)
    throw Error(
      "Предпросмотр пока недоступен на сервере. Обновите страницу позже.",
    );
  const epoch = S.epoch;
  const [{ createRollbackPreview }, { loadLessonBatchStyles }] =
    await Promise.all([
      import("./rollback-preview-editor.mjs"),
      import("./lesson-batch-editor.mjs"),
    ]);
  await loadLessonBatchStyles();
  await draftSaveQueue;
  if (ownerEnding || !isAdmin() || S.epoch !== epoch || S.busy) return;
  const expected = S.revision;
  let body;
  const authorized = () => {
    if (ownerEnding || !isAdmin() || S.epoch !== epoch)
      throw Error("Войдите владельцем заново.");
    if (!body?.isConnected || !$("modal").open)
      throw Error("Просмотр закрыт. Восстановление не отправлено.");
    if (S.revision !== expected)
      throw Error(
        "Данные уже изменились. Обновите страницу и откройте сравнение заново.",
      );
  };
  const editor = createRollbackPreview({
    revision: expected,
    target: revision,
    onClose: closeModal,
    onLoad: async (page) => {
      authorized();
      if (S.busy) throw Error("Дождись сохранения");
      const result = await api("rollback.preview", {
        revision: expected,
        target: revision,
        page,
      });
      authorized();
      return result;
    },
    onApply: async (plan, onSent) => {
      authorized();
      if (S.busy) throw Error("Дождись сохранения");
      S.busy = true;
      S.rollbackBusy = true;
      render();
      try {
        const pending = draft;
        if (pending && !(await persistCurrentDraft(Boolean(pending.saveError))))
          throw Error("Сначала сохраните локальную копию черновика.");
        authorized();
        const submitted = pending && {
          id: pending.localId,
          generation: pending.localGeneration,
          fingerprint: JSON.stringify([
            pending.data,
            pending.catalogReplacements || [],
          ]),
        };
        onSent();
        const result = await api("rollback", {
          revision: expected,
          target: revision,
          previewFingerprint: plan.fingerprint,
        });
        const changed =
          draft !== pending ||
          (pending &&
            submitted.fingerprint !==
              JSON.stringify([
                pending.data,
                pending.catalogReplacements || [],
              ]));
        if (submitted?.generation && !changed)
          try {
            await draftJournal.archive(
              ownerSession.owner.id,
              { id: submitted.id, generation: submitted.generation },
              "rollback",
            );
          } catch (error) {
            toast(error.message);
          }
        if (!changed) draft = null;
        install(result);
        if (changed && draft) {
          draft.baseConflict = true;
          S.data = visible(draft.data, S.user);
        }
        await loadLocalDrafts();
        render();
        toast(
          changed
            ? "Версия восстановлена. Более новые правки остались в черновике и требуют сверки."
            : "Версия восстановлена",
        );
      } finally {
        S.busy = false;
        S.rollbackBusy = false;
        render();
      }
    },
  });
  body = editor.root;
  showTemplateDialog("Проверка восстановления версии " + revision, body);
  $("modal").dataset.revision = String(expected);
  await editor.load(0);
}

async function handleAction(action, args, el) {
  if (ownerEnding) return;
  if (S.rollbackBusy && !["page", "closeModal"].includes(action))
    throw Error("Дождись восстановления версии. Правки временно недоступны.");
  if (action === "page") {
    S.page = args.page;
    S.search = "";
    render();
    return;
  }
  if (action === "closeModal") {
    closeModal();
    return;
  }
  if (action === "clearConflicts") {
    S.draftConflicts = [];
    render();
    return;
  }
  if (action === "refresh") {
    await refresh();
    return;
  }
  if (action === "day") {
    S.date = el?.dataset.date || args.date;
    S.weekView = false;
    render();
    return;
  }
  if (action === "week") {
    S.date = addDays(S.date, args.offset);
    render();
    return;
  }
  if (action === "today") {
    S.date = localDate();
    render();
    return;
  }
  if (action === "toggleWeek") {
    S.weekView = !S.weekView;
    render();
    return;
  }
  if (action === "taskFilter") {
    S.taskFilter = el.dataset.value;
    render();
    return;
  }
  if (action === "lessonBatch") {
    await openLessonBatchEditor();
    return;
  }
  if (action === "teachingSettings") {
    await openTeachingEditor();
    return;
  }
  if (action === "catalogTab") {
    S.catalog = el.dataset.kind;
    S.catalogQuery = "";
    render();
    return;
  }
  if (action === "login") {
    loginForm();
    return;
  }
  if (action === "profile") {
    profile();
    return;
  }
  if (action === "theme") {
    document.body.classList.toggle("dark");
    storage.set("uf.dark", document.body.classList.contains("dark"));
    return;
  }
  if (action === "logoutAll") {
    if (!S.capabilities?.logoutAll)
      throw Error("Выход на всех устройствах недоступен.");
    await api("logout.all");
    return;
  }
  if (action === "logout") {
    await api("logout");
    return;
  }
  if (action === "lesson") {
    lessonForm(args.id);
    return;
  }
  if (action === "exception") {
    exceptionForm(args.id, args.date);
    return;
  }
  if (action === "task") {
    taskForm(args.id);
    return;
  }
  if (action === "announcement") {
    announcementForm();
    return;
  }
  if (action === "catalog") {
    catalogForm(args.entity, args.id);
    return;
  }
  if (action === "freeRooms") {
    freeRooms();
    return;
  }
  if (action === "deleteLesson") {
    showForm(
      "Удалить регулярное занятие",
      [],
      async (_, rev) => {
        await act("lesson.delete", { id: args.id }, rev);
      },
      "Удалить занятие",
      "Будут удалены связанные исключения по датам, запросы и записи посещаемости. Предыдущая версия останется в истории.",
    );
    return;
  }
  if (action === "removeException") {
    await act("exception.delete", { lessonId: args.id, date: args.date });
    closeModal();
    return;
  }
  if (action === "deleteTask") {
    showForm(
      "Удалить задание",
      [],
      async (_, rev) => act("task.delete", { id: args.id }, rev),
      "Удалить",
      "Задание исчезнет у получателей.",
    );
    return;
  }
  if (action === "deleteCatalog") {
    catalogRemovalForm(args);
    return;
  }
  if (action === "duplicateCatalog") {
    catalogDuplicateForm(args);
    return;
  }
  if (action === "archiveGroup") {
    archiveGroupForm(args);
    return;
  }
  if (action === "read" || action === "readAll") {
    const read = new Set(storage.get(myKey("read"), []));
    if (action === "read") read.add(args.id);
    else S.data.announcements.forEach((n) => read.add(n.id));
    storage.set(myKey("read"), [...read]);
    render();
    return;
  }
  if (action === "exportJson") {
    exportJson();
    return;
  }
  if (action === "import") {
    importJson();
    return;
  }
  if (action === "exportIcs") {
    await exportIcs();
    return;
  }
  if (action === "print") {
    window.print();
    return;
  }
  if (action === "share" || action === "groupShare") {
    await openGroupShare(
      args.id || S.groupId,
      action === "share" ? S.subgroup : "all",
    );
    return;
  }
  if (action === "rollback") {
    await rollback(args.revision);
    return;
  }
}
async function openGroupShare(id, subgroup) {
  if (!isAdmin() || ownerEnding) return;
  const published = () =>
    (draft?.before || S.data).groups.some((row) => row.id === id);
  const check = () => {
    const group = S.data?.groups.find((row) => row.id === id);
    if (!group || !published())
      throw Error("Сначала опубликуй новую группу, затем создай ссылку.");
    if (!isGroupActive(group))
      throw Error("Ссылка доступна после восстановления группы из архива.");
    if (subgroup !== "all" && !group.subgroups.includes(subgroup))
      throw Error("Подгруппы изменились. Выберите актуальную подгруппу.");
    return group;
  };
  check();
  const epoch = S.epoch;
  const { showGroupShare } = await import("./group-share.mjs");
  if (ownerEnding || !isAdmin() || epoch !== S.epoch) return;
  showGroupShare($("modal"), check(), subgroup, {
    published: published(),
    onClose: closeModal,
  });
}
document.addEventListener("click", (event) => {
  const nav = event.target.closest("[data-page]");
  if (nav) {
    S.page = nav.dataset.page;
    S.search = "";
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  const el = event.target.closest("[data-action]");
  if (!el) return;
  event.preventDefault();
  let args = {};
  try {
    args = JSON.parse(decodeURIComponent(el.dataset.args || "%7B%7D"));
  } catch {
    /* Browser storage or malformed optional UI arguments. */
  }
  handleAction(el.dataset.action, args, el).catch((e) => toast(e.message));
});
document.addEventListener("change", async (event) => {
  const el = event.target;
  try {
    if (el.id === "catalog-visibility") {
      S.catalogFilter = el.value;
      render();
    }
    if (el.dataset.filter) {
      S[el.dataset.filter] = el.value;
      if (el.dataset.filter === "groupId") {
        S.subgroup =
          S.data.groups.find((g) => g.id === S.groupId)?.subgroups[0] || "А";
        storage.set("uf.group", S.groupId);
      }
      if (el.dataset.filter === "subgroup")
        storage.set("uf.subgroup", S.subgroup);
      render();
    }
    if (el.dataset.taskCheck) {
      const done = new Set(storage.get(myKey("tasks"), []));
      el.checked
        ? done.add(el.dataset.taskCheck)
        : done.delete(el.dataset.taskCheck);
      storage.set(myKey("tasks"), [...done]);
      render();
    }
  } catch (e) {
    toast(e.message);
    render();
  }
});
document.addEventListener("input", (event) => {
  if (event.target.id === "catalog-search") {
    S.catalogQuery = event.target.value;
    render();
  }
  if (event.target.id === "global-search") {
    S.search = event.target.value;
    S.page = "schedule";
    S.weekView = false;
    render();
  }
  if (event.target.id === "personal-notes")
    storage.set(myKey("notes"), event.target.value);
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    $("global-search")?.focus();
  }
  if (
    ["Enter", " "].includes(event.key) &&
    event.target.matches(".week-lesson")
  ) {
    event.preventDefault();
    event.target.click();
  }
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh(true);
});
window.addEventListener("online", () => refresh(true));
setInterval(() => refresh(true), 20000);
setInterval(() => {
  if (!document.hidden && !$("modal").open && S.page === "overview" && S.data)
    render();
}, 60000);
if (storage.get("uf.dark", false)) document.body.classList.add("dark");
const query = new URLSearchParams(location.search);
if (query.get("group")) S.groupId = query.get("group");
if (query.get("subgroup")) S.subgroup = query.get("subgroup");
if (
  /^\d{4}-\d{2}-\d{2}$/.test(query.get("date") || "") &&
  !Number.isNaN(Date.parse(query.get("date")))
)
  S.date = query.get("date");
if (!ownerSession) {
  ownerEnding = true;
  location.replace(new URL("../admin/", import.meta.url).href);
} else {
  S.user = {
    id: ownerSession.owner.id,
    email: ownerSession.owner.email,
    name: "Владелец",
    role: "admin",
  };
  render();
  await refresh();
  await loadLocalDrafts();
  if (S.data) render();
  connectRealtime();
}

function enhanceWorkspace() {
  const main = $("main");
  if (!main) return;
  const returnUrl = new URL("../", import.meta.url);
  const back = dom(
    "a",
    { href: returnUrl.href, class: "student-return" },
    "← Сегодня · UniFlow",
  );
  main.prepend(back);
  if (!isAdmin()) return;
  const controls = dom("section", {
    class: "draft-controls",
    "aria-label": "Черновик расписания",
  });
  if (S.rollbackBusy)
    controls.append(
      dom(
        "p",
        { role: "status" },
        "Восстанавливаем версию. Изменения временно недоступны.",
      ),
    );
  if (draft) {
    controls.append(
      dom("strong", {}, "Черновик · не опубликован"),
      dom(
        "p",
        {},
        "Правки расписания сохраняются на этом устройстве. После перезагрузки потребуется вход и явное восстановление; публикация выполняется отдельно.",
      ),
      dom(
        "div",
        { class: "row" },
        domButton("Предпросмотр студента", previewDraft, { class: "btn" }),
        domButton("Опубликовать", publishDraft, {
          class: "btn primary",
          disabled: S.busy,
        }),
        domButton("Отменить черновик", discardDraft, { class: "btn" }),
      ),
      dom(
        "p",
        { id: "draft-save-status", role: "status", class: "small" },
        draftSaveText(),
      ),
      domButton("Повторить сохранение", () => persistCurrentDraft(true), {
        class: "btn",
        id: "draft-save-retry",
        hidden: !draft.saveError,
      }),
      ...(draft.baseConflict
        ? [
            domButton(
              "Перенести на новую версию",
              () => recoverLocalDraft(draft.localId),
              { class: "btn" },
            ),
          ]
        : []),
    );
  } else
    controls.append(
      domButton("Создать черновик", startDraft, { class: "btn" }),
    );
  if (savedDrafts.length)
    controls.append(
      dom("p", { class: "small" }, "Локальных копий: " + savedDrafts.length),
      domButton("Локальные черновики", showLocalDrafts, { class: "btn" }),
    );
  controls.append(
    domButton("Интерфейс сайта", openAppearanceEditor, { class: "btn" }),
  );
  if (S.page === "schedule") {
    controls.append(
      dom(
        "div",
        { class: "row section-space" },
        domButton("Копировать день", () => bulkForm("day"), { class: "btn" }),
        domButton("Копировать неделю", () => bulkForm("week"), {
          class: "btn",
        }),
        domButton("Шаблоны", () => templateManager(), { class: "btn" }),
        domButton("Импорт CSV", csvImport, { class: "btn" }),
        domButton("Экспорт CSV", csvExport, { class: "btn" }),
      ),
    );
  }
  if (localDraftLoadError)
    controls.append(
      dom("p", { role: "status", class: "small" }, localDraftLoadError),
      domButton(
        "Повторить чтение копий",
        async () => {
          await loadLocalDrafts();
          render();
        },
        { class: "btn" },
      ),
    );
  main.insertBefore(controls, back.nextSibling);
}
function startDraft() {
  if (!isAdmin()) throw Error("Нужны права администратора");
  if (S.busy) throw Error("Дождись сохранения");
  if (draft) return;
  draft = {
    data: clone(S.data),
    before: clone(S.data),
    revision: S.revision,
    catalogReplacements: [],
    localId: crypto.randomUUID(),
    localGeneration: 0,
    queuedFingerprint: null,
    pending: 0,
    saveError: "",
  };
  render();
}
function templateField(label, control) {
  const id = "template-field-" + uid();
  control.id = id;
  return dom(
    "div",
    { class: "form-label section-space" },
    dom("label", { for: id }, label),
    control,
  );
}
function showTemplateDialog(title, body) {
  draftFormDirty = false;
  const dialog = $("modal");
  dialog.setAttribute("aria-labelledby", "template-title");
  dialog.addEventListener(
    "close",
    () => dialog.removeAttribute("aria-labelledby"),
    { once: true },
  );
  dialog.replaceChildren(
    dom(
      "div",
      { class: "dialog-head" },
      dom("h2", { id: "template-title" }, title),
      domButton("Закрыть", closeModal, { class: "btn" }),
    ),
    body,
  );
  if (!dialog.open) dialog.showModal();
}
async function templateManager() {
  if (!isAdmin()) return;
  try {
    const tools = await import("./templates.mjs");
    const templates = tools.loadTemplates();
    const body = dom(
      "div",
      {},
      dom(
        "p",
        { class: "notice-info" },
        "Шаблоны сохраняются только в этом браузере для управления расписанием. Сохраняются регулярные пары, тип недели и сроки действия; разовые изменения не включаются. Применение добавляет занятия в черновик и проверяет пересечения; существующие пары не заменяются.",
      ),
      domButton("Сохранить новый шаблон", () => templateSaveForm(tools), {
        class: "btn primary section-space",
      }),
    );
    if (!templates.length)
      body.append(
        dom("p", { class: "empty" }, "Сохранённых шаблонов пока нет."),
      );
    for (const template of templates) {
      const item = dom(
        "article",
        { class: "notice", "aria-label": template.name },
        dom("p", {}, dom("strong", {}, template.name)),
        dom(
          "p",
          {},
          (template.kind === "day" ? "День" : "Неделя") +
            " · " +
            template.sourceGroupName +
            " · " +
            (template.sourceSubgroup === "all"
              ? "обе подгруппы"
              : template.sourceSubgroup) +
            " · занятий: " +
            template.lessons.length,
        ),
        dom(
          "div",
          { class: "row section-space" },
          domButton("Применить", () => templateApplyForm(tools, template), {
            class: "btn",
            "aria-label": "Применить шаблон " + template.name,
          }),
          domButton(
            "Переименовать",
            () => templateRenameForm(tools, template),
            {
              class: "btn",
              "aria-label": "Переименовать шаблон " + template.name,
            },
          ),
          domButton("Удалить", () => templateDeleteForm(tools, template), {
            class: "btn danger",
            "aria-label": "Удалить шаблон " + template.name,
          }),
        ),
      );
      body.append(item);
    }
    showTemplateDialog("Шаблоны расписания", body);
  } catch (error) {
    toast(error.message);
  }
}
function templateSaveForm(tools) {
  if (!isAdmin()) return;
  const title = dom("input", {
    required: true,
    maxlength: 80,
    autocomplete: "off",
  });
  const kind = domSelect(
    [
      ["day", "Выбранный день"],
      ["week", "Вся регулярная неделя"],
    ],
    "day",
    () => {},
  );
  const error = dom("p", { class: "form-error", role: "alert" });
  const form = dom(
    "form",
    {},
    dom(
      "p",
      {},
      name("groups", S.groupId) +
        " · " +
        (S.subgroup === "all" ? "обе подгруппы" : S.subgroup) +
        " · " +
        niceDate(S.date),
    ),
    templateField("Название шаблона", title),
    templateField("Сохранить", kind),
    dom(
      "div",
      { class: "row section-space" },
      dom(
        "button",
        { type: "submit", class: "btn primary" },
        "Сохранить шаблон",
      ),
      domButton("Назад к шаблонам", () => templateManager(), { class: "btn" }),
    ),
    error,
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const template = tools.createTemplate(draft?.data || S.data, {
        name: title.value,
        kind: kind.value,
        groupId: S.groupId,
        subgroup: S.subgroup,
        day: dayOf(S.date),
      });
      tools.saveTemplate(template);
      void templateManager();
      toast("Шаблон сохранён на этом устройстве. Расписание не изменилось.");
    } catch (e) {
      error.textContent = e.message;
    }
  });
  showTemplateDialog("Новый шаблон", form);
  title.focus();
}
function templateApplyForm(tools, template) {
  if (!isAdmin()) return;
  const day = domSelect(
    DAYS.map((label, i) => [String(i), label]),
    String(dayOf(S.date)),
    () => {},
  );
  const error = dom("p", { class: "form-error", role: "alert" });
  const form = dom(
    "form",
    {},
    dom(
      "p",
      {},
      "«" +
        template.name +
        "» → " +
        name("groups", S.groupId) +
        " · " +
        (S.subgroup === "all" ? "обе подгруппы" : S.subgroup),
    ),
    dom(
      "p",
      { class: "notice-info section-space" },
      "Будут добавлены новые пары. Существующие не заменятся. При любом пересечении весь шаблон будет отклонён. Публикация выполняется отдельно после предпросмотра.",
    ),
    template.kind === "day" ? templateField("День назначения", day) : null,
    dom(
      "div",
      { class: "row section-space" },
      dom(
        "button",
        { type: "submit", class: "btn primary" },
        "Добавить в черновик",
      ),
      domButton("Назад к шаблонам", () => templateManager(), { class: "btn" }),
    ),
    error,
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      // Validate against the complete current draft before creating/modifying it.
      const result = tools.applyTemplate(draft?.data || S.data, template, {
        groupId: S.groupId,
        subgroup: S.subgroup,
        toDay: Number(day.value),
      });
      if (!draft) startDraft();
      draft.data = result;
      S.data = visible(draft.data, S.user);
      closeModal();
      render();
      toast("Шаблон добавлен в черновик. Проверь и опубликуй изменения.");
    } catch (e) {
      error.textContent = e.message;
    }
  });
  showTemplateDialog("Применить шаблон", form);
}
function templateRenameForm(tools, template) {
  if (!isAdmin()) return;
  const title = dom("input", {
    required: true,
    maxlength: 80,
    value: template.name,
  });
  const error = dom("p", { class: "form-error", role: "alert" });
  const form = dom(
    "form",
    {},
    templateField("Новое название", title),
    dom(
      "div",
      { class: "row section-space" },
      dom("button", { type: "submit", class: "btn primary" }, "Переименовать"),
      domButton("Назад к шаблонам", () => templateManager(), { class: "btn" }),
    ),
    error,
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      tools.renameTemplate(template.id, title.value);
      void templateManager();
    } catch (e) {
      error.textContent = e.message;
    }
  });
  showTemplateDialog("Переименовать шаблон", form);
  title.focus();
}
function templateDeleteForm(tools, template) {
  if (!isAdmin()) return;
  const error = dom("p", { class: "form-error", role: "alert" });
  const form = dom(
    "form",
    {},
    dom(
      "p",
      {},
      "Удалить «" +
        template.name +
        "» только из хранилища шаблонов? Пары, черновик и общее расписание не изменятся.",
    ),
    dom(
      "div",
      { class: "row section-space" },
      dom("button", { type: "submit", class: "btn danger" }, "Удалить шаблон"),
      domButton("Назад к шаблонам", () => templateManager(), { class: "btn" }),
    ),
    error,
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      tools.deleteTemplate(template.id);
      void templateManager();
    } catch (e) {
      error.textContent = e.message;
    }
  });
  showTemplateDialog("Удалить шаблон", form);
}
async function discardDraft() {
  if (S.rollbackBusy) return;
  if (!draft) return;
  const pending = draft;
  if (!(await persistCurrentDraft())) return;
  if (draft !== pending) return;
  if (pending.localGeneration)
    try {
      await draftJournal.archive(
        ownerSession.owner.id,
        { id: pending.localId, generation: pending.localGeneration },
        "discarded",
      );
    } catch (error) {
      toast(error.message);
      return;
    }
  S.data = draft.before;
  draft = null;
  await loadLocalDrafts();
  render();
}
async function publishDraft() {
  if (!draft || S.busy) return;
  const pending = draft;
  await persistCurrentDraft();
  if (draft !== pending || S.busy) return;
  const submittedData = clone(pending.data),
    submittedReplacements = clone(pending.catalogReplacements || []),
    submittedGeneration = pending.localGeneration;
  S.busy = true;
  try {
    if (!S.online)
      throw Error(
        "Нет сети. Черновик не отправлен; локальная копия сохраняется отдельно.",
      );
    const result = await api("mutate", {
      op: "import",
      payload: {
        data: submittedData,
        catalogReplacements: submittedReplacements,
      },
      revision: pending.revision,
    });
    const changedDuringPublish =
      JSON.stringify(pending.data) !== JSON.stringify(submittedData);
    if (submittedGeneration && !changedDuringPublish)
      try {
        await draftJournal.archive(
          ownerSession.owner.id,
          { id: pending.localId, generation: submittedGeneration },
          "published",
        );
      } catch (error) {
        toast(error.message);
      }
    draft = changedDuringPublish ? pending : null;
    install(result);
    if (changedDuringPublish) {
      pending.baseConflict = true;
      S.data = visible(pending.data, S.user);
    }
    await loadLocalDrafts();
    render();
    toast(
      changedDuringPublish
        ? "Отправленная версия опубликована. Более новые правки остались в черновике и требуют сверки."
        : "Черновик опубликован. Предыдущая версия доступна в истории.",
    );
  } catch (error) {
    if (error.status === 409) {
      pending.baseConflict = true;
      render();
    }
    toast(
      error.status
        ? error.message
        : pending.saveError
          ? "Не удалось отправить черновик. Работа осталась в этой вкладке; локальное сохранение тоже требует повторной попытки."
          : "Не удалось отправить черновик. Локальная копия сохранена; проверьте сеть и повторите публикацию.",
    );
  } finally {
    S.busy = false;
  }
}
function draftSaveText() {
  if (!draft) return "";
  if (draft.pending) return "Сохраняем локальную копию…";
  if (draft.saveError) return draft.saveError;
  return draft.localGeneration
    ? "Черновик сохранён на этом устройстве. Не опубликован."
    : "Пока нет правок для сохранения.";
}
function updateDraftStatus() {
  const status = $("draft-save-status"),
    retry = $("draft-save-retry");
  if (status) status.textContent = draftSaveText();
  if (retry) retry.hidden = !draft?.saveError;
}
function queueDraftSave(force = false) {
  if (!draft || !isAdmin() || !draft.before || !ownerSession?.owner?.id) return;
  const pending = draft;
  let changes, fingerprint;
  try {
    changes = draftChanges(
      pending.before,
      pending.data,
      pending.catalogReplacements,
    );
    fingerprint = JSON.stringify(changes);
  } catch (error) {
    pending.saveError = error.message;
    updateDraftStatus();
    return;
  }
  if (!changes.length && !pending.localGeneration) {
    pending.queuedFingerprint = fingerprint;
    return;
  }
  if (!force && fingerprint === pending.queuedFingerprint) return;
  pending.queuedFingerprint = fingerprint;
  pending.pending++;
  updateDraftStatus();
  const owner = ownerSession.owner.id;
  draftSaveQueue = draftSaveQueue
    .catch(() => {})
    .then(async () => {
      try {
        const result = await draftJournal.save(owner, {
          id: pending.localId,
          generation: pending.localGeneration,
          baseRevision: pending.revision,
          changes,
        });
        pending.localId = result.record.id;
        pending.localGeneration = result.record.generation;
        pending.saveError = "";
        if (result.forked)
          toast(
            "Другая вкладка изменила черновик. Ваши правки сохранены отдельной копией.",
          );
      } catch (error) {
        pending.saveError = error.message;
      } finally {
        pending.pending--;
        if (draft === pending) updateDraftStatus();
      }
    });
}
async function persistCurrentDraft(force = false) {
  const pending = draft;
  queueDraftSave(force);
  await draftSaveQueue;
  if (pending?.saveError) {
    toast(pending.saveError);
    return false;
  }
  return true;
}
async function loadLocalDrafts() {
  if (!ownerSession || ownerEnding || !S.data || !S.online || !isAdmin())
    return;
  try {
    savedDrafts = await draftJournal.list(ownerSession.owner.id);
    localDraftLoadError = "";
  } catch (error) {
    localDraftLoadError =
      "Не удалось прочитать локальные копии. " + error.message;
    if (draft) {
      draft.saveError = error.message;
      updateDraftStatus();
    }
  }
}
async function showLocalDrafts() {
  await loadLocalDrafts();
  const body = dom(
    "div",
    {},
    dom(
      "p",
      { class: "notice-info" },
      "Копии доступны только после входа владельца в этом браузере. Это не облачная резервная копия. Восстановление создаёт новый черновик и ничего не публикует.",
    ),
  );
  for (const record of savedDrafts) {
    const section = dom(
      "section",
      { class: "panel section-space", "data-local-draft": record.id },
      dom("h3", {}, new Date(record.updatedAt).toLocaleString("ru-RU")),
      dom(
        "p",
        {},
        "Исходная версия " +
          record.baseRevision +
          " · правок: " +
          record.changes.length +
          " · " +
          (record.status === "active"
            ? "Не завершён"
            : "Архив: " +
              ({
                published: "опубликован",
                discarded: "отменён",
                recovered: "восстановлен",
                rollback: "перед откатом",
              }[record.reason] || "сохранён")),
      ),
      domButton(
        "Проверить восстановление",
        () => recoverLocalDraft(record.id),
        { class: "btn" },
      ),
    );
    body.append(section);
  }
  if (!savedDrafts.length)
    body.append(dom("p", {}, "Локальных копий пока нет."));
  showTemplateDialog("Локальные черновики", body);
}
function localChangeLabel(change, reference) {
  const labels = {
    groups: "Группа",
    subjects: "Предмет",
    teachers: "Преподаватель",
    rooms: "Аудитория",
    lessons: "Занятие",
    exceptions: "Изменение по дате",
    holidays: "Каникулы",
    validFrom: "Начало семестра",
    validUntil: "Окончание семестра",
    "siteSettings.appearance": "Оформление",
    "siteSettings.teaching": "Звонки и типы занятий",
    source: "Исходный файл",
    sourceWarnings: "Замечания источника",
  };
  if (!change) return "Изменённая запись";
  if (change.kind === "catalogReplacement")
    return (
      "Переназначение ссылок: " +
      (reference[change.entity].find((row) => row.id === change.id)?.name ||
        change.id) +
      " → " +
      (reference[change.entity].find((row) => row.id === change.replacementId)
        ?.name || change.replacementId)
    );
  if (change.kind === "property")
    return labels[change.path] || "Настройка расписания";
  const item = change.after || change.before;
  const lesson =
    change.kind === "exceptions"
      ? reference.lessons.find((row) => row.id === item.lessonId)
      : item;
  const subject = reference.subjects.find(
    (row) => row.id === lesson?.subjectId,
  )?.name;
  return [
    labels[change.kind] || "Запись",
    item.name ||
      item.date ||
      (lesson?.start ? lesson.start + "–" + lesson.end : ""),
    subject,
  ]
    .filter(Boolean)
    .join(" · ");
}
function localReviewValues(value, reference) {
  const labels = {
    name: "Название",
    roomId: "Аудитория",
    groupId: "Группа",
    subjectId: "Предмет",
    teacherId: "Преподаватель",
    subgroup: "Подгруппа",
    day: "День",
    start: "Начало",
    end: "Окончание",
    week: "Чётность",
    type: "Тип",
    date: "Дата",
    targetDate: "Новая дата",
    status: "Действие",
    note: "Комментарий",
    capacity: "Количество мест",
    subgroups: "Подгруппы",
    specialty: "Специальность",
    language: "Язык",
    color: "Цвет",
    source: "Источник",
    present: "Задано",
    value: "Значение",
  };
  const links = {
    roomId: "rooms",
    groupId: "groups",
    subjectId: "subjects",
    teacherId: "teachers",
  };
  if (!value || Array.isArray(value) || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "id")
      .map(([key, field]) => [
        labels[key] || key,
        links[key]
          ? reference[links[key]].find((row) => row.id === field)?.name || field
          : key === "day"
            ? DAYS[field]
            : key === "status"
              ? { cancelled: "Отмена", moved: "Перенос" }[field] || field
              : key === "value"
                ? localReviewValues(field, reference)
                : field,
      ]),
  );
}
async function recoverLocalDraft(id) {
  if (S.rollbackBusy) return;
  if (draft && draft.localId !== id) {
    toast(
      "Сначала опубликуйте или отмените текущий черновик. Его правки не заменены.",
    );
    return;
  }
  try {
    if (draft && !(await persistCurrentDraft())) return;
    const records = await draftJournal.list(ownerSession.owner.id),
      record = records.find((item) => item.id === id);
    if (!record) throw Error("Локальная копия не найдена.");
    const fresh = await api("state", {
      groupId: S.groupId,
      subgroup: S.subgroup,
    });
    if (fresh.user?.role !== "admin")
      throw Error("Для восстановления войдите владельцем.");
    const preview = recoverChanges(fresh.data, record.changes);
    const body = dom(
      "div",
      {},
      dom(
        "p",
        {},
        "Черновик версии " +
          record.baseRevision +
          ". Сейчас на сервере версия " +
          fresh.revision +
          ". Публикация произойдёт только по отдельной команде.",
      ),
    );
    body.append(dom("p", {}, "Изменений: " + record.changes.length));
    for (const change of record.changes)
      body.append(
        dom(
          "details",
          {},
          dom("summary", {}, localChangeLabel(change, fresh.data)),
          dom(
            "pre",
            { class: "draft-preview-json" },
            JSON.stringify(
              {
                Было: localReviewValues(change.before, fresh.data),
                Правки:
                  change.kind === "catalogReplacement"
                    ? localChangeLabel(change, fresh.data)
                    : localReviewValues(change.after, fresh.data),
              },
              null,
              2,
            ),
          ),
        ),
      );
    if (record.baseRevision !== fresh.revision)
      body.append(
        dom(
          "p",
          { class: "notice-info" },
          "Серверная версия изменилась. Правки будут перенесены на текущие данные; остальные серверные поля сохранятся.",
        ),
      );
    const checked = dom("input", { type: "checkbox" });
    if (preview.conflicts.length) {
      body.append(
        dom(
          "p",
          { role: "alert", class: "notice-info" },
          "Спорных записей: " +
            preview.conflicts.length +
            ". Проверьте значения перед восстановлением.",
        ),
      );
      for (const conflict of preview.conflicts)
        body.append(
          dom(
            "details",
            {},
            dom(
              "summary",
              {},
              localChangeLabel(
                record.changes.find(
                  (change) =>
                    (change.kind === "property"
                      ? change.path
                      : change.kind + " · " + change.id) === conflict.label,
                ),
                fresh.data,
              ),
            ),
            dom(
              "pre",
              { class: "draft-preview-json" },
              JSON.stringify(
                {
                  Было: localReviewValues(conflict.before, fresh.data),
                  Сейчас: localReviewValues(conflict.current, fresh.data),
                  "Локальные правки": localReviewValues(
                    conflict.after,
                    fresh.data,
                  ),
                },
                null,
                2,
              ),
            ),
          ),
        );
      body.append(
        dom(
          "label",
          { class: "draft-conflict-confirm" },
          checked,
          "Я проверил спорные правки и выбираю локальные значения",
        ),
      );
    }
    const error = dom("p", { class: "form-error", role: "alert" });
    body.append(
      domButton(
        record.baseRevision === fresh.revision && !preview.conflicts.length
          ? "Восстановить в черновик"
          : "Перенести в текущую версию",
        async () => {
          try {
            if (preview.conflicts.length && !checked.checked)
              throw Error("Сначала подтвердите проверку спорных правок.");
            const latest = (
              await draftJournal.list(ownerSession.owner.id)
            ).find((item) => item.id === id);
            if (!latest || latest.generation !== record.generation)
              throw Error(
                "Копия изменилась в другой вкладке. Откройте проверку заново.",
              );
            const restored = recoverChanges(fresh.data, record.changes, {
              force: checked.checked,
            });
            const candidate = restored.catalogReplacements.length
              ? mutate(fresh.data, S.user, "import", {
                  data: restored.data,
                  catalogReplacements: restored.catalogReplacements,
                }).data
              : restored.data;
            validate(candidate);
            install(fresh);
            draft = {
              before: clone(fresh.data),
              data: candidate,
              revision: fresh.revision,
              catalogReplacements: restored.catalogReplacements,
              localId: crypto.randomUUID(),
              localGeneration: 0,
              queuedFingerprint: null,
              pending: 0,
              saveError: "",
            };
            S.data = visible(candidate, S.user);
            const persisted = await persistCurrentDraft();
            if (persisted && record.status === "active")
              try {
                await draftJournal.archive(
                  ownerSession.owner.id,
                  record,
                  "recovered",
                );
              } catch (e) {
                toast(e.message);
              }
            closeModal();
            await loadLocalDrafts();
            render();
            if (persisted)
              toast(
                "Локальная копия восстановлена в новый черновик. Проверьте предпросмотр перед публикацией.",
              );
          } catch (e) {
            error.textContent = e.message;
          }
        },
        { class: "btn primary" },
      ),
      error,
    );
    showTemplateDialog("Проверка восстановления", body);
  } catch (error) {
    toast(error.message + " Локальная копия не удалена.");
  }
}
window.addEventListener("beforeunload", (event) => {
  if (draftFormDirty || (draft && (draft.pending || draft.saveError))) {
    event.preventDefault();
    event.returnValue = "";
  }
});
document.addEventListener("input", (event) => {
  if ($("modal")?.contains(event.target)) draftFormDirty = true;
});
$("modal").addEventListener("close", () => {
  draftFormDirty = false;
});

function previewDraft() {
  if (!draft) return;
  const dialog = $("modal");
  const lessons = occurrences(draft.data, S.date).filter(
    (l) =>
      l.groupId === S.groupId &&
      (S.subgroup === "all" ||
        l.subgroup === "all" ||
        l.subgroup === S.subgroup),
  );
  dialog.replaceChildren(
    dom(
      "div",
      { class: "dialog-head" },
      dom("h2", {}, "Предпросмотр студента"),
      domButton("Закрыть", closeModal, { class: "btn" }),
    ),
    dom("p", {}, niceDate(S.date, true) + " · " + name("groups", S.groupId)),
    ...lessons.map((l) =>
      dom(
        "article",
        { class: "notice" },
        dom("h3", {}, name("subjects", l.subjectId)),
        dom(
          "p",
          {},
          l.start +
            "–" +
            l.end +
            " · " +
            name("rooms", l.roomId, "Аудитория уточняется") +
            (l.cancelled ? " · Отменено" : ""),
        ),
      ),
    ),
  );
  dialog.showModal();
}
function bulkForm(kind) {
  const group = dom(
    "p",
    {},
    name("groups", S.groupId) +
      " · " +
      S.subgroup +
      " · копирование добавляет занятия, не заменяет существующие.",
  );
  const options =
    kind === "day"
      ? DAYS.map((day, i) => [String(i), day])
      : [
          ["odd", "Нечётная"],
          ["even", "Чётная"],
        ];
  const from = domSelect(
      options,
      kind === "day" ? String(dayOf(S.date)) : "odd",
      () => {},
    ),
    to = domSelect(
      options,
      kind === "day" ? String((dayOf(S.date) + 1) % 7) : "even",
      () => {},
    );
  const error = dom("p", { class: "form-error", role: "alert" }),
    dialog = $("modal");
  const form = dom(
    "form",
    {},
    group,
    domField("Откуда", from),
    domField("Куда", to),
    dom(
      "button",
      { type: "submit", class: "btn primary" },
      "Добавить в черновик",
    ),
    error,
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const tools = await import("./tools.mjs");
      if (!draft) startDraft();
      draft.data =
        kind === "day"
          ? tools.copyDay(draft.data, {
              groupId: S.groupId,
              subgroup: S.subgroup,
              fromDay: Number(from.value),
              toDay: Number(to.value),
            })
          : tools.copyWeek(draft.data, {
              groupId: S.groupId,
              subgroup: S.subgroup,
              fromWeek: from.value,
              toWeek: to.value,
            });
      S.data = visible(draft.data, S.user);
      dialog.close();
      render();
    } catch (e) {
      error.textContent = e.message;
    }
  });
  dialog.replaceChildren(
    dom(
      "div",
      { class: "dialog-head" },
      dom("h2", {}, kind === "day" ? "Копировать день" : "Копировать неделю"),
      domButton("Закрыть", closeModal, { class: "btn" }),
    ),
    form,
  );
  dialog.showModal();
}
async function csvExport() {
  try {
    const { exportScheduleCsv } = await import("./tools.mjs");
    fileDownload(
      "uniflow-schedule.csv",
      exportScheduleCsv(draft?.data || S.data, {
        groupId: S.groupId,
        subgroup: S.subgroup,
      }),
      "text/csv;charset=utf-8",
    );
  } catch (e) {
    toast(e.message);
  }
}
async function csvImport() {
  if (!isAdmin() || ownerEnding) return;
  const epoch = S.epoch;
  try {
    const [
      { createCsvImportEditor },
      { previewScheduleCsv },
      { loadLessonBatchStyles },
    ] = await Promise.all([
      import("./csv-import-editor.mjs"),
      import("./tools.mjs"),
      import("./lesson-batch-editor.mjs"),
    ]);
    await loadLessonBatchStyles();
    await draftSaveQueue;
    if (ownerEnding || !isAdmin() || S.epoch !== epoch || S.busy) return;
    const data = clone(draft?.data || S.data);
    const scope = { groupId: S.groupId, subgroup: S.subgroup };
    const selectedGroup = data.groups.find(
      (group) => group.id === scope.groupId,
    );
    if (!selectedGroup || !isGroupActive(selectedGroup))
      throw Error("Выберите активную группу для импорта.");
    const opened = {
      draft,
      generation: draft?.localGeneration,
      revision: S.revision,
      fingerprint: JSON.stringify([data, draft?.catalogReplacements || []]),
    };
    let body,
      checked = null,
      appliedDraft = null;
    const authorized = () => {
      if (ownerEnding || !isAdmin() || S.epoch !== epoch)
        throw Error("Войдите владельцем заново.");
      if (!body?.isConnected || !$("modal").open)
        throw Error("Форма импорта закрыта.");
      if (S.busy) throw Error("Дождись сохранения");
      if (S.groupId !== scope.groupId || S.subgroup !== scope.subgroup)
        throw Error("Группа или подгруппа изменились. Откройте импорт заново.");
    };
    const unchanged = () => {
      if (
        draft !== opened.draft ||
        draft?.localGeneration !== opened.generation ||
        S.revision !== opened.revision ||
        draft?.baseConflict ||
        JSON.stringify([
          draft?.data || S.data,
          draft?.catalogReplacements || [],
        ]) !== opened.fingerprint
      )
        throw Error(
          "Данные или версия изменились. Откройте импорт заново; этот файл не применён.",
        );
    };
    body = createCsvImportEditor({
      data,
      scope,
      onClose: closeModal,
      onDirty: () => {
        draftFormDirty = true;
      },
      onInvalidate: () => {
        checked = null;
      },
      onPreview: async (text, mode) => {
        await draftSaveQueue;
        authorized();
        unchanged();
        const result = previewScheduleCsv(text, data, { ...scope, mode });
        try {
          draftChanges(
            draft?.before || S.data,
            result.data,
            draft?.catalogReplacements || [],
          );
        } catch {
          throw Error(
            "Сведения источника или объём изменений нельзя безопасно сохранить в локальный черновик. Файл не применён.",
          );
        }
        checked = result;
        return result;
      },
      onApply: async (retry) => {
        await draftSaveQueue;
        authorized();
        if (retry) {
          if (!appliedDraft || draft !== appliedDraft)
            throw Error(
              "Черновик изменился. Сохраните его из панели черновика.",
            );
        } else {
          unchanged();
          if (!checked?.changes.length)
            throw Error("Повторите предпросмотр CSV.");
          validate(checked.data);
          if (!draft) startDraft();
          draft.data = clone(checked.data);
          S.data = visible(draft.data, S.user);
          appliedDraft = draft;
        }
        const saved = await persistCurrentDraft(retry);
        if (!ownerEnding) render();
        if (saved)
          toast(
            "Импорт сохранён в локальный черновик. Публикация выполняется отдельно.",
          );
        return { saved, error: appliedDraft.saveError };
      },
    });
    showTemplateDialog("Импорт CSV", body);
    $("modal").dataset.revision = String(opened.revision);
  } catch (problem) {
    if (!ownerEnding) toast(problem.message);
  }
}
function enhanceLessonForm(currentType = "") {
  const form = $("dialog-form");
  if (!form) return;
  const settings = teachingSettings(draft?.data || S.data),
    schemes = settings.bellSchedules.filter((scheme) => scheme.enabled);
  const slot = domSelect(
    [["", "Без подстановки — оставить время"]],
    "",
    (event) => {
      const scheme = schemes.find((item) => item.id === schemePicker.value),
        chosen = scheme?.slots.find((item) => item.id === event.target.value);
      if (!chosen) return;
      $("field-start").value = chosen.start;
      $("field-end").value = chosen.end;
      $("field-endDayOffset").value = String(chosen.endDayOffset);
      draftFormDirty = true;
    },
    { "aria-label": "Интервал звонков" },
  );
  const schemePicker = domSelect(
    [
      ["", "Время вручную"],
      ...schemes.map((scheme) => [scheme.id, scheme.name]),
    ],
    settings.defaultBellScheduleId,
    () => redrawSlots(),
    { "aria-label": "Схема звонков" },
  );
  function redrawSlots() {
    const scheme = schemes.find((item) => item.id === schemePicker.value);
    slot.replaceChildren(
      dom("option", { value: "" }, "Без подстановки — оставить время"),
      ...(scheme?.slots || []).map((item) =>
        dom(
          "option",
          { value: item.id },
          item.name +
            " · " +
            item.start +
            "–" +
            item.end +
            (item.endDayOffset ? " (+1 день)" : ""),
        ),
      ),
    );
    slot.value = "";
  }
  redrawSlots();
  for (const name of ["start", "end", "endDayOffset"])
    $("field-" + name).addEventListener("input", () => {
      slot.value = "";
    });
  const typeOptions = dom(
    "datalist",
    { id: "suggest-lesson-types" },
    lessonTypeSuggestions(draft?.data || S.data, currentType).map((value) =>
      dom("option", { value }),
    ),
  );
  $("field-type").setAttribute("list", typeOptions.id);
  form
    .querySelector(".form-grid")
    .prepend(
      domField("Схема звонков", schemePicker),
      domField("Интервал звонков · подставить явно", slot),
      typeOptions,
    );
  for (const [fieldName, label, kind] of [
    ["subjectId", "Найти предмет", "subjects"],
    ["roomId", "Найти аудиторию", "rooms"],
  ]) {
    const list = dom(
      "datalist",
      { id: "suggest-" + kind },
      S.data[kind].map((item) => dom("option", { value: item.name })),
    );
    const input = dom("input", {
      list: list.id,
      placeholder: label,
      "aria-label": label,
      onchange: (event) => {
        const item = S.data[kind].find(
          (item) => item.name === event.target.value,
        );
        if (item) $("field-" + fieldName).value = item.id;
      },
    });
    form.querySelector(".form-grid").prepend(domField(label, input), list);
  }
}

async function openAppearanceEditor() {
  if (!isAdmin()) return;
  try {
    const { createAppearanceEditor, loadAppearanceEditorStyles } =
      await import("./appearance-editor.mjs");
    await loadAppearanceEditorStyles();
    if (ownerEnding || !isAdmin()) return;
    showTemplateDialog(
      "Интерфейс сайта",
      createAppearanceEditor({
        data: draft?.data || S.data,
        groupId: S.groupId,
        subgroup: S.subgroup,
        onClose: closeModal,
        onSave: (policy) => {
          const result = mutate(
            draft?.data || S.data,
            S.user,
            "appearance.save",
            { policy },
          );
          if (!draft) startDraft();
          draft.data = result.data;
          S.data = visible(draft.data, S.user);
          closeModal();
          render();
          toast(
            "Интерфейс добавлен в черновик. Проверь и опубликуй изменения.",
          );
        },
      }),
    );
  } catch (error) {
    if (!ownerEnding) toast(error.message);
  }
}

async function openTeachingEditor() {
  if (!isAdmin() || ownerEnding) return;
  if (S.busy) throw Error("Дождись сохранения");
  const epoch = S.epoch;
  try {
    const { createTeachingEditor, loadTeachingEditorStyles } =
      await import("./teaching-editor.mjs");
    await loadTeachingEditorStyles();
    await draftSaveQueue;
    if (ownerEnding || !isAdmin() || S.epoch !== epoch || S.busy) return;
    const baseline = {
      draft,
      generation: draft?.localGeneration,
      revision: S.revision,
      fingerprint: JSON.stringify(teachingSettings(draft?.data || S.data)),
    };
    showTemplateDialog(
      "Звонки и типы",
      createTeachingEditor({
        data: draft?.data || S.data,
        onClose: closeModal,
        onDirty: () => {
          draftFormDirty = true;
        },
        onSave: async (settings) => {
          if (ownerEnding || !isAdmin() || S.epoch !== epoch)
            throw Error("Войдите владельцем заново.");
          if (S.busy) throw Error("Дождись сохранения");
          if (
            draft !== baseline.draft ||
            draft?.localGeneration !== baseline.generation ||
            S.revision !== baseline.revision ||
            JSON.stringify(teachingSettings(draft?.data || S.data)) !==
              baseline.fingerprint
          )
            throw Error(
              "Версия или настройки изменились. Откройте редактор заново; этот ввод сохранён в открытой форме, черновик не изменён.",
            );
          await act("teaching.save", { settings });
          closeModal();
        },
      }),
    );
    $("modal").dataset.revision = String(baseline.revision);
  } catch (problem) {
    if (!ownerEnding) toast(problem.message);
  }
}

async function openLessonBatchEditor() {
  if (!isAdmin() || ownerEnding) return;
  if (S.busy) throw Error("Дождись сохранения");
  const epoch = S.epoch;
  const {
    createLessonBatchEditor,
    loadLessonBatchStyles,
    selectedLessonFingerprint,
  } = await import("./lesson-batch-editor.mjs");
  await loadLessonBatchStyles();
  await draftSaveQueue;
  if (ownerEnding || !isAdmin() || S.epoch !== epoch || S.busy) return;
  let checked = null;
  const opened = {
    draft,
    generation: draft?.localGeneration,
    revision: S.revision,
    data: draft?.data || S.data,
  };
  const authorized = () => {
    if (ownerEnding || !isAdmin() || S.epoch !== epoch)
      throw Error("Войдите владельцем заново.");
    if (S.busy) throw Error("Дождись сохранения");
  };
  showTemplateDialog(
    "Массовая правка",
    createLessonBatchEditor({
      data: draft?.data || S.data,
      groupId: S.groupId,
      onClose: closeModal,
      onDirty: () => {
        draftFormDirty = true;
      },
      onInvalidate: () => {
        checked = null;
      },
      onPreview: async (payload) => {
        authorized();
        await new Promise((resolve) =>
          window.requestAnimationFrame(() => setTimeout(resolve, 0)),
        );
        await draftSaveQueue;
        authorized();
        const current = draft?.data || S.data;
        if (
          draft !== opened.draft ||
          draft?.localGeneration !== opened.generation ||
          S.revision !== opened.revision ||
          selectedLessonFingerprint(current, payload.ids) !==
            selectedLessonFingerprint(opened.data, payload.ids)
        )
          throw Error(
            "Данные изменились после открытия формы. Откройте массовую правку заново; выбор не применён.",
          );
        const result = previewLessonBatch(current, payload);
        checked = result.valid
          ? {
              payload: clone(payload),
              draft,
              generation: draft?.localGeneration,
              revision: S.revision,
              fingerprint: selectedLessonFingerprint(current, payload.ids),
            }
          : null;
        return result;
      },
      onApply: async (payload) => {
        authorized();
        await draftSaveQueue;
        authorized();
        if (
          !checked ||
          JSON.stringify(payload) !== JSON.stringify(checked.payload)
        )
          throw Error("Выбор или правка изменились. Повторите предпросмотр.");
        if (
          draft !== checked.draft ||
          draft?.localGeneration !== checked.generation ||
          S.revision !== checked.revision ||
          selectedLessonFingerprint(
            draft?.data || S.data,
            checked.payload.ids,
          ) !== checked.fingerprint
        )
          throw Error(
            "Исходные занятия или версия изменились. Откройте массовую правку заново и повторите предпросмотр; черновик не изменён.",
          );
        await act("lesson.batch", clone(checked.payload), checked.revision);
        closeModal();
      },
    }),
  );
  $("modal").dataset.revision = String(S.revision);
}
