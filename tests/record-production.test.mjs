import test from "node:test";
import assert from "node:assert/strict";
import {
  parseGitHubLookup,
  releaseAssets,
  inspectRelease,
  ensureLockedRelease,
  lookupReleaseIncludingDrafts,
} from "../scripts/locked-release.mjs";

const expected = {
  sourceRef: "a".repeat(40),
  tag: "uniflow-production-123",
  assets: releaseAssets(
    Buffer.from("verified tar"),
    Buffer.from('{"verified":true}\n'),
  ),
};
const remoteAsset = (asset) => ({
  name: asset.name,
  size: asset.size,
  digest: "sha256:" + asset.sha256,
  state: "uploaded",
});
const absent = () => ({
  status: 404,
  body: { message: "Not Found", status: "404" },
});
const release = (overrides = {}) => ({
  status: 200,
  body: {
    tag_name: expected.tag,
    target_commitish: expected.sourceRef,
    draft: false,
    prerelease: false,
    immutable: true,
    assets: expected.assets.map(remoteAsset),
    ...overrides,
  },
});
const response = (status, body, exit = status === 200 ? 0 : 1) => ({
  status: exit,
  stdout:
    "HTTP/2.0 " +
    status +
    " Status\r\nContent-Type: application/json\r\n\r\n" +
    JSON.stringify(body),
});

test("published-only tag lookup discovers an authenticated draft on a later release page", async () => {
  const reads = [];
  const result = await lookupReleaseIncludingDrafts({
    tag: expected.tag,
    lookupPublished: async () => {
      reads.push("tag");
      return response(404, absent().body);
    },
    listPages: async () => ({
      status: 0,
      stdout: JSON.stringify([
        [{ tag_name: "other", id: 1 }],
        [{ tag_name: expected.tag, id: 321 }],
      ]),
    }),
    lookupById: async (id) => {
      reads.push(id);
      return response(
        200,
        release({ draft: true, immutable: false, assets: [] }).body,
      );
    },
  });
  assert.equal(result.body.draft, true);
  assert.deepEqual(reads, ["tag", 321]);
});

test("failed, partial or ambiguous draft enumeration never establishes absence", async () => {
  for (const list of [
    { status: 1, stdout: "[[]]" },
    { status: 0, stdout: "garbage" },
    { status: 0, stdout: "[]" },
    { status: 0, stdout: "[{}]" },
    { status: 0, stdout: "[[{}]]" },
    {
      status: 0,
      stdout: JSON.stringify([[{ tag_name: expected.tag, id: "../321" }]]),
    },
    {
      status: 0,
      stdout: JSON.stringify([
        [
          { tag_name: expected.tag, id: 1 },
          { tag_name: expected.tag, id: 2 },
        ],
      ]),
    },
  ]) {
    await assert.rejects(
      lookupReleaseIncludingDrafts({
        tag: expected.tag,
        lookupPublished: async () => response(404, absent().body),
        listPages: async () => list,
        lookupById: async () => {
          throw Error("must not resolve an invalid identity");
        },
      }),
    );
  }
  await assert.rejects(
    lookupReleaseIncludingDrafts({
      tag: expected.tag,
      lookupPublished: async () => response(404, absent().body),
      listPages: async () => ({
        status: 0,
        stdout: JSON.stringify([[{ tag_name: expected.tag, id: 1 }]]),
      }),
      lookupById: async () => response(404, absent().body),
    }),
  );
});

