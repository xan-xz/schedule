export const fixture = {
  groups: [{ id: "g-main", name: "06-057-25-11", subgroups: ["А", "Б"] }],
  subjects: [
    { id: "math", name: "Алгоритмы", color: "#7957d5" },
    { id: "systems", name: "Операционные системы", color: "#7957d5" },
  ],
  teachers: [
    { id: "teacher", name: "А. Преподаватель", subjects: ["math", "systems"] },
  ],
  rooms: [
    { id: "204", name: "204", capacity: 30 },
    { id: "205", name: "205", capacity: 30 },
  ],
  lessons: [
    {
      id: "now-a",
      day: 4,
      week: "all",
      start: "08:00",
      end: "09:50",
      groupId: "g-main",
      subgroup: "А",
      subjectId: "math",
      teacherId: "teacher",
      roomId: "204",
      type: "Практика",
    },
    {
      id: "next",
      day: 4,
      week: "all",
      start: "11:00",
      end: "11:50",
      groupId: "g-main",
      subgroup: "all",
      subjectId: "systems",
      teacherId: "teacher",
      roomId: "205",
      type: "Лекция",
    },
    {
      id: "later-b",
      day: 4,
      week: "all",
      start: "13:00",
      end: "13:50",
      groupId: "g-main",
      subgroup: "Б",
      subjectId: "math",
      teacherId: "teacher",
      roomId: "204",
      type: "Практика",
    },
  ],
  exceptions: [],
  tasks: [
    {
      id: "shared-task",
      title: "Решить задачи по алгоритмам",
      description: "Задачи 1–3",
      due: "2026-11-07",
      subjectId: "math",
      teacherId: "teacher",
      groupId: "g-main",
      subgroup: "all",
    },
  ],
  announcements: [],
  requests: [],
  attendance: [],
  history: [],
};

export async function mockState(
  page,
  { time = new Date("2026-11-06T04:00:00Z"), ticking = false } = {},
) {
  const requests = [];
  if (ticking) await page.clock.install({ time });
  else await page.clock.setFixedTime(time);
  await page.route(
    "https://anfwdrcazwbkkayczkxg.supabase.co/**",
    async (route) => {
      const req = route.request();
      if (req.method() === "OPTIONS") {
        await route.fulfill({
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "*",
          },
        });
        return;
      }
      const body = req.postDataJSON();
      requests.push(body);
      if (body.action === "state") {
        await route.fulfill({
          json: {
            data: fixture,
            revision: 7,
            user: {
              id: "guest",
              role: "guest",
              groupId: "g-main",
              subgroup: body.subgroup === "Б" ? "Б" : "А",
              name: "Посетитель",
            },
            users: [],
            versions: [],
          },
        });
      } else {
        await route.fulfill({
          status: 401,
          json: { error: "Неверный логин или пароль" },
        });
      }
    },
  );
  return requests;
}
