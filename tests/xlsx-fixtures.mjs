import { deflateRawSync } from "node:zlib";
import { crc32, readZip } from "../app/manage/xlsx-zip.mjs";
import { scheduleWorkbook } from "../app/manage/xlsx.mjs";

// Independent compressed ZIP framing exercises the browser's native inflater.
export function compressedZip(parts, descriptor = false) {
  const local = [],
    central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(parts)) {
    const label = Buffer.from(name),
      bytes = Buffer.from(text),
      compressed = deflateRawSync(bytes),
      crc = crc32(bytes),
      flags = 0x800 | (descriptor ? 8 : 0);
    const header = Buffer.alloc(30),
      directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(label.length, 26);
    if (!descriptor) {
      header.writeUInt32LE(crc, 14);
      header.writeUInt32LE(compressed.length, 18);
      header.writeUInt32LE(bytes.length, 22);
    }
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(flags, 8);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(label.length, 28);
    directory.writeUInt32LE(offset, 42);
    const tail = Buffer.alloc(descriptor ? 16 : 0);
    if (descriptor) {
      tail.writeUInt32LE(0x08074b50);
      tail.writeUInt32LE(crc, 4);
      tail.writeUInt32LE(compressed.length, 8);
      tail.writeUInt32LE(bytes.length, 12);
    }
    local.push(header, label, compressed, tail);
    central.push(directory, label);
    offset += header.length + label.length + compressed.length + tail.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(parts).length, 8);
  end.writeUInt16LE(Object.keys(parts).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
export async function workbook(rows, change = () => {}, descriptor = false) {
  const zip = readZip(scheduleWorkbook(rows)),
    parts = {};
  for (const name of zip.names)
    parts[name] = new TextDecoder().decode(await zip.read(name));
  change(parts);
  return compressedZip(parts, descriptor);
}
export const xlsxRow = (day = 1, type = "Импорт XLSX", id = "") => [
  day,
  "09:00",
  "09:50",
  "math",
  "204",
  "teacher",
  type,
  "А",
  "all",
  0,
  id,
];
