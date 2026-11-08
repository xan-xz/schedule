import { clone, DAYS, isGroupActive } from "../core.mjs";
import { copyDay, copyWeek } from "./tools.mjs";
import { applyTemplate } from "./templates.mjs";
import { assertDraftRecoverable } from "./drafts.mjs";

/** A memory-only candidate with new IDs, reused unchanged by explicit apply. */
export function previewTransfer(
  data,
  user,
  options,
  { before = data, replacements = [] } = {},
) {
  if (user?.role !== "admin") throw Error("Требуется вход владельца.");
  const group = data.groups.find((row) => row.id === options.groupId);
  if (!group || !isGroupActive(group)) throw Error("Выберите активную группу.");
  let result;
  if (options.kind === "day") result = copyDay(data, options);
  else if (options.kind === "week") result = copyWeek(data, options);
  else if (options.kind === "template")
    result = applyTemplate(data, options.template, options);
  else throw Error("Неизвестный способ копирования.");
  try {
    assertDraftRecoverable(before, result, replacements);
  } catch {
    throw Error(
      "Сведения или порядок записей нельзя точно восстановить из локальной копии. Копирование не применено.",
    );
  }
  const oldIds = new Set(data.lessons.map((row) => row.id));
  const added = result.lessons.filter((row) => !oldIds.has(row.id));
  if (!added.length) throw Error("Нет занятий для добавления.");
  return { data: result, added: clone(added), count: added.length };
}

const clip = (value, limit = 240) =>
  Array.from(String(value ?? ""))
    .slice(0, limit)
    .join("");
/** Closed display records: never return provenance, notes or private payload. */
export function transferPage(plan, page = 0) {
  if (!Number.isInteger(page) || page < 0) throw Error("Неверная страница.");
  const data = plan.data;
  const name = (kind, id) =>
    clip(data[kind].find((row) => row.id === id)?.name || "Не назначено");
  return plan.added.slice(page * 40, (page + 1) * 40).map((row) => ({
    id: row.id,
    title: clip(
      `${DAYS[row.day]} · ${row.start}–${row.end}${row.endDayOffset ? " (+1 день)" : ""}`,
    ),
    text: [
      name("subjects", row.subjectId),
      name("rooms", row.roomId),
      name("teachers", row.teacherId),
      clip(row.type),
      row.subgroup === "all" ? "Все подгруппы" : clip(row.subgroup),
      { all: "Каждую неделю", odd: "Нечётная", even: "Чётная" }[row.week],
    ].join(" · "),
    period: `Период: ${row.validFrom || data.validFrom || "без начальной даты"} — ${row.validUntil || data.validUntil || "без конечной даты"}`,
  }));
}
