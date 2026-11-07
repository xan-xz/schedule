import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname, sep, posix } from "node:path";
import { gzipSync } from "node:zlib";
import { validateCompatibility } from "../app/lib/compatibility-policy.mjs";

const args = process.argv.slice(2);
const value = (flag, fallback) =>
  args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const root = resolve(value("--root", "."));
const source = await stat(resolve(root, "app/index.html")).then(
  () => true,
  () => false,
);
const content = source ? resolve(root, "app") : root;
const config = JSON.parse(
  await readFile(resolve(root, "compatibility.json"), "utf8"),
);
if (!validateCompatibility(config))
  throw Error("Invalid compatibility manifest");
const port = Number(value("--port", "4173")),
  host = value("--host", "127.0.0.1");
const mime = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ics": "text/calendar; charset=utf-8",
};
const server = createServer(async (req, res) => {
  try {
    if (!["GET", "HEAD"].includes(req.method)) {
      res.writeHead(405).end();
      return;
    }
    const url = new URL(req.url, "http://localhost");
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/schedule") pathname = "/schedule/";
    const base = pathname.startsWith("/schedule/") ? "/schedule/" : "/";
    if (base !== "/") pathname = pathname.slice("/schedule".length);
    const relative = pathname.slice(1);
    if (source) {
      const old = [...config.legacyRoutes]
        .sort((a, b) => b.path.length - a.path.length)
        .find((route) => relative.startsWith(route.path));
      if (old?.worker && relative === old.path + "sw.js") {
        res.writeHead(200, {
          "Content-Type": mime[".js"],
          "Cache-Control": "no-store",
        });
        res.end(
          `importScripts(${JSON.stringify(posix.relative(old.path, "retirement-worker.js"))});`,
        );
        return;
      }
      if (old) {
        const target = new URL(old.target, "http://localhost" + base);
        target.search = url.search;
        for (const key of config.retiredQueryParams)
          target.searchParams.delete(key);
        res.writeHead(302, { Location: target.pathname + target.search });
        res.end();
        return;
      }
    }
    let file = resolve(content, "." + pathname);
    if (source && pathname === "/compatibility.json")
      file = resolve(root, "compatibility.json");
    else if (source && pathname === "/backend/core.mjs")
      file = resolve(root, "backend/core.mjs");
    else if (source && pathname === "/model.mjs")
      file = resolve(root, "backend/core.mjs");
    else if (file !== content && !file.startsWith(content + sep)) {
      res.writeHead(403).end();
      return;
    }
    if (
      pathname.split("/").some((part) => part.startsWith(".") && part !== "")
    ) {
      res.writeHead(403).end();
      return;
    }
    if ((await stat(file)).isDirectory()) file = resolve(file, "index.html");
    let body = await readFile(file);
    if (source && pathname === "/compatibility.json")
      body = Buffer.from(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(config).filter(([key]) => key !== "retirementGuard"),
          ),
        ),
      );
    const compress =
      /\bgzip\b/.test(req.headers["accept-encoding"] || "") &&
      /\.(html|m?js|css|json|webmanifest|svg)$/.test(file);
    if (compress) body = gzipSync(body);
    res.writeHead(200, {
      "Content-Type": mime[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      Vary: "Accept-Encoding",
      "Content-Length": body.length,
      ...(compress ? { "Content-Encoding": "gzip" } : {}),
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    if (req.headers.accept?.includes("text/html")) {
      try {
        const fallback = await readFile(resolve(content, "404.html"));
        res.writeHead(404, {
          "Content-Type": mime[".html"],
          "Cache-Control": "no-store",
        });
        res.end(fallback);
        return;
      } catch {
        /* No custom document in the modular development source. */
      }
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
});
server.listen(port, host, () =>
  console.log(
    `UniFlow local preview: http://${host}:${port}/schedule/ (${content})`,
  ),
);
process.on("SIGTERM", () => server.close());
process.on("SIGINT", () => server.close());
