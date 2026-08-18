// Start the shared `codex app-server` and print how to attach the TUI to it.
//
// Run this once, leave it running. Then attach the human-visible TUI with the
// printed `codex --remote ...` command, and Claude Code talks to the same
// endpoint via scripts/talk.mjs.
//
//   node scripts/serve.mjs [--cwd <dir>] [--port <n>]
//
// --cwd is the workspace Codex works in. A thread that does not name its own
// working directory inherits the app-server's, which is why running this script
// from the bridge's own folder used to leave the TUI rooted here instead of in
// the project you meant to work on.

import { spawn } from "node:child_process";
import { writeFileSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { resolveCodex } from "../src/resolveCodex.mjs";
import { STATE_FILE } from "../src/bridge.mjs";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};

const port = Number(flag("--port") ?? process.env.CODEX_BRIDGE_PORT ?? 8787);
const url = `ws://127.0.0.1:${port}`;
const statePath = fileURLToPath(STATE_FILE);

// Explicit flag beats the env var beats "wherever you launched this from".
const workdir = resolvePath(flag("--cwd") ?? process.env.CODEX_BRIDGE_CWD ?? process.cwd());
try {
  if (!statSync(workdir).isDirectory()) throw new Error("not a directory");
} catch (err) {
  console.error(`--cwd ${workdir}: ${err?.message ?? err}`);
  process.exit(2);
}

const { command, prefixArgs } = resolveCodex();
const server = spawn(command, [...prefixArgs, "app-server", "--listen", url], {
  cwd: workdir,
  stdio: ["ignore", "inherit", "inherit"],
  env: process.env,
});

// Loopback listeners need no auth; --ws-auth only applies to non-loopback.
writeFileSync(statePath, JSON.stringify({ url, pid: server.pid, cwd: workdir }, null, 2));

// Quote only when it matters, so the printed command can be pasted as-is on
// both a POSIX shell and PowerShell.
const quoted = /[\s'"]/.test(workdir) ? `"${workdir}"` : workdir;

console.log(`
  app-server : ${url}
  workspace  : ${workdir}
  state      : ${statePath}

  Attach the TUI you want to watch, in its own window:

      codex --remote ${url} -C ${quoted}

  (-C pins that window's workspace. Without it the thread inherits the
   workspace above, which is what --cwd sets.)

  Then, from Claude Code:

      node scripts/talk.mjs list
      node scripts/talk.mjs say "your message"
`);

const cleanup = () => {
  try { rmSync(statePath, { force: true }); } catch {}
  try { server.kill(); } catch {}
};
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("exit", cleanup);
server.on("exit", (code) => { cleanup(); process.exit(code ?? 0); });
