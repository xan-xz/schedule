import test from "node:test";
import assert from "node:assert/strict";
import { handle } from "../backend/uniflow-api.mjs";

const limit = 2_000_000;
function sizedJson(bytes, character = "a") {
  const empty = JSON.stringify({ action: "login", padding: "" });
  const remaining = bytes - Buffer.byteLength(empty, "utf8");
  const width = Buffer.byteLength(character, "utf8");
  const padding =
    character.repeat(Math.floor(remaining / width)) +
    "a".repeat(remaining % width);
  const raw = JSON.stringify({ action: "login", padding });
  assert.equal(Buffer.byteLength(raw, "utf8"), bytes);
  return raw;
}
function request(raw, headers = {}) {
  return new Request("https://edge.invalid/uniflow-api", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: raw,
  });
}
async function oversized(response) {
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "Слишком большой запрос" });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
}
function noNetwork(t) {
  const fetcher = t.mock.method(globalThis, "fetch", () => {
    throw Error("Unexpected network request");
  });
  t.after(() => assert.equal(fetcher.mock.callCount(), 0));
}

test("the exact ASCII byte boundary reaches existing action handling while one extra byte rejects", async (t) => {
  noNetwork(t);
  const accepted = request(sizedJson(limit));
  assert.equal(accepted.headers.get("content-length"), null);
  // Retired login returns410 before Auth/database IO: the body limit accepted it.
  assert.equal((await handle(accepted)).status, 410);
  await oversized(await handle(request(sizedJson(limit + 1))));
});

test("UTF-8 bytes enforce the same exact boundary without Content-Length even below the UTF-16 length limit", async (t) => {
  noNetwork(t);
  const accepted = request(sizedJson(limit, "я"));
  assert.equal(accepted.headers.get("content-length"), null);
  assert.equal((await handle(accepted)).status, 410);
  const raw = sizedJson(limit + 1, "я");
  assert.ok(raw.length < limit);
  const tooLarge = request(raw);
  assert.equal(tooLarge.headers.get("content-length"), null);
  await oversized(await handle(tooLarge));
});

test("an understated Content-Length cannot bypass the actual Unicode body byte limit", async (t) => {
  noNetwork(t);
  const tooLarge = request(sizedJson(limit + 1, "😀"), {
    "Content-Length": "20",
  });
  await oversized(await handle(tooLarge));
});

test("a declared oversized body rejects before reading it and keeps the413 response contract", async (t) => {
  noNetwork(t);
  const readBody = t.mock.fn(async () => {
    throw Error("The oversized declared body must not be read");
  });
  await oversized(
    await handle({
      method: "POST",
      headers: new globalThis.Headers({ "Content-Length": String(limit + 1) }),
      text: readBody,
    }),
  );
  assert.equal(readBody.mock.callCount(), 0);
});

test("a small malformed JSON body still receives the existing400 response", async (t) => {
  noNetwork(t);
  const response = await handle(request("{"));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Некорректный запрос" });
});
