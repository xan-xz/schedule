import { readFile, readdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";
const entry = process.argv[2] || "dist/index.html",
  seen = new Set();
let js = 0,
  css = 0;
const entryHtml = await readFile(entry, "utf8");
const initialDocumentGzip = gzipSync(entryHtml).length;
const initialData = [
  ...entryHtml.matchAll(
    /<script\b(?=[^>]*\btype=["']application\/json["'])[^>]*>([\s\S]*?)<\/script>/gi,
  ),
]
  .map((match) => match[1])
  .join("");
async function walk(path) {
  if (seen.has(path)) return;
  seen.add(path);
  const code = await readFile(path, "utf8");
  if (/\.m?js$/.test(path)) js += gzipSync(code).length;
  if (/\.css$/.test(path)) css += gzipSync(code).length;
  const specifiers = [
    ...code.matchAll(
      /(?:import\s+(?:[^'";]+?\s+from\s+)?|export\s+[^'";]+?\s+from\s+)["'](\.[^"']+)["']/g,
    ),
  ].map((m) => m[1]);
  if (path.endsWith(".html")) {
    for (const match of code.matchAll(
      /<script\b([^>]*)>([\s\S]*?)<\/script>/gi,
    ))
      if (
        !/\bsrc\s*=/.test(match[1]) &&
        (!/\btype\s*=/.test(match[1]) ||
          /\btype\s*=\s*["'](?:module|text\/javascript|application\/javascript)["']/.test(
            match[1],
          ))
      )
        js += gzipSync(match[2]).length;
    for (const match of code.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi))
      css += gzipSync(match[1]).length;
    specifiers.push(
      ...[
        ...code.matchAll(/(?:src|href)=["'](\.\/[^"']+\.(?:m?js|css))["']/g),
      ].map((m) => m[1]),
    );
  }
  for (const ref of specifiers) {
    const url = new URL(ref, `file:///${path}`);
    await walk(url.pathname.slice(1));
  }
}
await walk(entry);
console.log(
  JSON.stringify(
    {
      entry,
      initialJavaScriptGzip: js,
      cssGzip: css,
      initialDataBytes: Buffer.byteLength(initialData),
      initialDataGzip: initialData ? gzipSync(initialData).length : 0,
      initialDocumentGzip,
      budgets: {
        initialJavaScriptGzip: 60 * 1024,
        cssGzip: 15 * 1024,
        initialDocumentGzip: 60 * 1024,
      },
      measuredFiles: [...seen],
    },
    null,
    2,
  ),
);
if (js > 60 * 1024 || css > 15 * 1024 || initialDocumentGzip > 60 * 1024)
  process.exitCode = 1;
if ((await readdir("dist")).includes("node_modules"))
  throw Error("node_modules in public artifact");
