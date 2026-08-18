// CLI for talking to the live Codex thread the human is watching.
//
//   node scripts/talk.mjs list
//   node scripts/talk.mjs read [threadId]
//   node scripts/talk.mjs say [--thread <id>] [--cwd <dir>] [--approvals <mode>] "message"
//
// --approvals decides who answers when Codex asks permission to run something:
//   tui      (default) stay silent so the human's TUI prompt decides
//   decline  refuse immediately — for when no TUI is attached
//   accept   allow everything — only for a workspace you already trust

import { connect, describeThreads, resolveThread, say, read } from "../src/bridge.mjs";

const argv = process.argv.slice(2);
const cmd = argv.shift();

const take = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value;
};

const threadId = take("--thread");
const cwd = take("--cwd");
const approvals = take("--approvals") ?? undefined;

const main = async () => {
  const client = await connect({
    ...(approvals ? { approvals } : {}),
    log: (m) => process.stderr.write(`[bridge] ${m}\n`),
  });
  try {
    if (cmd === "list") {
      const threads = await describeThreads(client);
      if (!threads.length) {
        console.log("(no live threads)");
        return;
      }
      // cwd is the useful discriminator when several sessions are open.
      for (const t of threads) {
        const where = t.cwd ?? (t.error ? `(cwd unavailable: ${t.error})` : "(cwd unknown)");
        console.log(`${t.id}  ${where}${t.name ? `  ${t.name}` : ""}`);
      }
      return;
    }
    if (cmd === "read") {
      const id = await resolveThread(client, threadId ?? argv[0] ?? null);
      console.log(JSON.stringify(await read(client, id), null, 2));
      return;
    }
    if (cmd === "say") {
      const text = argv.join(" ").trim();
      if (!text) throw new Error("nothing to say");
      const id = await resolveThread(client, threadId);
      // Stream deltas so a long reply is visible here as it is in the TUI.
      const { reply } = await say(client, {
        threadId: id,
        text,
        cwd,
        onDelta: (d) => process.stderr.write(d),
      });
      process.stderr.write("\n");
      console.log(reply);
      return;
    }
    console.error(
      'usage: talk.mjs list | read [threadId] | say [--thread <id>] [--cwd <dir>] [--approvals tui|decline|accept] "message"',
    );
    process.exitCode = 2;
  } finally {
    client.close();
  }
};

main().catch((err) => {
  console.error(`error: ${err?.message ?? err}`);
  process.exit(1);
});