test("published releases and permission failures do not fall back to draft guessing", async () => {
  let lists = 0;
  const driver = {
    tag: expected.tag,
    lookupPublished: async () => response(200, release().body),
    listPages: async () => {
      lists++;
      throw Error("not needed");
    },
    lookupById: async () => {
      throw Error("not needed");
    },
  };
  assert.equal(
    (await lookupReleaseIncludingDrafts(driver)).body.immutable,
    true,
  );
  await assert.rejects(
    lookupReleaseIncludingDrafts({
      ...driver,
      lookupPublished: async () => response(403, {}),
    }),
  );
  assert.equal(lists, 0);
});
function fixture(initial = absent()) {
  const f = { current: structuredClone(initial), operations: [], fail: {} };
  f.lookup = async () => {
    f.operations.push("read");
    if (f.fail.read) throw Error("lookup unavailable");
    return structuredClone(f.current);
  };
  f.createDraft = async () => {
    f.operations.push("create");
    if (f.fail.createBefore) throw Error("create unavailable");
    f.current = release({ draft: true, immutable: false, assets: [] });
    if (f.fail.createAfter) throw Error("lost create response");
  };
  f.upload = async (name) => {
    f.operations.push("upload:" + name);
    if (f.fail.uploadBefore) throw Error("upload unavailable");
    f.current.body.assets.push(
      remoteAsset(expected.assets.find((a) => a.name === name)),
    );
    if (f.fail.uploadAfter) throw Error("lost upload response");
  };
  f.publish = async () => {
    f.operations.push("publish");
    if (f.fail.publishBefore) throw Error("publish unavailable");
    f.current.body.draft = false;
    f.current.body.immutable = !f.fail.lock;
    if (f.fail.publishAfter) throw Error("lost publish response");
  };
  f.run = () => ensureLockedRelease({ ...expected, ...f });
  f.writes = () => f.operations.filter((op) => op !== "read");
  return f;
}

test("only an explicit HTTP 404 JSON response establishes absence", () => {
  assert.equal(
    inspectRelease(parseGitHubLookup(response(404, absent().body)), expected)
      .kind,
    "missing",
  );
  for (const raw of [
    response(403, {}),
    response(500, {}),
    { ...response(200, {}), stdout: "garbage" },
    { ...response(200, {}), stdout: "HTTP/2.0 200 OK\n\nnot-json" },
    { ...response(200, {}), status: 1 },
    { ...response(404, absent().body), status: 0 },
    response(404, {}),
    response(404, { message: "no", status: "403" }),
    { status: null, signal: "SIGTERM", stdout: "" },
    { status: 1, error: Error("network"), stdout: "" },
  ])
    assert.throws(() => parseGitHubLookup(raw));
});

test("new release uploads into a draft, verifies exact remote bytes, then publishes and verifies the provider lock", async () => {
  const f = fixture();
  assert.equal(await f.run(), "created");
  assert.deepEqual(f.operations, [
    "read",
    "create",
    "read",
    "upload:production-site.tar",
    "read",
    "upload:production.json",
    "read",
    "publish",
    "read",
  ]);
  assert.equal(inspectRelease(f.current, expected).kind, "published");
});

test("full recording works when the real tag endpoint hides every unpublished draft", async () => {
  const f = fixture();
  f.lookup = async () => {
    f.operations.push("read");
    return lookupReleaseIncludingDrafts({
      tag: expected.tag,
      lookupPublished: async () =>
        f.current.status === 200 && !f.current.body.draft
          ? response(200, f.current.body)
          : response(404, absent().body),
      listPages: async () => ({
        status: 0,
        stdout: JSON.stringify([
          f.current.status === 200 ? [{ tag_name: expected.tag, id: 321 }] : [],
        ]),
      }),
      lookupById: async () => response(200, f.current.body),
    });
  };
  assert.equal(await f.run(), "created");
  assert.deepEqual(f.writes(), [
    "create",
    "upload:production-site.tar",
    "upload:production.json",
    "publish",
  ]);
});

test("a partial same-source draft resumes only missing assets, without replacement", async () => {
  const f = fixture(
    release({
      draft: true,
      immutable: false,
      assets: [remoteAsset(expected.assets[0])],
    }),
  );
  assert.equal(await f.run(), "completed");
  assert.deepEqual(f.writes(), ["upload:production.json", "publish"]);
});

test("a completed immutable release is idempotent and produces no writes", async () => {
  const f = fixture(release());
  assert.equal(await f.run(), "existing");
  assert.deepEqual(f.writes(), []);
});

