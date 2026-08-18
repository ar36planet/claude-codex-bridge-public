import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

const roots = ["src", "scripts", "test"];
const files = [];

const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile() && entry.name.endsWith(".mjs")) files.push(relative(process.cwd(), path));
  }
};

for (const root of roots) {
  try { walk(root); } catch (error) { if (error?.code !== "ENOENT") throw error; }
}

for (const file of files.sort()) {
  const checked = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (checked.status !== 0) process.exit(checked.status ?? 1);
}

process.stdout.write(`syntax-ok: ${files.length} mjs files\n`);
