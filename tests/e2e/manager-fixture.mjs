import { expect } from "@playwright/test";
import { mutate, visible, validate } from "../../backend/core.mjs";
import { fixture, mockState } from "./fixtures.mjs";

/** Local HTTP contract only: no injected session, production data or real mail. */
export async function mockManager(
  page,
  {
    role = "admin",
    rejectPassword = false,
    archived = false,
    prepareData = () => {},
  } = {},
) {
  await mockState(page);
  const calls = [];
  let data = structuredClone(fixture),
    revision = 7;
  data.lessons.push({ ...data.lessons[0], id: "monday-lesson", day: 0 });
  if (archived) {
    data.attendance = [
      {
        lessonId: "now-a",
        studentId: "archived-student",
        date: "2026-11-06",
        status: "present",
      },
    ];
    data.requests = [
      {
        id: "archived-request",
        lessonId: "now-a",
        teacherId: "teacher",
        date: "2026-11-06",
        start: "10:00",
        end: "10:50",
        roomId: "204",
        reason: "Archived request retained as data",
        status: "pending",
        createdAt: "2026-11-05T04:00:00Z",
      },
    ];
  }
  prepareData(data);
  validate(data);
  const versions = [];
  const owner = {
    id: "11111111-1111-4111-8111-111111111111",
    email: "owner@example.invalid",
  };
  const user = {
    ...owner,
    name: "Владелец",
    role,
    ...(role === "teacher" ? { teacherId: "teacher" } : {}),
  };
  const token = "ow1a." + "a".repeat(64);
  const response = (authenticated) => ({
    data: visible(
      data,
      authenticated
        ? user
        : { id: "guest", role: "guest", groupId: "g-main", subgroup: "А" },
    ),
    revision,
    user: authenticated
      ? user
      : {
          id: "guest",
          role: "guest",
          name: "Посетитель",
          groupId: "g-main",
          subgroup: "А",
        },
    users: [],
    versions:
      authenticated && role === "admin"
        ? versions.map(({ data: _data, ...value }) => value)
        : [],
    capabilities: { logoutAll: true, allSubgroupTasks: true },
  });
  await page.routeWebSocket(/supabase\.co/, (socket) => socket.close());
  await page.route(
    "https://anfwdrcazwbkkayczkxg.supabase.co/**",
    async (route) => {
      if (route.request().method() === "OPTIONS")
        return route.fulfill({
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "*",
          },
        });
      let body;
      try {
        body = route.request().postDataJSON();
      } catch {
        return route.fulfill({
          status: 400,
          json: { error: "Unsupported fixture request" },
        });
      }
      calls.push(body);
      if (route.request().url().endsWith("/owner-access")) {
        if (body.action === "status")
          return route.fulfill({
            json: { available: true, configured: true, setupRequired: false },
          });
        if (body.action === "login.begin")
          return route.fulfill(
            rejectPassword
              ? { status: 401, json: { code: "INVALID_PROOF" } }
              : {
                  json: {
                    challengeId: "ow1c." + "c".repeat(64),
                    expiresAt: "2026-11-06T04:05:00Z",
                    emailHint: "o***@example.invalid",
                  },
                },
          );
        if (body.action === "login.verify")
          return route.fulfill({
            json: {
              token,
              refreshToken: "ow1r." + "b".repeat(64),
              expiresAt: "2026-11-06T04:15:00Z",
              refreshExpiresAt: "2026-11-06T05:00:00Z",
              owner,
            },
          });
        if (["logout", "logout.all"].includes(body.action))
          return route.fulfill({ json: { ok: true } });
        return route.fulfill({
          status: 400,
          json: { code: "INVALID_REQUEST" },
        });
      }
      if (!route.request().url().endsWith("/uniflow-api"))
        return route.fulfill({
          status: 400,
          json: { error: "Unknown fixture endpoint" },
        });
      const authenticated = body.token === token;
      if (body.action === "state")
        return route.fulfill({ json: response(authenticated) });
      if (!authenticated || role !== "admin")
        return route.fulfill({ status: 403, json: { error: "Нет доступа" } });
      if (!["mutate", "rollback"].includes(body.action))
        return route.fulfill({ status: 410, json: { error: "Недоступно" } });
      if (body.revision !== revision)
        return route.fulfill({
          status: 409,
          json: {
            error: "Данные уже изменились. Обнови страницу и повтори действие.",
          },
        });
      try {
        const before = structuredClone(data);
        let reason;
        if (body.action === "mutate") {
          const result = mutate(data, user, body.op, body.payload);
          data = result.data;
          reason = result.summary;
        } else {
          const prior = versions.find((item) => item.revision === body.target);
          if (!prior) throw Error("Версия не найдена");
          data = structuredClone(prior.data);
          validate(data);
          reason = "Откат к версии " + body.target;
        }
        versions.unshift({
          revision,
          actor: user.name,
          reason,
          created_at: "2026-11-06T04:00:00Z",
          data: before,
        });
        revision++;
        return route.fulfill({ json: response(true) });
      } catch (error) {
        return route.fulfill({ status: 400, json: { error: error.message } });
      }
    },
  );
  async function login({ navigate = true } = {}) {
    if (navigate) await page.goto("/schedule/admin/");
    await page
      .getByLabel("Пароль владельца", { exact: true })
      .fill("fixture-only-password");
    await page.getByRole("button", { name: "Продолжить", exact: true }).click();
    if (rejectPassword) return;
    await page.getByLabel("Код или ссылка из письма").fill("123456");
    await page.getByLabel("Код из приложения", { exact: true }).fill("654321");
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await expect(page.locator('#app[aria-busy="true"]')).toHaveCount(0);
    await expect(
      page.getByRole("navigation", { name: "Разделы", exact: true }),
    ).toBeVisible();
  }
  return {
    calls,
    login,
    advance(op, payload) {
      const result = mutate(data, user, op, payload);
      data = result.data;
      revision++;
      return response(true);
    },
    state: () => ({
      data: structuredClone(data),
      revision,
      versions: structuredClone(versions),
    }),
    writes: () =>
      calls.filter((call) => ["mutate", "rollback"].includes(call.action)),
  };
}
