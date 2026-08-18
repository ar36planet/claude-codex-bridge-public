// CLI for the Codex -> Claude Code mailbox.
//
//   node scripts/inbox.mjs push [--to <name>] "message"   # leave a message
//   node scripts/inbox.mjs push [--to <name>]             # ...or pipe on stdin
//   node scripts/inbox.mjs list                           # who is listening
//   node scripts/inbox.mjs peek  [--as <name>]            # look without consuming
//   node scripts/inbox.mjs drain [--as <name>]            # consume
//   node scripts/inbox.mjs hook  [--as <name>]            # Stop-hook mode
//
// Mailboxes are named so several Claude Code sessions can listen at once:
// `--to` picks who a message is FOR, `--as` picks who is READING. Both default
// to $CODEX_BRIDGE_MAILBOX, then "default".
//
// `hook` is the mode wired into .claude/settings.json. It reads the hook payload
// on stdin and, when its mailbox has anything in it, answers with
// `{"decision": "block", "reason": ...}` — which tells Claude Code not to stop
// and to treat `reason` as its next input.

import {
  push, peek, drain, announce, listMailboxes, formatForClaude, mailboxPath, mailboxName,
} from "../src/inbox.mjs";

const argv = process.argv.slice(2);
const cmd = argv.shift();

const take = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value;
};

const to = take("--to");
const as = take("--as");

const readStdin = async () => {
  if (process.stdin.isTTY) return "";
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
};

const main = async () => {
  if (cmd === "push") {
    const text = argv.join(" ").trim() || (await readStdin()).trim();
    const from = process.env.CODEX_BRIDGE_FROM ?? "codex";
    const message = push({ text, from, to });
    console.log(`queued ${message.id} for "${message.to}" (${mailboxPath(to)})`);
    return;
  }

  if (cmd === "list") {
    const boxes = listMailboxes();
    if (!boxes.length) {
      console.log("(no mailboxes yet — a session registers itself the first time its Stop hook runs)");
      return;
    }
    for (const b of boxes) {
      const where = b.cwd ? `  ${b.cwd}` : "";
      const seen = b.lastSeen ? `  last seen ${b.lastSeen}` : "  (never announced)";
      console.log(`${b.name}  pending=${b.pending}${where}${seen}`);
    }
    return;
  }

  if (cmd === "peek" || cmd === "drain") {
    const messages = cmd === "peek" ? peek(as) : drain(as);
    console.log(messages.length ? formatForClaude(messages) : `(mailbox "${mailboxName(as)}" empty)`);
    return;
  }

  if (cmd === "hook") {
    let payload = {};
    try {
      payload = JSON.parse((await readStdin()) || "{}");
    } catch {
      /* an unreadable payload is not a reason to wedge the session */
    }

    // Register on every run, so `list` can show which sessions are real and
    // where they are working — a sender has no other way to learn the names.
    try {
      announce(as, { cwd: payload?.cwd || process.cwd() });
    } catch {
      /* the registry is a convenience; never let it block delivery */
    }

    // A Stop hook that blocks re-runs the stop sequence, so a hook that blocked
    // every time would loop forever. Claude Code flags the second pass with
    // stop_hook_active; on that pass, let the turn end — and leave the mail
    // where it is, so the next stop still delivers it.
    if (payload?.stop_hook_active) return;

    const messages = drain(as);
    if (!messages.length) return; // silence = "nothing to say, go ahead and stop"

    process.stdout.write(JSON.stringify({
      decision: "block",
      reason: formatForClaude(messages),
    }));
    return;
  }

  console.error('usage: inbox.mjs push [--to <name>] "message" | list | peek [--as <name>] '
    + "| drain [--as <name>] | hook [--as <name>]");
  process.exitCode = 2;
};

main().catch((err) => {
  console.error(`error: ${err?.message ?? err}`);
  // Never fail the hook: a broken mailbox must not be able to block a turn.
  process.exit(cmd === "hook" ? 0 : 1);
});
