import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { handle } from "../backend/uniflow-api.mjs";
import { visible } from "../backend/core.mjs";
import { OWNER_EMAIL } from "../backend/owner-access.mjs";
const privateMarker = "SYNTHETIC_PRIVATE_HTTP_METADATA_SENTINEL";
const source = JSON.parse(
  await readFile(new URL("../app/seed.json", import.meta.url), "utf8"),
);
function fixture() {
  const data = structuredClone(source),
    lesson = data.lessons[0];
  for (const key of ["groups", "subjects", "teachers", "rooms"])
    Object.assign(data[key][0], {
      ownerOnly: privateMarker,
      opaqueFuture: { private: privateMarker },
    });
  Object.assign(data.groups[0], { deleted: false, archivedAt: null });
  Object.assign(data.subjects[0], { shortName: "Алг" });
  Object.assign(data.rooms[0], {
    note: privateMarker,
    building: "A",
    floor: "2",
  });
  data.ownerOnly = privateMarker;
  data.source = { private: privateMarker };
  data.sourceWarnings = [{ private: privateMarker }];
  data.sourceConflictPairs = [privateMarker];
  data.lessons[0].ownerOnly = privateMarker;
  data.requests = [
    {
      id: "teacher-request",
      lessonId: lesson.id,
      date: "2026-11-09",
      status: "pending",
      teacherId: lesson.teacherId,
      reason: privateMarker,
    },
  ];
  data.attendance = [
    {
      lessonId: lesson.id,
      date: "2026-11-09",
      studentId: "student-1",
      status: "present",
      private: privateMarker,
    },
    {
      lessonId: lesson.id,
      date: "2026-11-09",
      studentId: "guest",
      status: "present",
      private: privateMarker,
    },
  ];
  data.history = [{ id: "audit", private: privateMarker }];
  return data;
}
function backend(t) {
  const row = { data: fixture(), revision: 11 },
    calls = [];
  const prior = Object.getOwnPropertyDescriptor(globalThis, "Deno");
  Object.defineProperty(globalThis, "Deno", {
    configurable: true,
    value: {
      env: {
        get: (name) =>
          ({
            SUPABASE_URL: "https://privacy-fixture.invalid",
            SUPABASE_SERVICE_ROLE_KEY: "fixture-server-key",
          })[name],
      },
    },
  });
  t.after(() => {
    if (prior) Object.defineProperty(globalThis, "Deno", prior);
    else delete globalThis.Deno;
  });
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const path = String(url).split("/rest/v1/")[1];
    calls.push({ path, method: init.method || "GET" });
    let result;
    if (path === "uf_platform?id=eq.1") result = [row];
    else if (path === "rpc/owner_access_command")
      result = {
        id: "22222222-2222-4222-8222-222222222222",
        owner_uid: "11111111-1111-4111-8111-111111111111",
        owner_email: OWNER_EMAIL,
        native_session_id: "33333333-3333-4333-8333-333333333333",
        expires_at: "2099-01-01T00:00:00Z",
      };
    else if (path?.startsWith("uf_versions?")) result = [];
    else throw Error("Unexpected fixture request");
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  });
  return { row, calls };
}
const request = (body) =>
  new Request("https://edge.invalid/uniflow-api", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://xan-xz.github.io",
    },
    body: JSON.stringify(body),
  });

test("real guest HTTP response has a closed root/row DTO even when a legacy attendance row uses the guest ID", async (t) => {
  const { row, calls } = backend(t),
    original = structuredClone(row.data);
  const response = await handle(
    request({
      action: "state",
      groupId: row.data.groups[0].id,
      subgroup: "all",
    }),
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(privateMarker));
  assert.equal(payload.data.groups[0].deleted, false);
  assert.equal(payload.data.groups[0].archivedAt, null);
  assert.equal(payload.data.subjects[0].shortName, "Алг");
  assert.equal(payload.data.rooms[0].building, "A");
  assert.equal(payload.data.rooms[0].floor, "2");
  for (const key of ["attendance", "requests", "history"])
    assert.deepEqual(payload.data[key], []);
  assert.deepEqual(row.data, original);
  assert.deepEqual(calls, [{ path: "uf_platform?id=eq.1", method: "GET" }]);
});

test("verified owner HTTP state retains unknown metadata, provenance and owner-only notes losslessly", async (t) => {
  const { row } = backend(t),
    original = structuredClone(row.data);
  const response = await handle(
    request({ action: "state", token: "ow1a." + "b".repeat(64) }),
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.user.role, "admin");
  assert.deepEqual(payload.data, original);
  assert.deepEqual(row.data, original);
  assert.equal(payload.data.rooms[0].note, privateMarker);
});

test("catalog projection leaves legacy teacher/student authorized private collections scoped exactly as before", () => {
  const data = fixture(),
    lesson = data.lessons[0],
    original = structuredClone(data);
  const teacher = visible(data, {
    role: "teacher",
    id: "teacher-user",
    teacherId: lesson.teacherId,
  });
  const student = visible(data, {
    role: "student",
    id: "student-1",
    groupId: lesson.groupId,
    subgroup: "all",
  });
  assert.deepEqual(teacher.requests, data.requests);
  assert.deepEqual(teacher.attendance, data.attendance);
  assert.deepEqual(student.requests, []);
  assert.deepEqual(student.attendance, [data.attendance[0]]);
  for (const value of [teacher, student]) {
    for (const key of ["groups", "subjects", "teachers", "rooms"])
      assert.doesNotMatch(
        JSON.stringify(value[key]),
        new RegExp(privateMarker),
      );
    assert.equal(Object.hasOwn(value.rooms[0], "note"), false);
  }
  assert.deepEqual(data, original);
});
