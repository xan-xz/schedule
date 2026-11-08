import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const result = await build({
  stdin: {
    contents: 'export { DOMParser } from "@xmldom/xmldom";',
    resolveDir: process.cwd(),
    sourcefile: "xlsx-xml-entry.mjs",
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  minify: true,
  legalComments: "eof",
  write: false,
  plugins: [
    {
      name: "xml-only",
      setup(builder) {
        builder.onLoad(
          { filter: /[\\/]@xmldom[\\/]xmldom[\\/]lib[\\/]entities\.js$/ },
          async ({ path }) => {
            const source = await readFile(path, "utf8");
            const xml = source.match(
              /^[\s\S]*?exports\.XML_ENTITIES = freeze\(\{[\s\S]*?\}\);/,
            )?.[0];
            if (!xml) throw Error("Locked XML entity source changed");
            return { contents: xml, loader: "js" };
          },
        );
        builder.onLoad(
          { filter: /[\\/]@xmldom[\\/]xmldom[\\/]lib[\\/]dom-parser\.js$/ },
          async ({ path }) => {
            const source = await readFile(path, "utf8"),
              marker = "entityMap = entities.HTML_ENTITIES;";
            if (source.split(marker).length !== 2)
              throw Error("Locked XML parser source changed");
            return {
              contents: source.replace(
                marker,
                'throw new TypeError("HTML parsing is unavailable in the XLSX XML reader");',
              ),
              loader: "js",
            };
          },
        );
      },
    },
  ],
});
const path = "app/admin/vendor/xmldom-0.9.12.mjs",
  bytes = result.outputFiles[0].contents;
if (process.argv.includes("--write")) await writeFile(path, bytes);
else if (!Buffer.from(bytes).equals(await readFile(path)))
  throw Error(
    "XLSX XML vendor does not match the locked source. Run node scripts/xlsx-vendor.mjs --write.",
  );
console.log(
  `XLSX XML vendor ${bytes.length} bytes SHA-256 ${createHash("sha256").update(bytes).digest("hex")}`,
);
