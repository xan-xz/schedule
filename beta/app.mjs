import { el, button, field, select, download } from "./lib/dom.mjs";
import { translator, localeFor } from "./lib/i18n.mjs";
import {
  initialSettings,
  writePreference,
  publicState,
  getSnapshot,
  saveSnapshot,
  releaseSnapshot,
  demoSnapshot,
  legacyTaskStatuses,
} from "./lib/client.mjs";
import {
  localDate,
  addDays,
  monday,
  isoWeek,
  lessonsForDate,
  timeline,
  validDate,
  changesForDate,
} from "./lib/time.mjs";
import * as storage from "./lib/storage.mjs";

const $ = (id) => document.getElementById(id);
const query = new URLSearchParams(location.search);
const S = {
  settings: initialSettings(),
  page: "today",
  snapshot: null,
  personal: [],
  statuses: {},
  week: monday(localDate()),
  selected: localDate(),
  subject: "",
  demo: ["student", "teacher", "admin"].includes(query.get("demo"))
    ? query.get("demo")
    : "",
  error: false,
  busy: false,
  epoch: 0,
};
if (query.get("group")) S.settings.groupId = query.get("group");
if (["А", "Б", "all"].includes(query.get("subgroup")))
  S.settings.subgroup = query.get("subgroup");
if (validDate(query.get("date"))) {
  S.selected = query.get("date");
  S.week = monday(S.selected);
}
let t = translator(S.settings.lang),
  toastTimer,
  installPrompt,
  waitingWorker,
  previousCurrent = "",
  lastDay = localDate();
const notices = new Set();
let refreshAgain = false;
const data = () => S.snapshot?.data;
const scope = () => ({
  groupId: S.settings.groupId,
  subgroup: S.settings.subgroup,
});
const name = (kind, id, fallback = "") =>
  data()?.[kind]?.find((x) => x.id === id)?.name || fallback;
const locale = () => localeFor(S.settings.lang);
const niceDate = (date, long = false) =>
  new Intl.DateTimeFormat(locale(), {
    timeZone: "Asia/Almaty",
    day: "numeric",
    month: long ? "long" : "short",
    ...(long ? { weekday: "long" } : {}),
  }).format(new Date(date + "T12:00:00+05:00"));
const niceStamp = (date) =>
  new Intl.DateTimeFormat(locale(), {
    timeZone: "Asia/Almaty",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: S.settings.hour12,
  }).format(new Date(date));
const clock = (time) =>
  S.settings.hour12
    ? new Intl.DateTimeFormat(locale(), {
        timeZone: "Asia/Almaty",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }).format(new Date("2026-01-01T" + time + ":00+05:00"))
    : time;
const personalKey = () =>
  `personal:${S.demo ? "demo" : "live"}:${S.settings.groupId}:${S.settings.subgroup}`;
const statusKey = () =>
  `statuses:${S.demo ? "demo" : "live"}:${S.settings.groupId}:${S.settings.subgroup}`;
const taskDue = (task) =>
  new Date(task.due + "T" + (task.dueTime || "23:59") + ":00+05:00").getTime();
const taskStatus = (task) => S.statuses[task.id] || "new";

