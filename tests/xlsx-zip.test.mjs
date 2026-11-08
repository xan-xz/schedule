import { test } from "node:test";
import assert from "node:assert/strict";
import { readZip, storeZip, crc32 } from "../app/manage/xlsx-zip.mjs";
import { scheduleWorkbook, exportScheduleXlsx } from "../app/manage/xlsx.mjs";
import { compressedZip } from "./xlsx-fixtures.mjs";

test("ZIP CRC matches the published check vector", () =>
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926));
for (const mode of ["stored", "deflate", "descriptor"])
  test(`bounded ZIP reads UTF-8 content with ${mode} framing`, async () => {
    const parts = {
      "xl/sheet.xml": "Текст <xml>&literal</xml>",
      "empty.xml": "",
    };
    const bytes =
      mode === "stored"
        ? storeZip(parts)
        : compressedZip(parts, mode === "descriptor");
    const zip = readZip(bytes);
    assert.deepEqual(zip.names, Object.keys(parts));
    for (const [name, text] of Object.entries(parts))
      assert.equal(new TextDecoder().decode(await zip.read(name)), text);
    await assert.rejects(zip.read("missing.xml"), /отсутствует/);
  });
for (const name of [
  "../x.xml",
  "/x.xml",
  "xl/../x.xml",
  "xl\\x.xml",
  "x%2exml",
  "xl//x.xml",
  "x:xml",
])
  test(`ZIP rejects unsafe name ${name}`, () =>
    assert.throws(() => readZip(compressedZip({ [name]: "x" })), /XLSX/));
const valid = () => Buffer.from(storeZip({ "x.xml": "123456789" }));
for (const [title, mutate] of [
  ["encryption", (b) => b.writeUInt16LE(0x801, 6)],
  ["unsupported method", (b) => b.writeUInt16LE(9, 8)],
  ["local checksum mismatch", (b) => b.writeUInt32LE(1, 14)],
  ["disk number", (b) => b.writeUInt16LE(1, b.length - 18)],
  ["directory count", (b) => b.writeUInt16LE(129, b.length - 12)],
  ["directory size", (b) => b.writeUInt32LE(1, b.length - 10)],
  ["local name mismatch", (b) => (b[30] = 121)],
  ["entry before boundary", (b) => b.writeUInt32LE(99, b.length - 22 - 5 - 4)],
])
  test(`ZIP rejects ${title}`, () => {
    const bytes = valid();
    mutate(bytes);
    assert.throws(() => readZip(bytes));
  });
test("ZIP verifies stored content CRC before reading XML", async () => {
  const bytes = valid();
  bytes[35] ^= 1;
  await assert.rejects(readZip(bytes).read("x.xml"), /XLSX/);
});
test("ZIP verifies deflated content CRC", async () => {
  const bytes = compressedZip({ "x.xml": "original" }),
    p = bytes.readUInt32LE(bytes.length - 6);
  bytes.writeUInt32LE(1, 14);
  bytes.writeUInt32LE(1, p + 16);
  await assert.rejects(readZip(bytes).read("x.xml"), /XLSX/);
});
test("ZIP stops deflate when actual output exceeds the declared bound", async () => {
  const bytes = compressedZip({ "x.xml": "x".repeat(300000) }),
    p = bytes.readUInt32LE(bytes.length - 6);
  bytes.writeUInt32LE(1, 22);
  bytes.writeUInt32LE(1, p + 24);
  await assert.rejects(readZip(bytes).read("x.xml"), /безопасно/);
});
test("ZIP caps compressed, individual and aggregate expanded input", () => {
  assert.throws(() => readZip(new Uint8Array(1_000_001)), /1 МБ/);
  assert.throws(
    () => readZip(compressedZip({ "x.xml": "x".repeat(2_000_001) })),
    /XLSX/,
  );
  assert.throws(
    () =>
      readZip(
        compressedZip(
          Object.fromEntries(
            Array.from({ length: 5 }, (_, i) => [
              `${i}.xml`,
              "x".repeat(1_900_000),
            ]),
          ),
        ),
      ),
    /XLSX/,
  );
});
test("ZIP rejects truncation, appended data, duplicate/overlapping local entries and broken descriptors", () => {
  const bytes = valid();
  assert.throws(() => readZip(bytes.subarray(0, -1)));
  assert.throws(() => readZip(Buffer.concat([bytes, Buffer.from([1])])));
  const duplicate = Buffer.from(storeZip({ "a.xml": "A", "b.xml": "B" })),
    p = duplicate.readUInt32LE(duplicate.length - 6);
  duplicate.writeUInt32LE(0, p + 46 + 5 + 42);
  assert.throws(() => readZip(duplicate));
  const descriptor = compressedZip({ "x.xml": "ok" }, true),
    directory = descriptor.readUInt32LE(descriptor.length - 6);
  descriptor[directory - 1] = 255;
  assert.throws(() => readZip(descriptor));
});
test("XLSX export writes references and dangerous-looking values as literal text", async () => {
  const bytes = scheduleWorkbook([
    [
      0,
      "08:00",
      "08:50",
      "=SUM(1,2)",
      "001",
      "'@literal",
      "<img>&_x0041_",
      "А",
      "all",
      0,
      "000123",
    ],
  ]);
  const zip = readZip(bytes),
    xml = new TextDecoder().decode(await zip.read("xl/worksheets/sheet1.xml"));
  assert.match(xml, /&lt;img&gt;&amp;_x005F_x0041_/);
  assert.match(xml, /<t xml:space="preserve">000123<\/t>/);
  assert.doesNotMatch(xml, /<f[ >]/);
  assert.equal(zip.names.length, 5);
});
test("XLSX scope export is read-only and excludes common sessions when one subgroup is selected", async () => {
  const data = {
      subjects: [{ id: "001", name: "Предмет" }],
      rooms: [],
      teachers: [],
      groups: [{ id: "g", subgroups: ["А"] }],
      lessons: [
        {
          id: "id-keep",
          groupId: "g",
          subgroup: "А",
          day: 0,
          start: "08:00",
          end: "08:50",
          subjectId: "001",
          week: "all",
        },
        {
          id: "id-common",
          groupId: "g",
          subgroup: "all",
          day: 0,
          start: "09:00",
          end: "09:50",
        },
        {
          id: "id-other",
          groupId: "other",
          subgroup: "А",
          day: 0,
          start: "10:00",
          end: "10:50",
        },
      ],
    },
    before = structuredClone(data);
  const zip = readZip(
    exportScheduleXlsx(data, { groupId: "g", subgroup: "А" }),
  );
  const xml = new TextDecoder().decode(
    await zip.read("xl/worksheets/sheet1.xml"),
  );
  assert.match(xml, /id-keep/);
  assert.doesNotMatch(xml, /id-common|id-other/);
  assert.deepEqual(data, before);
  assert.throws(
    () => exportScheduleXlsx(data, { groupId: "missing" }),
    /выберите/,
  );
  assert.throws(
    () => scheduleWorkbook(Array.from({ length: 1001 }, () => [])),
    /1000/,
  );
  assert.throws(() => scheduleWorkbook([["\x01"]]), /управляющий/);
});
