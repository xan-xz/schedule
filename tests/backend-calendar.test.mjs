import test from "node:test";
import assert from "node:assert/strict";
import { handle } from "../backend/calendar.mjs";
import { icsEscape } from "../app/lib/calendar.mjs";
import { localDate, dayOf } from "../app/lib/time.mjs";
function setup(t) {
  const old = globalThis.Deno;
  globalThis.Deno = {
    env: {
      get: (name) =>
        name === "SUPABASE_URL"
          ? "https://db.invalid"
          : name === "SUPABASE_SERVICE_ROLE_KEY"
            ? "server-only-fixture"
            : undefined,
    },
  };
  t.after(() => {
    if (old === undefined) delete globalThis.Deno;
    else globalThis.Deno = old;
  });
  const data = {
    groups: [
      { id: "g-main", name: "Group", subgroups: ["А", "Б"] },
      { id: "other", name: "Other", subgroups: ["А"] },
    ],
    subjects: [{ id: "s", name: "Subject" }],
    teachers: [{ id: "t", name: "Teacher" }],
    rooms: [{ id: "r", name: "204" }],
    lessons: [
      {
        id: "l",
        day: dayOf(localDate()),
        week: "all",
        start: "09:00",
        end: "09:50",
        subjectId: "s",
        teacherId: "t",
        roomId: "r",
        groupId: "g-main",
        subgroup: "А",
        type: "Lecture",
      },
      {
        id: "other",
        day: dayOf(localDate()),
        week: "all",
        start: "11:00",
        end: "11:50",
        subjectId: "s",
        teacherId: "t",
        roomId: "r",
        groupId: "other",
        subgroup: "А",
        type: "Lecture",
      },
    ],
    exceptions: [],
    tasks: [{ title: "PRIVATE_TASK" }],
    attendance: [{ studentId: "PRIVATE_STUDENT" }],
    history: [{ actor: "PRIVATE_ACTOR" }],
  };
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(
      JSON.stringify([
        { data, revision: 1, updated_at: "2026-11-05T00:00:00Z" },
      ]),
    );
  });
  return { data, calls };
}
const req = (query = "", options = {}) =>
  new Request("https://edge.invalid/uniflow-calendar" + query, options);
test("public calendar GET yields scoped UTC ICS for 112 days, no auth or private data", async (t) => {
  const { calls } = setup(t);
  const response = await handle(req("?group=g-main&subgroup=А&reminder=10"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/calendar/);
  assert.match(response.headers.get("cache-control"), /max-age=300/);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  const text = await response.text();
  assert.match(text, /BEGIN:VCALENDAR/);
  assert.equal((text.match(/BEGIN:VEVENT/g) || []).length, 16);
  assert.match(text, /DTSTART:\d{8}T040000Z/);
  assert.match(text, /LOCATION:204/);
  assert.match(text, /TRIGGER:-PT10M/);
  assert.equal(/PRIVATE_|UID:other/.test(text), false);
  assert.match(calls[0].url, /select=data,revision,updated_at/);
});
test("calendar conditional GET uses stable ETag and HEAD returns no body", async (t) => {
  setup(t);
  const first = await handle(req());
  const etag = first.headers.get("etag");
  assert.match(etag, /^"[a-f0-9]{64}"$/);
  const cached = await handle(req("", { headers: { "If-None-Match": etag } }));
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), "");
  const head = await handle(req("", { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(head.headers.get("etag"), etag);
});
test("calendar rejects unknown group/subgroup, invalid reminder and write methods", async (t) => {
  setup(t);
  assert.equal((await handle(req("?group=missing"))).status, 404);
  assert.equal((await handle(req("?subgroup=missing"))).status, 400);
  assert.equal((await handle(req("?reminder=-1"))).status, 400);
  assert.equal((await handle(req("?reminder=Infinity"))).status, 400);
  assert.equal((await handle(req("", { method: "POST" }))).status, 405);
  assert.equal((await handle(req("", { method: "OPTIONS" }))).status, 204);
});
test("calendar backend errors reveal no internal credentials", async (t) => {
  setup(t);
  t.mock.method(globalThis, "fetch", async () => {
    throw Error("secret server-only-fixture");
  });
  const response = await handle(req());
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes("server-only-fixture"), false);
  assert.equal(response.headers.get("cache-control"), "no-store");
});
test("ICS escapes standalone CR, LF and CRLF so text cannot create properties", () => {
  assert.equal(
    icsEscape("Subject\rATTENDEE:bad\nEND:VEVENT\r\nBEGIN:VEVENT"),
    "Subject\\nATTENDEE:bad\\nEND:VEVENT\\nBEGIN:VEVENT",
  );
  assert.equal(icsEscape("Room, 1;2\\3"), "Room\\, 1\\;2\\\\3");
});

test("archived and deleted group subscriptions return valid empty feed and restoration revives retained events", async (t) => {
  const { data } = setup(t);
  const original = structuredClone(data.lessons);
  for (const lifecycle of [
    { archivedAt: "2026-11-01T00:00:00.000Z" },
    { archived: true },
    { deleted: true, archivedAt: null },
  ]) {
    const base = { id: "g-main", name: "Group", subgroups: ["А", "Б"] };
    data.groups[0] = { ...base, ...lifecycle };
    const response = await handle(req("?group=g-main&subgroup=А"));
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /BEGIN:VCALENDAR/);
    assert.equal(text.includes("BEGIN:VEVENT"), false);
    assert.deepEqual(data.lessons, original);
  }
  data.groups[0] = {
    id: "g-main",
    name: "Group",
    subgroups: ["А", "Б"],
    archived: true,
    archivedAt: null,
  };
  const response = await handle(req("?group=g-main&subgroup=А"));
  assert.equal(response.status, 200);
  assert.equal(
    ((await response.text()).match(/BEGIN:VEVENT/g) || []).length,
    16,
  );
});