test("wrong source, tag, draft state, digest, size, duplicate or extra assets fail before mutation", async () => {
  const cases = [
    release({ target_commitish: "b".repeat(40) }),
    release({ tag_name: "another-tag" }),
    release({ draft: undefined }),
    release({ prerelease: true }),
    release({ assets: null }),
    release({ assets: [] }),
    release({ immutable: false }),
    release({
      assets: [
        ...expected.assets.map(remoteAsset),
        remoteAsset(expected.assets[0]),
      ],
    }),
    release({
      assets: [
        {
          ...remoteAsset(expected.assets[0]),
          digest: "sha256:" + "b".repeat(64),
        },
      ],
    }),
    release({
      draft: true,
      immutable: false,
      assets: [{ ...remoteAsset(expected.assets[0]), size: 999 }],
    }),
    release({
      draft: true,
      immutable: false,
      assets: [{ ...remoteAsset(expected.assets[0]), state: "new" }],
    }),
    release({
      draft: true,
      immutable: false,
      assets: [{ ...remoteAsset(expected.assets[0]), name: "unexpected.txt" }],
    }),
    release({ draft: true, immutable: true }),
    { status: 403, body: {} },
    { status: 500, body: {} },
    { status: 404, body: {} },
  ];
  for (const initial of cases) {
    const f = fixture(initial);
    await assert.rejects(f.run());
    assert.deepEqual(f.writes(), []);
  }
});

test("a lost draft-create response is reconciled from positive evidence, never by recreating", async () => {
  const f = fixture();
  f.fail.createAfter = true;
  assert.equal(await f.run(), "created");
  assert.equal(f.writes().filter((op) => op === "create").length, 1);
});

test("lost upload responses are accepted only after matching remote digest and size", async () => {
  const f = fixture();
  f.fail.uploadAfter = true;
  assert.equal(await f.run(), "created");
  assert.deepEqual(f.writes(), [
    "create",
    "upload:production-site.tar",
    "upload:production.json",
    "publish",
  ]);
  const bad = fixture();
  bad.upload = async (name) => {
    bad.operations.push("upload:" + name);
    bad.current.body.assets.push({
      ...remoteAsset(expected.assets[0]),
      digest: null,
    });
    throw Error("response lost");
  };
  await assert.rejects(bad.run());
  assert.equal(bad.writes().includes("publish"), false);
});

test("a lost publish response is accepted only after the locked published release is read back", async () => {
  const f = fixture();
  f.fail.publishAfter = true;
  assert.equal(await f.run(), "created");
  assert.equal(f.writes().filter((op) => op === "publish").length, 1);
});

test("a disabled provider lock cannot be reported as successful recording", async () => {
  const f = fixture();
  f.fail.lock = true;
  await assert.rejects(f.run(), /immutable/);
  await assert.rejects(f.run(), /immutable/);
  assert.equal(f.writes().filter((op) => op === "publish").length, 1);
});

test("unconfirmed create, upload and publish writes fail once and retain a recoverable draft", async () => {
  for (const phase of ["createBefore", "uploadBefore", "publishBefore"]) {
    const f = fixture();
    f.fail[phase] = true;
    await assert.rejects(f.run());
    assert.equal(f.writes().filter((op) => op === "create").length, 1);
    assert.ok(f.writes().filter((op) => op === "publish").length <= 1);
    if (phase === "publishBefore") {
      assert.equal(inspectRelease(f.current, expected).kind, "draft");
      f.fail.publishBefore = false;
      const before = f.writes().length;
      assert.equal(await f.run(), "completed");
      assert.deepEqual(f.writes().slice(before), ["publish"]);
    }
  }
});

test("lookup failure never becomes absence or another release creation", async () => {
  const f = fixture();
  f.fail.read = true;
  await assert.rejects(f.run());
  assert.deepEqual(f.writes(), []);
});

test("a competing publisher is accepted only when its complete locked artifact matches", async () => {
  const f = fixture();
  f.createDraft = async () => {
    f.operations.push("create");
    f.current = release();
    throw Error("already exists");
  };
  assert.equal(await f.run(), "existing");
  assert.deepEqual(f.writes(), ["create"]);
});

test("unpinned source, malformed tag and invalid expected assets are rejected before network IO", async () => {
  for (const change of [
    { sourceRef: "main" },
    { tag: "--evil" },
    { assets: [] },
    { assets: [expected.assets[0], expected.assets[0]] },
    { assets: [{ ...expected.assets[0], size: 2 ** 30 }, expected.assets[1]] },
    { assets: [{ ...expected.assets[0], sha256: "" }, expected.assets[1]] },
  ]) {
    let calls = 0;
    await assert.rejects(
      ensureLockedRelease({
        ...expected,
        ...change,
        lookup: async () => {
          calls++;
          return absent();
        },
      }),
    );
    assert.equal(calls, 0);
  }
});
