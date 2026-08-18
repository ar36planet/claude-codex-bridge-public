// Shared plumbing for the spikes: pick a free port, start a private
// app-server on it, wait for it, and keep score.
//
// Each spike gets its own server on an ephemeral port so they never collide
// with the long-running one from scripts/serve.mjs, and never touch the thread
// a human is watching.

import { spawn } from "node:child_process";
import { createServer, Socket } from "node:net";
import { realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { resolveCodex } from "../src/resolveCodex.mjs";

export const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

export const waitForListen = async (port, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const s = new Socket();
      s.setTimeout(500);
      s.once("connect", () => { s.destroy(); resolve(true); });
      s.once("error", () => { s.destroy(); resolve(false); });
      s.once("timeout", () => { s.destroy(); resolve(false); });
      s.connect(port, "127.0.0.1");
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

/**
 * Start an app-server on a fresh port; resolves once it is accepting sockets.
 * `extraArgs` goes to the codex CLI, which is how a spike neutralises whatever
 * the user's ~/.codex config happens to say (see spike-approvals).
 */
export async function startAppServer({ cwd = process.cwd(), quiet = false, extraArgs = [] } = {}) {
  const port = await freePort();
  const url = `ws://127.0.0.1:${port}`;
  const { command, prefixArgs } = resolveCodex();
  const server = spawn(command, [...prefixArgs, "app-server", "--listen", url, ...extraArgs], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  server.stdout.setEncoding("utf8");
  server.stderr.setEncoding("utf8");

  // Kept so a spike can tell "the thing I was testing failed" apart from "this
  // machine cannot run sandboxed commands at all".
  let stderr = "";
  server.stderr.on("data", (d) => { stderr += d; });
  if (!quiet) {
    server.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
    server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));
  }

  const stop = () => { try { server.kill(); } catch {} };
  process.on("exit", stop);
  process.on("SIGINT", () => { stop(); process.exit(130); });

  if (!(await waitForListen(port))) {
    stop();
    throw new Error("app-server never listened");
  }
  return {
    url, port, server, stop, cwd,
    /** True once the OS sandbox has proven unusable — no command can run. */
    sandboxUnavailable: () => /sandbox helper|launch setup helper|sandbox failed/i.test(stderr),
  };
}

/** Scoreboard: `record()` as you go, `report()` exits with the right code. */
export function scoreboard() {
  const results = [];
  const record = (name, pass, detail) => {
    results.push({ name, pass, detail });
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };
  /** For a check this machine cannot run: not a pass, but not a defect either. */
  const skip = (name, why) => {
    results.push({ name, skipped: true, detail: why });
    console.log(`SKIP  ${name} — ${why}`);
  };
  const report = () => {
    const ran = results.filter((r) => !r.skipped);
    const failed = ran.filter((r) => !r.pass);
    const skipped = results.length - ran.length;
    console.log(`\n=== ${ran.length - failed.length}/${ran.length} checks passed`
      + `${skipped ? `, ${skipped} skipped` : ""} ===`);
    process.exit(failed.length ? 1 : 0);
  };
  return { record, skip, report, results };
}

/**
 * Compare paths by what they actually point at: macOS hands back
 * /private/var where we passed /var, and Windows is case-insensitive.
 */
export const samePath = (a, b) => {
  if (!a || !b) return false;
  const norm = (p) => {
    try { return realpathSync(resolvePath(p)); } catch { return resolvePath(p); }
  };
  const [x, y] = [norm(a), norm(b)];
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
};
