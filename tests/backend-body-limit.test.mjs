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

function streamed(body) {
  return new Request("https://edge.invalid/uniflow-api", {
    method: "POST",
    body,
    duplex: "half",
  });
}

test("oversized unknown-length streams stop early and cancel the producer without network IO", async (t) => {
  noNetwork(t);
  let pulls = 0,
    cancelled = 0;
  const req = streamed(
    new ReadableStream({
      pull(controller) {
        if (++pulls > 8)
          throw Error("The consumer drained past its byte limit");
        controller.enqueue(new Uint8Array(600_000));
      },
      cancel() {
        cancelled++;
      },
    }),
  );
  await oversized(await handle(req));
  assert.ok(pulls <= 5);
  assert.equal(cancelled, 1);
  assert.equal(req.body.locked, false);
});

test("a stalled producer cancellation cannot hold the oversized response open", async (t) => {
  noNetwork(t);
  let timer;
  const req = streamed(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(limit + 1));
      },
      cancel() {
        return new Promise(() => {});
      },
    }),
  );
  try {
    await oversized(
      await Promise.race([
        handle(req),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error("Cancellation stalled response")),
            1000,
          );
        }),
      ]),
    );
  } finally {
    clearTimeout(timer);
  }
  assert.equal(req.body.locked, false);
});

test("stream chunk boundaries preserve split UTF-8 sequences and BOM decoding", async (t) => {
  noNetwork(t);
  const bytes = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(JSON.stringify({ action: "login", padding: "я😀" })),
  ]);
  let offset = 0;
  const req = streamed(
    new ReadableStream({
      pull(controller) {
        if (offset === bytes.length) controller.close();
        else controller.enqueue(bytes.subarray(offset, ++offset));
      },
    }),
  );
  assert.equal((await handle(req)).status, 410);
  assert.equal(req.body.locked, false);
});

test("stream read errors retain the generic unavailable response and release the reader", async (t) => {
  noNetwork(t);
  const req = streamed(
    new ReadableStream({
      pull(controller) {
        controller.error(Error("PRIVATE_STREAM_ERROR"));
      },
    }),
  );
  const response = await handle(req);
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes("PRIVATE_STREAM_ERROR"), false);
  assert.equal(req.body.locked, false);
});

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

test("UTF-8 BOM bytes count toward the wire limit while a valid boundary body still decodes as JSON", async (t) => {
  noNetwork(t);
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const boundary = Buffer.concat([
    bom,
    Buffer.from(sizedJson(limit - bom.length), "utf8"),
  ]);
  assert.equal(boundary.byteLength, limit);
  const accepted = request(boundary);
  assert.equal(accepted.headers.get("content-length"), null);
  assert.equal((await handle(accepted)).status, 410);
  const excess = Buffer.concat([bom, Buffer.from(sizedJson(limit), "utf8")]);
  assert.equal(excess.byteLength, limit + 3);
  const tooLarge = request(excess);
  assert.equal(tooLarge.headers.get("content-length"), null);
  await oversized(await handle(tooLarge));
});

test("a small invalid UTF-8 sequence inside a JSON string retains replacement decoding", async (t) => {
  noNetwork(t);
  const bytes = Buffer.concat([
    Buffer.from('{"action":"login","padding":"', "utf8"),
    Buffer.from([0xff]),
    Buffer.from('"}', "utf8"),
  ]);
  assert.equal((await handle(request(bytes))).status, 410);
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
      arrayBuffer: readBody,
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
