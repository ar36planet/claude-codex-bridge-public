// Resolve how to spawn `codex` as a child process.
//
// On Windows npm
// exposes codex as a `codex.cmd` shim, which child_process cannot run without a
// shell (and shell:true mangles quoted `-c` overrides). Run the shim's target —
// node_modules/@openai/codex/bin/codex.js — with our own node instead; that JS
// entry locates its vendored codex.exe itself, so it survives package-layout
// changes across codex versions.

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export function resolveCodex(bin = "codex") {
  if (process.platform !== "win32") return { command: bin, prefixArgs: [] };
  if (/\.exe$/i.test(bin)) return { command: bin, prefixArgs: [] };
  if (/\.(mjs|cjs|js)$/i.test(bin)) return { command: process.execPath, prefixArgs: [bin] };
  try {
    const shims = execSync(`where ${bin}`, { encoding: "utf8" })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((m) => /\.cmd$/i.test(m));
    for (const shim of shims) {
      const dir = dirname(shim);
      // A global npm prefix keeps packages in <prefix>\node_modules; a project's
      // node_modules\.bin shim points one level up instead.
      for (const js of [
        join(dir, "node_modules", "@openai", "codex", "bin", "codex.js"),
        join(dir, "..", "@openai", "codex", "bin", "codex.js"),
      ]) {
        if (existsSync(js)) return { command: process.execPath, prefixArgs: [js] };
      }
    }
  } catch {
    /* fall through — let spawn() surface the real error */
  }
  return { command: bin, prefixArgs: [] };
}
