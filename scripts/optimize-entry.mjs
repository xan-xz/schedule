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
  const earlyTag = /<script src="\.\/appearance-init\.js"><\/script>/;
  let early = "";
  if (earlyTag.test(html)) {
    early = (
      await transform(
        await readFile(resolve(directory, "appearance-init.js"), "utf8"),
        {
          loader: "js",
          minify: true,
          target: "es2022",
          legalComments: "none",
        },
      )
    ).code;
    if (/<\/script/i.test(early)) throw Error("Unsafe appearance bootstrap");
  }
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
  // A fresh visitor can already use the real chooser. Let it paint before
  // fetching the larger application. Returning/invited/background tabs start
  // immediately; no timer or artificial delay is used.
  const loader = (
    await transform(
      `
    let returning = false;
    try { returning = Boolean(localStorage.getItem("uf.student.choice.v1")); } catch {}
    const query = new URLSearchParams(location.search);
    if (!document.hidden && !returning && !query.has("g") && !query.has("group") && document.querySelector("[data-initial-choice]"))
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    void import("./app.mjs").catch(() => {
      const form = document.querySelector("[data-initial-choice]");
      if (!form) return;
      form.dataset.choiceGuard = "native";
      form.querySelector('[type="submit"]').disabled = !form.querySelector('[name="g"]').value;
      form.querySelector(".form-error").textContent = "Не удалось загрузить приложение. Выбери группу и отправь форму, чтобы повторить.";
    });
  `,
      { minify: true, target: "es2022", format: "esm", legalComments: "none" },
    )
  ).code;
  if (/<\/script/i.test(js) || /<\/style/i.test(css))
    throw Error("Unsafe closing tag in inline build content");
  html = html
    .replace(earlyTag, () => `<script>${early}</script>`)
    .replace(script, () => `<script type="module">${loader}</script>`)
    .replace(sheet, () => `<style>${css}</style>`)
    .replace(/<link\b(?=[^>]*\brel=["']modulepreload["'])[^>]*>/gi, "")
    .replace(
      "script-src 'self';",
      `script-src 'self'${early ? " " + cspHash(early) : ""} ${cspHash(loader)};`,
    )
    .replace("style-src 'self';", `style-src 'self' ${cspHash(css)};`);
  // Existing worker asset URLs remain available, but no longer block first paint.
  await writeFile(resolve(directory, "app.mjs"), js);
  await writeFile(resolve(directory, "styles.css"), css);
  await writeFile(path, html);
  return { scriptHash: cspHash(js), styleHash: cspHash(css) };
}
