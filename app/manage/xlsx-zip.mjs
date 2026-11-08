// A bounded, in-memory subset of ZIP for OOXML. No paths are extracted to disk.
const utf8 = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const fail = () => {
  throw Error("XLSX: повреждённый или неподдерживаемый ZIP-контейнер.");
};
const table = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function safeName(name) {
  return (
    name.length > 0 &&
    name.length < 240 &&
    !/[\\:%?#]/.test(name) &&
    ![...name].some((c) => c.charCodeAt(0) <= 32) &&
    !name.startsWith("/") &&
    name
      .replace(/\/$/, "")
      .split("/")
      .every((p) => p && p !== "." && p !== "..")
  );
}
export function readZip(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length > 1_000_000)
    throw Error("Размер XLSX не должен превышать 1 МБ.");
  if (bytes.length < 22) fail();
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (p) => v.getUint16(p, true),
    u32 = (p) => v.getUint32(p, true);
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--)
    if (u32(p) === 0x06054b50 && p + 22 + u16(p + 20) === bytes.length) {
      end = p;
      break;
    }
  if (end < 0 || u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10))
    fail();
  const count = u16(end + 10),
    start = u32(end + 16);
  if (!count || count > 128 || start + u32(end + 12) !== end) fail();
  const entries = new Map(),
    spans = [];
  let p = start,
    total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || u32(p) !== 0x02014b50) fail();
    const flags = u16(p + 8),
      method = u16(p + 10),
      crc = u32(p + 16),
      size = u32(p + 20),
      original = u32(p + 24),
      nameSize = u16(p + 28),
      next = p + 46 + nameSize + u16(p + 30) + u16(p + 32),
      local = u32(p + 42);
    if (
      next > end ||
      u16(p + 34) ||
      flags & ~0x080e ||
      ![0, 8].includes(method) ||
      (!method && flags & 6) ||
      original > 2_000_000 ||
      (total += original) > 8_000_000
    )
      fail();
    let name;
    try {
      name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameSize));
    } catch {
      fail();
    }
    if (
      !safeName(name) ||
      entries.has(name) ||
      local + 30 > start ||
      u32(local) !== 0x04034b50 ||
      u16(local + 6) !== flags ||
      u16(local + 8) !== method ||
      u16(local + 26) !== nameSize
    )
      fail();
    const offset = local + 30 + nameSize + u16(local + 28);
    if (
      offset + size > start ||
      !bytes
        .subarray(p + 46, p + 46 + nameSize)
        .every((byte, index) => byte === bytes[local + 30 + index])
    )
      fail();
    let last = offset + size;
    if (flags & 8) {
      if (last + 12 > start) fail();
      if (u32(last) === 0x08074b50) last += 4;
      if (
        last + 12 > start ||
        u32(last) !== crc ||
        u32(last + 4) !== size ||
        u32(last + 8) !== original
      )
        fail();
      last += 12;
    } else if (
      u32(local + 14) !== crc ||
      u32(local + 18) !== size ||
      u32(local + 22) !== original
    )
      fail();
    if (method === 0 && size !== original) fail();
    spans.push([local, last]);
    entries.set(name, { offset, size, original, method, crc });
    p = next;
  }
  spans.sort((a, b) => a[0] - b[0]);
  if (
    p !== end ||
    spans[0][0] !== 0 ||
    spans.at(-1)[1] !== start ||
    spans.some((s, i) => i && s[0] !== spans[i - 1][1])
  )
    fail();
  return {
    names: [...entries.keys()],
    async read(name) {
      const entry = entries.get(name);
      if (!entry) throw Error(`XLSX: отсутствует часть ${name}.`);
      const compressed = bytes.subarray(
        entry.offset,
        entry.offset + entry.size,
      );
      let output = compressed;
      if (entry.method === 8) {
        if (typeof globalThis.DecompressionStream !== "function")
          throw Error(
            "Для XLSX нужен современный браузер с поддержкой распаковки ZIP.",
          );
        let reader;
        try {
          reader = new Blob([compressed])
            .stream()
            .pipeThrough(new globalThis.DecompressionStream("deflate-raw"))
            .getReader();
          const chunks = [];
          let length = 0;
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            length += value.length;
            if (length > entry.original || length > 2_000_000) {
              await reader.cancel();
              fail();
            }
            chunks.push(value);
          }
          output = new Uint8Array(length);
          let at = 0;
          for (const chunk of chunks) {
            output.set(chunk, at);
            at += chunk.length;
          }
        } catch {
          throw Error(
            "XLSX: не удалось безопасно распаковать часть ZIP. Используйте актуальный браузер и обычный файл .xlsx.",
          );
        } finally {
          reader?.releaseLock();
        }
      }
      if (output.length !== entry.original || crc32(output) !== entry.crc)
        fail();
      return output;
    },
  };
}

/** Stored ZIP is sufficient for small, text-only Excel exports and templates. */
export function storeZip(parts) {
  const records = Object.entries(parts).map(([name, text]) => {
    if (!safeName(name)) fail();
    const label = encoder.encode(name),
      bytes = encoder.encode(text);
    return { label, bytes, crc: crc32(bytes) };
  });
  const localSize = records.reduce(
    (n, r) => n + 30 + r.label.length + r.bytes.length,
    0,
  );
  const output = new Uint8Array(
    localSize + records.reduce((n, r) => n + 46 + r.label.length, 22),
  );
  const view = new DataView(output.buffer);
  const set16 = (p, v) => view.setUint16(p, v, true),
    set32 = (p, v) => view.setUint32(p, v, true);
  let local = 0,
    central = localSize;
  for (const r of records) {
    set32(local, 0x04034b50);
    set16(local + 4, 20);
    set16(local + 6, 0x800);
    set16(local + 12, 33); // 1980-01-01, the first valid DOS date.
    set32(local + 14, r.crc);
    set32(local + 18, r.bytes.length);
    set32(local + 22, r.bytes.length);
    set16(local + 26, r.label.length);
    output.set(r.label, local + 30);
    output.set(r.bytes, local + 30 + r.label.length);
    set32(central, 0x02014b50);
    set16(central + 4, 20);
    set16(central + 6, 20);
    set16(central + 8, 0x800);
    set16(central + 14, 33);
    set32(central + 16, r.crc);
    set32(central + 20, r.bytes.length);
    set32(central + 24, r.bytes.length);
    set16(central + 28, r.label.length);
    set32(central + 42, local);
    output.set(r.label, central + 46);
    local += 30 + r.label.length + r.bytes.length;
    central += 46 + r.label.length;
  }
  set32(central, 0x06054b50);
  set16(central + 8, records.length);
  set16(central + 10, records.length);
  set32(central + 12, central - localSize);
  set32(central + 16, localSize);
  return output;
}
