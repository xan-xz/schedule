import { readFile, readdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const entry = "beta/index.html";
const seen = new Set();
let js = 0,
  css = 0;
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
  ].map((match) => match[1]);
  if (path.endsWith(".html"))
    specifiers.push(
      ...[
        ...code.matchAll(/(?:src|href)=["'](\.\/[^"']+\.(?:m?js|css))["']/g),
      ].map((match) => match[1]),
    );
  for (const specifier of specifiers) {
    const url = new URL(specifier, `file:///${path}`);
    await walk(url.pathname.slice(1));
  }
}
await walk(entry);
console.log(
  JSON.stringify(
    {
      initialJavaScriptGzip: js,
      cssGzip: css,
      budgets: { initialJavaScriptGzip: 60 * 1024, cssGzip: 15 * 1024 },
      measuredFiles: [...seen],
    },
    null,
    2,
  ),
);
if (js > 60 * 1024 || css > 15 * 1024) process.exitCode = 1;
// Verify no runtime package directory was accidentally copied to Pages.
try {
  if ((await readdir("dist")).includes("node_modules"))
    throw new Error("node_modules in public artifact");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