function toast(text) {
  $("toast").textContent = text;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 5000);
}
function applyTheme() {
  document.documentElement.dataset.theme = S.settings.theme;
  document.documentElement.lang = S.settings.lang;
}
function saveSettings() {
  if (!writePreference("uf.settings.v1", S.settings))
    toast(t("storageWarning"));
  writePreference("uf.group", S.settings.groupId);
  writePreference("uf.subgroup", S.settings.subgroup);
  applyTheme();
}
async function loadPersonal() {
  const epoch = S.epoch;
  const key = statusKey();
  const [tasks, statuses] = await Promise.all([
    storage.get(personalKey(), []),
    storage.get(key, null),
  ]);
  if (epoch !== S.epoch) return;
  S.personal = tasks;
  S.statuses =
    statuses ?? legacyTaskStatuses(S.settings, S.demo ? "demo" : "live");
  if (statuses === null) await storage.set(key, S.statuses);
}
function isTyping() {
  return (
    ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName) ||
    $("modal").open
  );
}
function setSnapshot(snapshot) {
  S.snapshot = snapshot;
  S.error = false;
  updateStatus();
  if (!isTyping()) render();
}
function updateStatus() {
  const snapshot = S.snapshot;
  let message =
    snapshot?.source === "demo"
      ? t("demo", { role: t(S.demo) })
      : snapshot
        ? t(snapshot.source === "live" ? "updated" : "snapshot", {
            date: niceStamp(snapshot.updatedAt),
          })
        : "";
  if (!navigator.onLine) message += " · " + t("offline");
  else if (S.error) message += " · " + t("error");
  $("sync-status").textContent = message;
  $("refresh").textContent = t("retry");
  $("refresh").disabled = S.busy;
}
async function refresh() {
  if (S.busy) {
    refreshAgain = true;
    return;
  }
  S.busy = true;
  updateStatus();
  const epoch = S.epoch,
    settings = { ...S.settings };
  try {
    const snapshot = S.demo
      ? await demoSnapshot(S.demo, settings)
      : await publicState(settings.groupId, settings.subgroup);
    if (epoch !== S.epoch) return;
    if (!S.demo) await saveSnapshot(settings, snapshot);
    if (epoch !== S.epoch) return;
    setSnapshot(snapshot);
  } catch {
    if (epoch === S.epoch) {
      S.error = true;
      updateStatus();
      if (!data()) render();
    }
  } finally {
    S.busy = false;
    updateStatus();
    if (refreshAgain) {
      refreshAgain = false;
      void refresh();
    }
  }
}
function navigate(page) {
  S.page = page;
  render();
  window.scrollTo({ top: 0, behavior: "instant" });
  $("main").focus({ preventScroll: true });
}
function header() {
  $("identity").textContent =
    name("groups", S.settings.groupId, S.settings.groupId) +
    " · " +
    (S.settings.subgroup === "all" ? t("both") : S.settings.subgroup) +
    (S.demo ? " · " + t("demo", { role: t(S.demo) }) : "");
  $("navigation").replaceChildren(
    ...["today", "week", "tasks", "more"].map((page) =>
      button(t(page), () => navigate(page), {
        "aria-current": S.page === page ? "page" : null,
      }),
    ),
  );
}
function section(title, ...children) {
  return el("section", { class: "section" }, el("h2", {}, title), ...children);
}
function empty(text) {
  return el("p", { class: "empty" }, text);
}
function lessonRow(lesson, relative = false) {
  const details = [
    name("rooms", lesson.roomId, t("noRoom")),
    lesson.type,
    name("teachers", lesson.teacherId),
  ].filter(Boolean);
  const body = el(
    "div",
    { class: "lesson-body" },
    el("h3", {}, name("subjects", lesson.subjectId)),
    el("p", {}, details.join(" · ")),
  );
  if (lesson.cancelled)
    body.append(el("p", { class: "change-note" }, t("cancelled")));
  else if (lesson.exception)
    body.append(el("p", { class: "change-note" }, changeText(lesson)));
  if (relative)
    body.append(
      el(
        "p",
        {},
        t("inMinutes", {
          n: Math.max(0, Math.ceil((lesson.startAt - Date.now()) / 60000)),
        }),
      ),
    );
  return el(
    "li",
    { class: "lesson-row" + (lesson.cancelled ? " cancelled" : "") },
    el(
      "div",
      { class: "lesson-time" },
      el(
        "time",
        { datetime: lesson.startDate + "T" + lesson.start + ":00+05:00" },
        clock(lesson.start),
      ),
      el("small", {}, clock(lesson.end) + (lesson.endDayOffset ? " +1" : "")),
    ),
    body,
  );
}
function changeText(lesson) {
  if (lesson.cancelled) return t("cancelled");
  const original = lesson.original || {},
    changes = [];
  for (const [key, kind, label] of [
    ["roomId", "rooms", "roomChange"],
    ["subjectId", "subjects", "subjectChange"],
    ["teacherId", "teachers", "teacherChange"],
  ]) {
    if (original[key] !== lesson[key])
      changes.push(
        t(label) +
          ": " +
          name(kind, original[key], "—") +
          " → " +
          name(kind, lesson[key], "—"),
      );
  }
  if (original.start !== lesson.start || original.end !== lesson.end)
    changes.push(
      t("timeChange") +
        ": " +
        clock(original.start) +
        "–" +
        clock(original.end) +
        " → " +
        clock(lesson.start) +
        "–" +
        clock(lesson.end),
    );
  if (lesson.sourceDate !== lesson.startDate)
    changes.push(
      niceDate(lesson.sourceDate) + " → " + niceDate(lesson.startDate),
    );
  return changes.join(" · ") || t("changed");
}
function allTasks() {
  return [
    ...(data()?.tasks || []).filter(
      (task) =>
        task.groupId === S.settings.groupId &&
        (S.settings.subgroup === "all" ||
          task.subgroup === "all" ||
          task.subgroup === S.settings.subgroup),
    ),
    ...S.personal.map((task) => ({ ...task, personal: true })),
  ].sort((a, b) => taskDue(a) - taskDue(b) || a.id.localeCompare(b.id));
}
function renderToday() {
  const line = timeline(data(), scope(), new Date());
  const current = line.current;
  const hero = el("section", {
    class: "hero" + (current ? "" : " free"),
    "aria-label": t("now"),
  });
  hero.append(el("p", { class: "eyebrow" }, t("now")));
  if (current) {
    hero.append(
      el("h2", {}, name("subjects", current.subjectId)),
      el("p", { class: "room-label" }, t("room")),
      el(
        "p",
        { class: "room-number" },
        name("rooms", current.roomId, t("noRoom")),
      ),
      el(
        "p",
        {},
        clock(current.start) +
          "–" +
          clock(current.end) +
          " · " +
          (current.type || ""),
      ),
      el("p", { class: "muted" }, name("teachers", current.teacherId)),
      el("progress", {
        id: "lesson-progress",
        max: 1,
        value: line.progress,
        "aria-label": t("now"),
      }),
      el(
        "small",
        { id: "remaining" },
        t("remaining", { n: line.remainingMinutes }),
      ),
    );
  } else {
    hero.append(el("h2", {}, t("free")));
    if (line.next)
      hero.append(
        el("p", {}, t("nextDay") + " · " + niceDate(line.next.startDate)),
        el("h3", {}, name("subjects", line.next.subjectId)),
        el(
          "p",
          {},
          clock(line.next.start) +
            " · " +
            name("rooms", line.next.roomId, t("noRoom")),
        ),
        el(
          "small",
          { id: "remaining" },
          t("inMinutes", { n: line.untilNextMinutes }),
        ),
      );
    else hero.append(el("p", {}, t("noLessons")));
  }
  const key = current?.id + ":" + current?.startDate;
  if (previousCurrent !== key) {
    $("announcement").textContent = current
      ? t("now") +
        ": " +
        name("subjects", current.subjectId) +
        " · " +
        name("rooms", current.roomId, t("noRoom"))
      : t("free");
    previousCurrent = key;
  }
  const fragment = [
    el("p", { class: "date-line" }, niceDate(line.date, true)),
    hero,
  ];
  const changes = changesForDate(data(), line.date, scope());
  if (changes.length)
    fragment.push(
      section(
        t("changes"),
        ...changes.map((l) =>
          el(
            "article",
            { class: "change" },
            el("h3", {}, name("subjects", l.subjectId)),
            el("p", {}, changeText(l)),
            l.exception.note
              ? el("p", { class: "muted" }, l.exception.note)
              : null,
            l.exception.updatedAt || l.exception.createdAt
              ? el(
                  "small",
                  {},
                  t("changedAt", {
                    date: niceStamp(
                      l.exception.updatedAt || l.exception.createdAt,
                    ),
                  }),
                )
              : null,
          ),
        ),
      ),
    );
  const nextList = line.today
    .filter((l) => !l.cancelled && l.startAt > Date.now())
    .slice(0, 3);
  const list = el("ul", { class: "rows" });
  let previous = current;
  for (const lesson of nextList) {
    if (previous && lesson.startAt - previous.endAt >= 15 * 60000)
      list.append(
        el(
          "li",
          { class: "gap" },
          t("gap", {
            n: Math.round((lesson.startAt - previous.endAt) / 60000),
          }),
        ),
      );
    list.append(lessonRow(lesson, true));
    previous = lesson;
  }
  if (nextList.length) fragment.push(section(t("next"), list));
  const deadlines = allTasks()
    .filter(
      (task) =>
        taskStatus(task) !== "done" &&
        taskDue(task) >= Date.now() &&
        taskDue(task) <= Date.now() + 48 * 3600000,
    )
    .slice(0, 3);
  fragment.push(
    section(
      t("deadlines"),
      deadlines.length
        ? el(
            "ul",
            { class: "rows" },
            deadlines.map((task) =>
              el(
                "li",
                { class: "change" },
                el("h3", {}, task.title),
                el(
                  "small",
                  {},
                  name("subjects", task.subjectId, t("noSubject")) +
                    " · " +
                    niceDate(task.due),
                ),
              ),
            ),
          )
        : empty(t("noDeadlines")),
    ),
  );
  const announcements = (data().announcements || [])
    .filter((n) => !n.groupId || n.groupId === S.settings.groupId)
    .slice(0, 3);
  if (announcements.length)
    fragment.push(
      section(
        t("announcements"),
        announcements.map((n) =>
          el(
            "article",
            { class: "change" },
            el("h3", {}, n.title),
            el("p", {}, n.body),
          ),
        ),
      ),
    );
  return fragment;
}
function subgroups() {
  const group = data().groups.find((g) => g.id === S.settings.groupId);
  return el(
    "div",
    { class: "segmented", "aria-label": t("subgroup") },
    [...(group?.subgroups || ["А", "Б"]), "all"].map((value) =>
      button(
        value === "all" ? t("both") : value,
        () => changeSetting("subgroup", value),
        { "aria-pressed": S.settings.subgroup === value },
      ),
    ),
  );
}
function moveWeek(n) {
  S.week = addDays(S.week, n * 7);
  S.selected = S.week;
  render();
}
function renderWeek() {
  const toolbar = el(
    "div",
    { class: "toolbar" },
    button(t("previous"), () => moveWeek(-1)),
    button(t("currentWeek"), () => {
      S.week = monday(localDate());
      S.selected = localDate();
      render();
    }),
    button(t("following"), () => moveWeek(1)),
  );
  const days = Array.from({ length: 7 }, (_, i) => addDays(S.week, i));
  const daybar = el(
    "div",
    { class: "days", "aria-label": t("week") },
    days.map((date) =>
      button(
        [
          el(
            "span",
            {},
            new Intl.DateTimeFormat(locale(), {
              timeZone: "Asia/Almaty",
              weekday: "short",
            }).format(new Date(date + "T12:00:00+05:00")),
          ),
          el("small", {}, niceDate(date)),
        ],
        () => {
          S.selected = date;
          document
            .getElementById("day-" + date)
            ?.scrollIntoView({ behavior: "instant", block: "start" });
        },
        {
          "aria-current": date === localDate() ? "date" : null,
          "aria-label": niceDate(date, true),
        },
      ),
    ),
  );
  const week = el(
    "div",
    { id: "week-list" },
    days.map((date) => {
      const lessons = lessonsForDate(data(), date, scope());
      const list = el("ul", { class: "rows" });
      let previous;
      for (const lesson of lessons) {
        if (
          previous &&
          !lesson.cancelled &&
          lesson.startAt - previous.endAt >= 15 * 60000
        )
          list.append(
            el(
              "li",
              { class: "gap" },
              t("gap", {
                n: Math.round((lesson.startAt - previous.endAt) / 60000),
              }),
            ),
          );
        list.append(lessonRow(lesson));
        if (!lesson.cancelled) previous = lesson;
      }
      return el(
        "section",
        { class: "day", id: "day-" + date },
        el("h2", {}, niceDate(date, true)),
        lessons.length ? list : empty(t("noLessons")),
      );
    }),
  );
  let touch;
  week.addEventListener(
    "touchstart",
    (event) => {
      touch = event.touches[0];
    },
    { passive: true },
  );
  week.addEventListener(
    "touchend",
    (event) => {
      if (!touch) return;
      const end = event.changedTouches[0],
        dx = end.clientX - touch.clientX,
        dy = end.clientY - touch.clientY;
      if (Math.abs(dx) > 80 && Math.abs(dx) > Math.abs(dy) * 2) {
        S.selected = addDays(S.selected, dx < 0 ? 1 : -1);
        if (monday(S.selected) !== S.week) S.week = monday(S.selected);
        render();
        document
          .getElementById("day-" + S.selected)
          ?.scrollIntoView({ behavior: "instant", block: "start" });
      }
      touch = null;
    },
    { passive: true },
  );
  return [
    toolbar,
    el(
      "p",
      { class: "muted" },
      niceDate(S.week) +
        " – " +
        niceDate(addDays(S.week, 6)) +
        " · " +
        t(isoWeek(S.week) % 2 ? "odd" : "even"),
    ),
    subgroups(),
    daybar,
    week,
  ];
}
async function changeStatus(id, status) {
  S.statuses = { ...S.statuses, [id]: status };
  if (!(await storage.set(statusKey(), S.statuses))) toast(t("storageWarning"));
  render();
}
function personalForm() {
  const dialog = $("modal");
  const title = el("input", {
    name: "title",
    required: true,
    maxlength: 160,
    autocomplete: "off",
  });
  const subject = select(
    [["", t("noSubject")], ...data().subjects.map((s) => [s.id, s.name])],
    "",
    () => {},
    { name: "subjectId" },
  );
  const due = el("input", {
    type: "date",
    name: "due",
    required: true,
    value: localDate(),
  });
  const error = el("p", { class: "form-error", role: "alert" });
  const form = el(
    "form",
    {},
    field(t("title"), title),
    field(t("subject"), subject),
    field(t("due"), due),
    el("p", { class: "notice" }, t("personalOnly")),
    el("button", { type: "submit", class: "primary wide" }, t("add")),
    error,
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!title.value.trim()) return;
    const task = {
      id: crypto.randomUUID(),
      title: title.value.trim(),
      subjectId: subject.value,
      due: due.value,
      description: "",
      groupId: S.settings.groupId,
    };
    S.personal = [...S.personal, task];
    try {
      const persisted = await storage.set(personalKey(), S.personal);
      dialog.close();
      render();
      if (!persisted) toast(t("storageWarning"));
    } catch {
      error.textContent = t("storageWarning");
    }
  });
  dialog.replaceChildren(
    el(
      "div",
      { class: "dialog-heading" },
      el("h2", { id: "modal-title" }, t("personal")),
      button(t("close"), () => dialog.close()),
    ),
    form,
  );
  dialog.showModal();
  title.focus();
}
function renderTasks() {
  const filter = field(
    t("subject"),
    select(
      [["", t("allSubjects")], ...data().subjects.map((s) => [s.id, s.name])],
      S.subject,
      (event) => {
        S.subject = event.target.value;
        render();
      },
    ),
  );
  const tasks = allTasks().filter(
    (task) => !S.subject || task.subjectId === S.subject,
  );
  const rows = tasks.map((task) => {
    const status = taskStatus(task),
      late = status !== "done" && taskDue(task) < Date.now();
    const row = el(
      "article",
      { class: "task-row" + (status === "done" ? " done" : "") },
      el(
        "div",
        {},
        el("h2", {}, task.title),
        el("p", {}, name("subjects", task.subjectId, t("noSubject"))),
        el(
          "p",
          { class: late ? "danger" : "" },
          niceDate(task.due) + (late ? " · " + t("overdue") : ""),
        ),
      ),
      select(
        ["new", "progress", "done"].map((s) => [s, t(s)]),
        status,
        (event) => changeStatus(task.id, event.target.value),
        { "aria-label": task.title + " · " + t("status") },
      ),
      task.description
        ? el("p", { class: "task-body" }, task.description)
        : null,
      el(
        "div",
        { class: "task-tools" },
        el("small", {}, t(task.personal ? "personalOnly" : "groupTask")),
        task.personal
          ? button(
              t("delete"),
              async () => {
                S.personal = S.personal.filter((item) => item.id !== task.id);
                const persisted = await storage.set(personalKey(), S.personal);
                if (!persisted) toast(t("storageWarning"));
                render();
              },
              {
                class: "quiet danger",
                "aria-label": t("delete") + " · " + task.title,
              },
            )
          : null,
      ),
    );
    let start;
    row.addEventListener(
      "touchstart",
      (e) => {
        if (["SELECT", "BUTTON"].includes(e.target.tagName)) return;
        start = e.touches[0];
      },
      { passive: true },
    );
    row.addEventListener(
      "touchend",
      (e) => {
        if (!start) return;
        const end = e.changedTouches[0];
        if (
          end.clientX - start.clientX > 90 &&
          Math.abs(end.clientY - start.clientY) < 45
        )
          void changeStatus(task.id, "done");
        start = null;
      },
      { passive: true },
    );
    return row;
  });
  return [
    button("+ " + t("personal"), personalForm, { class: "primary wide" }),
    filter,
    ...(rows.length ? rows : [empty(t("emptyTasks"))]),
  ];
}
async function changeSetting(key, value) {
  const scoped = ["groupId", "subgroup"].includes(key);
  S.settings[key] = value;
  if (key === "groupId") {
    const group = data().groups.find((g) => g.id === value);
    if (
      !group?.subgroups.includes(S.settings.subgroup) &&
      S.settings.subgroup !== "all"
    )
      S.settings.subgroup = group?.subgroups[0] || "А";
  }
  if (key === "lang") t = translator(value);
  saveSettings();
  if (scoped) {
    const epoch = ++S.epoch;
    S.personal = [];
    S.statuses = {};
    S.snapshot = {
      ...S.snapshot,
      data: {
        ...S.snapshot.data,
        tasks: [],
        announcements: (S.snapshot.data.announcements || []).filter(
          (n) => !n.groupId || n.groupId === S.settings.groupId,
        ),
      },
    };
    await loadPersonal();
    if (epoch !== S.epoch) return;
    const cached = await getSnapshot(S.settings);
    if (epoch !== S.epoch) return;
    if (cached && !S.demo) S.snapshot = cached;
    render();
    await refresh();
  } else render();
}
async function exportCalendar(days) {
  const { generateIcs } = await import("./lib/calendar.mjs");
  download(
    "uniflow-" + (days === 7 ? "week" : "semester") + ".ics",
    generateIcs(data(), scope(), {
      startDate: days === 7 ? monday(localDate()) : localDate(),
      days,
      reminderMinutes: Number(S.settings.reminder),
      now: new Date(),
    }),
    "text/calendar;charset=utf-8",
  );
}
async function reminderChange(value) {
  if (
    value &&
    (!("Notification" in window) ||
      (await Notification.requestPermission()) !== "granted")
  ) {
    toast(t("notificationDenied"));
    await changeSetting("reminder", 0);
    return;
  }
  await changeSetting("reminder", Number(value));
}
function staffUrl() {
  const url = new URL("./manage/", location.href);
  if (S.demo) url.searchParams.set("demo", S.demo);
  url.searchParams.set("group", S.settings.groupId);
  url.searchParams.set("subgroup", S.settings.subgroup);
  return url.href;
}
function renderMore() {
  const groupSelect = select(
    data().groups.map((g) => [g.id, g.name]),
    S.settings.groupId,
    (e) => e.target.value && changeSetting("groupId", e.target.value),
    { id: "group-select" },
  );
  const search = el("input", {
    type: "search",
    placeholder: t("searchGroup"),
    "aria-label": t("searchGroup"),
    oninput: (event) => {
      const matches = data().groups.filter((g) =>
        (g.name + " " + (g.specialty || ""))
          .toLowerCase()
          .includes(event.target.value.toLowerCase()),
      );
      groupSelect.replaceChildren(
        el(
          "option",
          { value: "", disabled: true },
          t(matches.length ? "chooseGroup" : "noGroups"),
        ),
        ...matches.map((g) => el("option", { value: g.id }, g.name)),
      );
      groupSelect.value = matches.some((g) => g.id === S.settings.groupId)
        ? S.settings.groupId
        : "";
    },
  });
  const group = data().groups.find((g) => g.id === S.settings.groupId);
  const calendar = el(
    "section",
    { class: "settings-section" },
    el("h2", {}, t("calendar")),
    el(
      "div",
      { class: "actions" },
      button(t("week"), () => exportCalendar(7), { class: "primary" }),
      button(t("semester"), () => exportCalendar(112)),
    ),
    el("p", { class: "notice" }, t("subscriptionHelp")),
  );
  const feed = new URL(
    "https://anfwdrcazwbkkayczkxg.supabase.co/functions/v1/uniflow-calendar",
  );
  feed.searchParams.set("group", S.settings.groupId);
  feed.searchParams.set("subgroup", S.settings.subgroup);
  feed.searchParams.set("reminder", String(S.settings.reminder));
  if (!S.demo) {
    const urlInput = el("input", {
      type: "url",
      value: feed.href,
      readonly: true,
      "aria-label": t("subscription"),
    });
    calendar.append(
      field(t("subscription"), urlInput),
      button(t("copyLink"), async () => {
        try {
          await navigator.clipboard.writeText(feed.href);
          toast(t("copied"));
        } catch {
          urlInput.focus();
          urlInput.select();
        }
      }),
    );
  } else calendar.append(el("p", { class: "notice" }, t("subscriptionDemo")));
  const reminder = el(
    "section",
    { class: "settings-section" },
    el("h2", {}, t("notifications")),
    field(
      t("reminder"),
      select(
        [
          [0, t("off")],
          [5, "5 мин"],
          [10, "10 мин"],
          [15, "15 мин"],
          [30, "30 мин"],
        ],
        String(S.settings.reminder),
        (e) => reminderChange(Number(e.target.value)),
      ),
    ),
    el("p", { class: "notice" }, t("notificationHelp")),
  );
  const installation = el(
    "section",
    { class: "settings-section" },
    button(t("install"), async () => {
      if (installPrompt) {
        await installPrompt.prompt();
        installPrompt = null;
      } else toast(t("installHelp"));
    }),
    el("h2", {}, t("about")),
    el("p", { class: "notice" }, t("aboutText")),
    el(
      "a",
      {
        href: "https://github.com/xan-xz/schedule/issues/new",
        target: "_blank",
        rel: "noopener noreferrer",
      },
      t("bug"),
    ),
  );
  const roles = el(
    "section",
    { class: "settings-section" },
    el("a", { href: staffUrl() }, S.demo ? t("manage") : t("staff")),
    el(
      "div",
      { class: "actions" },
      ["student", "teacher", "admin"].map((role) =>
        el("a", { href: "?demo=" + role }, t(role)),
      ),
    ),
    S.demo ? el("a", { href: "./" }, t("live")) : null,
    S.demo
      ? button(t("resetDemo"), async () => {
          if (!window.confirm(t("resetConfirm"))) return;
          try {
            localStorage.removeItem("uf.demo.source.v4");
          } catch {
            /* restricted browser */
          }
          await refresh();
        })
      : null,
  );
  return [
    field(t("searchGroup"), search),
    field(t("group"), groupSelect),
    field(
      t("subgroup"),
      select(
        [
          ...(group?.subgroups || ["А", "Б"]).map((s) => [s, s]),
          ["all", t("both")],
        ],
        S.settings.subgroup,
        (e) => changeSetting("subgroup", e.target.value),
      ),
    ),
    field(
      t("language"),
      select(
        [
          ["ru", "Русский"],
          ["kk", "Қазақша"],
          ["en", "English"],
        ],
        S.settings.lang,
        (e) => changeSetting("lang", e.target.value),
      ),
    ),
    field(
      t("theme"),
      select(
        ["system", "light", "dark"].map((value) => [value, t(value)]),
        S.settings.theme,
        (e) => changeSetting("theme", e.target.value),
      ),
    ),
    field(
      t("format"),
      select(
        [
          ["24", t("h24")],
          ["12", t("h12")],
        ],
        S.settings.hour12 ? "12" : "24",
        (e) => changeSetting("hour12", e.target.value === "12"),
      ),
    ),
    calendar,
    reminder,
    installation,
    roles,
  ];
}
function render() {
  header();
  updateStatus();
  if (!data()) {
    if (S.error)
      $("main").replaceChildren(el("h1", {}, t(S.page)), empty(t("noData")));
    return;
  }
  $("main").replaceChildren(
    el("h1", {}, t(S.page)),
    ...{
      today: renderToday,
      week: renderWeek,
      tasks: renderTasks,
      more: renderMore,
    }[S.page](),
  );
}
async function setupWorker() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  try {
    const registration = await navigator.serviceWorker.register(
      new URL("./sw.js", import.meta.url),
      { scope: new URL("./", import.meta.url).pathname },
    );
    function offer(worker) {
      waitingWorker = worker;
      const bar = $("update-bar");
      bar.hidden = false;
      bar.replaceChildren(
        el("span", {}, t("update")),
        button(t("reload"), () => {
          if (!waitingWorker) return;
          // A neighbouring tab may have already activated this release. There
          // will be no second controllerchange event for this client.
          if (
            waitingWorker.state === "activated" ||
            waitingWorker.state === "redundant" ||
            registration.active === waitingWorker
          ) {
            location.reload();
            return;
          }
          navigator.serviceWorker.addEventListener(
            "controllerchange",
            () => location.reload(),
            { once: true },
          );
          waitingWorker.postMessage({ type: "SKIP_WAITING" });
        }),
      );
    }
    if (registration.waiting) offer(registration.waiting);
    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      worker?.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller)
          offer(worker);
      });
    });
  } catch {
    /* Core online app remains available when a browser blocks SW. */
  }
}
function tick() {
  if (document.hidden || !data()) return;
  if (lastDay !== localDate()) {
    lastDay = localDate();
    if (!isTyping()) render();
  }
  if (S.page === "today") {
    const line = timeline(data(), scope(), new Date());
    if (previousCurrent !== line.current?.id + ":" + line.current?.startDate) {
      if (!isTyping()) render();
    } else {
      if ($("remaining"))
        $("remaining").textContent = t(
          line.current ? "remaining" : "inMinutes",
          { n: line.current ? line.remainingMinutes : line.untilNextMinutes },
        );
      if ($("lesson-progress")) $("lesson-progress").value = line.progress;
    }
  }
  if (
    S.settings.reminder &&
    "Notification" in window &&
    Notification.permission === "granted"
  ) {
    const line = timeline(data(), scope(), new Date());
    const lesson = line.next,
      key = lesson?.id + ":" + lesson?.startDate;
    if (
      lesson &&
      line.untilNextMinutes > 0 &&
      line.untilNextMinutes <= S.settings.reminder &&
      !notices.has(key)
    ) {
      notices.add(key);
      const options = {
        body:
          t("inMinutes", { n: line.untilNextMinutes }) +
          " · " +
          name("rooms", lesson.roomId, t("noRoom")),
        tag: key,
      };
      // Mobile browsers often forbid the Notification constructor. Installed
      // worker notifications work while this page's timer is running.
      if ("serviceWorker" in navigator)
        void navigator.serviceWorker
          .getRegistration()
          .then((registration) => {
            if (registration)
              return registration.showNotification(
                name("subjects", lesson.subjectId),
                options,
              );
            return new Notification(
              name("subjects", lesson.subjectId),
              options,
            );
          })
          .catch(() => {});
      else
        try {
          new Notification(name("subjects", lesson.subjectId), options);
        } catch {
          /* Calendar alarms remain available. */
        }
    }
  }
}
$("refresh").addEventListener("click", refresh);
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
});
window.addEventListener("online", () => refresh());
window.addEventListener("offline", updateStatus);
window.addEventListener("storage", (event) => {
  if (event.key === "uf.demo.source.v4" && S.demo) void refresh();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    tick();
    void refresh();
  }
});
setInterval(() => {
  if (!document.hidden && navigator.onLine && !S.demo) void refresh();
}, 60000);
// Lesson times have minute precision. Align to their boundary rather than
// keeping a stale "current" lesson for up to 30 seconds after it ended.
function scheduleClockTick() {
  setTimeout(
    () => {
      tick();
      scheduleClockTick();
    },
    60000 - (Date.now() % 60000) + 10,
  );
}
scheduleClockTick();
applyTheme();
header();
await loadPersonal();
if (S.demo) {
  await refresh();
} else {
  const saved = await getSnapshot(S.settings);
  if (saved) setSnapshot(saved);
  else
    try {
      setSnapshot(await releaseSnapshot(S.settings));
    } catch {
      S.error = true;
      render();
    }
  void refresh();
}
void setupWorker();
