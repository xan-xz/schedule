import { XLSX_COLUMNS } from "./xlsx.mjs";

const normalize = (value) =>
  value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
const aliases = {
  group: ["группа", "учебная группа", "код группы", "топ", "топ коды"],
  day: ["день", "день недели", "апта күні", "күн"],
  start: ["начало", "время начала", "басталуы", "басталу уақыты"],
  end: ["конец", "окончание", "время окончания", "аяқталуы", "аяқталу уақыты"],
  subject: ["предмет", "дисциплина", "название дисциплины", "пән", "пән атауы"],
  room: ["кабинет", "аудитория", "ауд.", "бөлме"],
  teacher: ["преподаватель", "фио преподавателя", "оқытушы"],
  type: ["тип занятия", "вид занятия", "сабақ түрі"],
  subgroup: ["подгруппа", "кіші топ", "топша"],
  week: ["неделя", "чётность", "четность", "апта"],
  endDayOffset: ["смещение дня окончания", "следующий день"],
  id: ["идентификатор", "id занятия"],
};

const weekdays = new Map(
  [
    ["пн", "понедельник", "дс", "дүйсенбі"],
    ["вт", "вторник", "сс", "сейсенбі"],
    ["ср", "среда", "сәрсенбі"],
    ["чт", "четверг", "бс", "бейсенбі"],
    ["пт", "пятница", "жм", "жұма"],
    ["сб", "суббота", "сбт", "сенбі"],
    ["вс", "воскресенье", "жс", "жексенбі"],
  ].flatMap((values, index) => values.map((value) => [value, String(index)])),
);

export const normalizeXlsxDay = (value) =>
  weekdays.get(normalize(value)) ?? value;

export async function suggestXlsxColumns(
  headers,
  { faculty = false, suggest } = {},
) {
  const columns = faculty ? ["group", ...XLSX_COLUMNS] : XLSX_COLUMNS;
  const known = new Map(
    columns.flatMap((column) =>
      [column, ...aliases[column]].map((name) => [normalize(name), column]),
    ),
  );
  const mapped = headers.map((value) => known.get(normalize(value)));
  const unknown = mapped.flatMap((value, index) => (value ? [] : [index]));
  if (unknown.length && suggest) {
    const left = columns.filter((column) => !mapped.includes(column));
    const guesses = await suggest(
      unknown.map((index) => headers[index]),
      left,
    );
    if (Array.isArray(guesses) && guesses.length === unknown.length)
      unknown.forEach((index, i) => {
        if (left.includes(guesses[i])) mapped[index] = guesses[i];
      });
  }
  if (mapped.includes(undefined))
    throw Error(
      "Не удалось сопоставить столбцы «" +
        unknown
          .filter((index) => !mapped[index])
          .map((index) => headers[index] || "без названия")
          .join("», «") +
        "». Переименуйте их по шаблону.",
    );
  if (new Set(mapped).size !== mapped.length)
    throw Error(
      "Несколько столбцов сопоставлены одному полю. Проверьте заголовки.",
    );
  return mapped;
}

export async function suggestWithBionic(headers, allowed) {
  const endpoint =
    location.hostname === "127.0.0.1"
      ? new URL("../local-ai/columns", location.href)
      : location.origin === "https://xan-xz.github.io"
        ? new URL("http://127.0.0.1:4173/schedule/local-ai/columns")
        : null;
  if (!endpoint) return null;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ headers, allowed }),
      credentials: "omit",
      signal: AbortSignal.timeout(18000),
    });
    if (!response.ok) return null;
    return (await response.json()).columns;
  } catch {
    return null;
  }
}
