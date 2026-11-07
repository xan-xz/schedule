import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { build, transform } from "esbuild";

const cspHash = (content) =>
  `'sha256-${createHash("sha256").update(content, "utf8").digest("base64")}'`;
/** Only trusted, build-generated code is inlined; user/snapshot data is never HTML. */
export async function optimizeEntry(directory) {
  const path = resolve(directory, "index.html");
  let html = await readFile(path, "utf8");
  const script =
    /<script\b(?=[^>]*\btype=["']module["'])(?=[^>]*\bsrc=["']\.\/app\.mjs["'])[^>]*>\s*<\/script>/i;
  if (!script.test(html)) return false;
  const sheet =
    /<link\b(?=[^>]*\brel=["']stylesheet["'])(?=[^>]*\bhref=["']\.\/styles\.css["'])[^>]*>/i;
  if (
    !sheet.test(html) ||
    !html.includes("script-src 'self';") ||
    !html.includes("style-src 'self';")
  )
    throw Error(
      "Cannot safely optimize entry: expected strict CSP and local stylesheet",
    );
  const js = (
    await build({
      entryPoints: [resolve(directory, "app.mjs")],
      bundle: true,
      write: false,
      minify: true,
      charset: "utf8",
      format: "esm",
      target: "es2022",
      legalComments: "none",
    })
  ).outputFiles[0].text;
  const css = (
    await transform(await readFile(resolve(directory, "styles.css"), "utf8"), {
      loader: "css",
      minify: true,
      charset: "utf8",
      legalComments: "none",
    })
  ).code;
  if (/<\/script/i.test(js) || /<\/style/i.test(css))
    throw Error("Unsafe closing tag in inline build content");
  html = html
    .replace(script, () => `<script type="module">${js}</script>`)
    .replace(sheet, () => `<style>${css}</style>`)
    .replace(/<link\b(?=[^>]*\brel=["']modulepreload["'])[^>]*>/gi, "")
    .replace("script-src 'self';", `script-src 'self' ${cspHash(js)};`)
    .replace("style-src 'self';", `style-src 'self' ${cspHash(css)};`);
  // Existing worker asset URLs remain available, but no longer block first paint.
  await writeFile(resolve(directory, "app.mjs"), js);
  await writeFile(resolve(directory, "styles.css"), css);
  await writeFile(path, html);
  return { scriptHash: cspHash(js), styleHash: cspHash(css) };
}
