# Setup

_中文：[SETUP.md](SETUP.md) · For the design rationale and what has been verified, see [README.md](README.md) (Chinese)_

This document only covers getting it running. What "running" looks like: you have
a Codex TUI window open, and messages Claude Code sends appear directly in it.

---

## 1. What you need

| | |
|---|---|
| **Node.js `>=22`** | v24 LTS recommended |
| **Codex CLI** | Verified against `0.147.0`. Check `codex --version`, and make sure `codex login` is done |
| **Claude Code** | The side that does the talking |

The `codex app-server` protocol is marked `[experimental]` inside Codex, so it can
drift between releases. If something behaves oddly, check `codex --version` first.

<details>
<summary>macOS: node and codex often end up on different versions</summary>

`codex` is frequently installed as a global package under one nvm version, and
that version may be older than 22 — which then becomes your default `node`.
Keeping both on the same LTS is the simplest fix:

```bash
nvm install 24 && nvm alias default 24
nvm reinstall-packages 20        # move codex and friends over (20 = your old version)
```

The `codex` executable is a `#!/usr/bin/env node` shim, so it follows whatever
node is on `PATH` — it is not pinned to the version it was installed under.

</details>

## 2. Get the project

```bash
git clone https://github.com/ar36planet/claude-codex-bridge-public.git
cd claude-codex-bridge-public
npm install
```

Confirm the install:

```bash
npm test        # 21 tests; no model calls, no network
```

## 3. Minimum working setup (three windows)

### Window 1 — the shared server (leave it running)

```bash
node scripts/serve.mjs --cwd /path/to/your-project
```

`--cwd` is **the directory Codex actually works in**. Without it, threads inherit
wherever you launched the script — which is this repo's own folder, and usually
not what you want.

The port defaults to 8787; change it with `--port` or `CODEX_BRIDGE_PORT`. The
endpoint is written to `.bridge.json`, which the other commands read themselves.

### Window 2 — the Codex TUI you will be watching

```bash
codex --remote ws://127.0.0.1:8787
```

**Once it attaches, type something in the TUI yourself and let it finish.**

Do not skip this. A thread cannot be joined by the bridge until its first turn has
*completed*. Before that, `talk.mjs list` **already shows the thread** — but
anything you send gets no reply back and simply times out. Seeing it in `list`
does not mean you can talk to it.

To point this window at a different project, add `-C /path/to/other-project`.
Without it, the thread follows window 1's `--cwd` — **regardless of which
directory you typed this command in**.

### Window 3 — the Claude Code side

```bash
node scripts/talk.mjs list                         # live threads, each with its cwd
node scripts/talk.mjs say "Reply with one word: OK" # you will see this land in window 2
node scripts/talk.mjs read                         # full thread as structured JSON
```

Success looks like: the message renders in the TUI, Codex answers, and the answer
streams back into window 3.

With more than one TUI open, pass `--thread <id>` — it will not guess which
session you meant. The cwd printed by `list` is how you tell them apart.

## 4. (Optional) Install as an MCP server

The CLI is enough on its own. MCP exposes the same capabilities as structured
tools, so Claude Code or Codex can decide for itself when to speak.

**Install only the direction you need:**

| What you want | Install |
|---|---|
| Claude Code speaking to Codex | `--role claude` (in Claude Code) |
| Codex leaving messages for Claude Code | `--role codex` (in Codex) |
| Both | Both |

```bash
# Claude Code side
claude mcp add --scope project claude-codex-bridge -- \
  node /path/to/claude-codex-bridge/scripts/mcp.mjs --role claude

# Codex side
codex mcp add claude-codex-bridge -- \
  node /path/to/claude-codex-bridge/scripts/mcp.mjs --role codex
```

Three things to know:

1. **Use an absolute path, but the working directory does not matter.** All state
   is resolved from the module's own location, not from cwd — so one installation
   covers every project.
2. **Restart afterwards.** `mcp add` only edits a config file; a session that is
   already running will not pick up the new MCP server.
3. **MCP is not the transport.** It still needs the server from window 1 and the
   TUI from window 2.

On the Codex side, add this to `~/.codex/config.toml`:

```toml
[mcp_servers.claude-codex-bridge]
tool_timeout_sec = 360                    # codex_message_send waits for a whole turn
default_tools_approval_mode = "writes"
```

To confirm: after restarting, call `bridge_status` — `ok: true` with the right
`role` means you are set.

## 5. (Optional) The reverse direction: Codex → Claude Code

Claude Code exposes no socket to push into, so this uses a **Stop hook plus a
named mailbox**: the hook runs just before Claude finishes, and hands whatever is
in the mailbox back as new input.

This repo's `.claude/settings.json` already wires it up (mailbox name `bridge`).
To let *another* project receive messages, add this to that project's
`.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{ "matcher": "*", "hooks": [{
      "type": "command",
      "command": "node \"/path/to/claude-codex-bridge/scripts/inbox.mjs\" hook --as your-mailbox-name"
    }]}]
  }
}
```

**Do not use `$CLAUDE_PROJECT_DIR` in that command** — it points at that project,
not at this bridge.

Leaving and inspecting messages:

```bash
node scripts/inbox.mjs push --to your-mailbox-name "while you're in there, check the auth bit"
node scripts/inbox.mjs list                    # who is listening, and from where
node scripts/inbox.mjs peek --as your-mailbox-name   # look without consuming
```

Mailboxes are named because several Claude Code sessions may be listening at once;
sharing one file would let whoever finishes first swallow everyone else's mail.

## 6. When something goes wrong

| Symptom | Cause and fix |
|---|---|
| `no rollout found for thread id` | The TUI attached but never took a turn of its own. Go to window 2, send a message, let it finish |
| Sent fine, then timed out | Same cause. The message *did* arrive and Codex *did* answer — the bridge just never joined the thread, so it heard nothing |
| `no app-server endpoint` | `serve.mjs` is not running, or `.bridge.json` is gone. You can also set `CODEX_BRIDGE_URL` directly |
| `AMBIGUOUS_THREAD` | More than one thread is live. Pass `--thread <id>`; `list` prints each thread's cwd to tell them apart |
| `(no live threads)` | No TUI attached yet, or it attached to a different port |
| Port already in use | Pick another with `--port`, on both sides |
| Codex edits files but the TUI never prompts for approval | See below |

### About approvals

By default, when Codex wants to run a command or change a file it raises an
approval request, and the app-server **broadcasts it to every attached client** —
first answer wins. This bridge deliberately stays silent, so the decision belongs
to **the prompt in the TUI in front of you**. If nobody answers, it fail-closes on
a timeout rather than wedging the turn forever.

But two user-level settings intercept the request **before** it reaches any
client, and then your TUI never prompts at all:

| Setting | Location |
|---|---|
| A `PermissionRequest` hook | `~/.codex/hooks.json` |
| `approvals_reviewer = "auto_review"` | `~/.codex/config.toml` |

Both are legitimate personal choices and this project does not touch them. Just
know that while they are on, **the one deciding is not you**.

When there is no TUI to ask, refuse explicitly:

```bash
node scripts/talk.mjs say --approvals decline "..."
```
