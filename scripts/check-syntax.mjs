import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";

async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? files(`${dir}/${entry.name}`)
          : /\.m?js$/.test(entry.name)
            ? [`${dir}/${entry.name}`]
            : [],
      ),
    )
  ).flat();
}
for (const path of (
  await Promise.all(["app", "backend", "scripts", "tests"].map(files))
).flat()) {
  const result = spawnSync(process.execPath, ["--check", path], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.error(result.stderr);
    process.exit(1);
  }
}
console.log("All JavaScript modules parse successfully.");
