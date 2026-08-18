# claude-codex-bridge

_中文：[README.md](README.md) · **Just want it running? → [SETUP.en.md](SETUP.en.md)**_

Let **Claude Code** talk to **the Codex TUI you are actually looking at** — while
you watch it happen. And let Codex put a message back into the Claude Code
session you have running.

Not screen scraping, not file polling, not a headless subagent. Both ends attach
to **the same thread** on one `codex app-server`: whatever Claude Code sends is
rendered live in the TUI in front of you.

Verified against codex-cli `0.147.0` on **both Windows 11 and macOS 26**, on
**Node 24 LTS**. Nothing is platform-bound — paths always go through `node:path`,
and `resolveCodex()` special-cases Windows only. Per-platform results are in
[Verified / not verified](#verified--not-verified).

Node `>=22` is required (`engines` in `package.json`); v24 LTS is the recommended
line.

<details>
<summary>Two tests get cancelled on Node 20 (not a bug)</summary>

Under Node 20, `node --test` decides the event loop has already resolved when the
only pending work is a deliberately `unref()`'d timeout — the ones in
`src/bridge.mjs` and `src/mcp/threadQueue.mjs` — and cancels two tests:

```
#4  say times out with started turn metadata and cleans listeners
#20 a timed-out queue waiter cannot let later work pass an active turn
```

Those `unref()` calls are correct: a pending timeout should not hold the MCP
server or CLI process open. Node 22+ keeps a handle alive for the running test,
so the timer still fires. The program itself runs fine on Node 20 — the inbox
hook is used there in practice.

**Why macOS hits this easily:** `codex` is often a global package under some nvm
version, and that version may be Node 20, which then becomes your default `node`.
The cleanest fix is putting node and codex on the same LTS:

```bash
nvm install 24 && nvm alias default 24
nvm reinstall-packages 20        # move codex and friends across
```

(`codex`'s bin is a `#!/usr/bin/env node` shim — it follows whatever node is on
`PATH`, not the version it was installed under.)

</details>

## Architecture

```
        ┌──────────────────────────────┐
        │  codex app-server            │   ← where the thread actually lives
        │  --listen ws://127.0.0.1:8787│
        └───────┬──────────────┬───────┘
                │              │
   codex --remote ws://…       │  JSON-RPC over ws
                │              │
        ┌───────┴──────┐  ┌────┴─────────────┐
        │  Codex TUI   │  │  Claude Code     │
        │ (you watch)  │  │ (scripts/talk)   │
        └──────┬───────┘  └────┬─────────────┘
               │               ▲
               └───────────────┘
        .bridge-inbox/<name>.jsonl → Stop hook
             (reverse: Codex → Claude Code)
```

The forward direction hinges on what `thread/resume` means:

> *If thread_id identifies a running thread, app-server **rejoins** that thread.*

So the second client is not opening a new conversation, and not replaying a
transcript — it **joins the same running thread**. Only after joining does it
receive that thread's notification stream; connecting to the endpoint is not
enough.

## Usage

Three windows.

**1. The shared server** (leave it running)

```bash
node scripts/serve.mjs --cwd /path/to/your-project
```

`--cwd` is **the directory Codex actually works in**. A thread that does not name
its own cwd inherits the app-server's, so without this flag it stays wherever you
launched the script — this repo's own folder. `CODEX_BRIDGE_CWD` works too. The
port comes from `--port` or `CODEX_BRIDGE_PORT` (default 8787). The endpoint and
workspace are written to `.bridge.json`, which `talk.mjs` reads by itself.

**2. The Codex TUI you want to watch**

```bash
codex --remote ws://127.0.0.1:8787 -C /path/to/your-project
```

`-C` pins that window's workspace; without it the thread follows the `--cwd`
above.

**Talk to it once in the TUI first, and let the reply finish.** A thread is not
resumable until its first turn has *completed*; before that `thread/resume`
returns `no rollout found for thread id`.

Mind this trap: **`talk.mjs list` already shows the thread before that point** —
the TUI creates it as soon as it attaches, and it appears in
`thread/loaded/list`. Seeing it in `list` does not mean you can talk to it. Skip
this step and `say` still delivers, Codex still answers in the TUI, but the
bridge never receives the reply stream and simply times out (measured on macOS).

**3. The Claude Code side**

```bash
node scripts/talk.mjs list                     # live threads, each with its cwd
node scripts/talk.mjs say "run the tests"      # lands in the TUI, where you see it
node scripts/talk.mjs read                     # the whole thread as structured JSON
```

With exactly one thread, `say` / `read` pick it automatically; with several you
must pass `--thread <id>` — it will not guess which session you meant. `list`
prints every thread's cwd, which is how you tell them apart.

`say` also takes `--cwd <dir>` (changes the working directory from this turn on)
and `--approvals` (see below).

## MCP interface

The CLI remains usable on its own; the MCP interface exposes the same core
capabilities as structured tools. One implementation serves both directions, but
each speaking side runs its own STDIO process:

- `--role claude`: Claude Code speaks to a Codex thread.
- `--role codex`: Codex queues a message into a Claude mailbox.

Installation is covered step by step in **[SETUP.en.md](SETUP.en.md)**. The short
version:

```bash
claude mcp add --scope project claude-codex-bridge -- \
  node /path/to/claude-codex-bridge/scripts/mcp.mjs --role claude

codex mcp add claude-codex-bridge -- \
  node /path/to/claude-codex-bridge/scripts/mcp.mjs --role codex
```

Install only the direction you need. Full bidirectional use needs both; the
receiving halves do not go through MCP at all — they go through the
app-server/TUI and Claude's Stop hook respectively.

Absolute paths, but **the working directory does not matter** — all state
(`.bridge.json`, `.bridge-inbox/`, `.bridge-output/`) is resolved from the
module's own location, so one installation covers every project. `mcp add` only
writes a config file, so **restart the session afterwards** or the tools will not
be there.

### Tools

| Role | Tools |
|---|---|
| Shared | `bridge_status`, `bridge_output_read` |
| Claude | `codex_threads_list`, `codex_thread_read`, `codex_message_send` |
| Codex | `claude_mailboxes_list`, `claude_mailbox_peek`, `claude_message_send` |

`codex_message_send` waits for a whole turn, so give the Codex side a longer
timeout and keep write tools behind approval:

```toml
[mcp_servers.claude-codex-bridge]
tool_timeout_sec = 360
default_tools_approval_mode = "writes"
```

MCP mode permits only `CODEX_BRIDGE_APPROVALS=tui` (default) or `decline` — never
an automatic `accept`. Short replies come back inline; past 64 KiB they are
written to `.bridge-output/` and returned as an opaque artifact ID with a TTL,
paged through `bridge_output_read`. A single capture is capped at 10 MiB by
default, so an unbounded reply can never be forced into one tool result or into
the Node heap.

Local verification:

```bash
npm test                                 # syntax, unit, in-memory MCP, real STDIO smoke; no model calls
npm run test:integration:mcp-app-server  # real app-server connection, no model turn
npm run test:spikes                      # real app-server regression; may use the model
npm run test:e2e:mcp-send                # full MCP → real TUI; needs serve + a TUI past its first turn
```

`test:e2e:mcp-send` differs from every other spike: it does **not** start its own
app-server. It follows `.bridge.json` to the TUI in front of you and creates a
real turn in the thread you are watching, which is why it is kept out of
`test:spikes`.

## The reverse direction: Codex → Claude Code

Claude Code has no equivalent app-server — there is no socket to push into. What
it has is a **Stop hook**: it runs just before Claude finishes, and returning
`{"decision":"block","reason":...}` tells Claude not to stop and to treat
`reason` as new input.

So a mailbox sits in between. Mailboxes are **named**, because several Claude Code
sessions may be listening at once and a shared file would let whoever finishes
first swallow everyone else's mail:

```bash
# from the Codex side (or anywhere)
node scripts/inbox.mjs push --to bridge "while you're in there, check the auth bit"

# who is listening right now, and from where
node scripts/inbox.mjs list

# look at a mailbox without consuming it
node scripts/inbox.mjs peek --as bridge
```

`--to` is "who this message is for", `--as` is "who is reading"; both default to
`$CODEX_BRIDGE_MAILBOX`, then to `default`.

This repo's `.claude/settings.json` already wires the Stop hook up (mailbox
`bridge`), so Claude Code drains the mailbox and keeps going when it finishes work
in this project. Delivery is exactly once: `drain()` renames before reading, so a
concurrent writer is never read half-written.

Rationale and trade-offs: [`docs/reverse-channel.md`](docs/reverse-channel.md).

## Using the bridge from other Claude Code sessions

One server is enough; other sessions share it. Script state (`.bridge.json`, the
mailboxes) resolves from **the module's own location**, not cwd, so calling by
absolute path from any directory works.

**Forward (that session → Codex)**: no configuration, just call it.

```bash
bridge=/path/to/claude-codex-bridge
node "$bridge/scripts/talk.mjs" list
node "$bridge/scripts/talk.mjs" say --thread <threadId> "..."
```

With more than one TUI open, always pass `--thread` — `list` prints each thread's
cwd so you can tell them apart. (Or set `CODEX_BRIDGE_URL` and skip `.bridge.json`
entirely.)

**Reverse (Codex → that session)**: add a Stop hook to **that project's**
`.claude/settings.json`, and give it **its own mailbox name**:

```json
{ "hooks": { "Stop": [ { "matcher": "*", "hooks": [
  { "type": "command",
    "command": "node \"/path/to/claude-codex-bridge/scripts/inbox.mjs\" hook --as web" }
] } ] } }
```

**Do not use `$CLAUDE_PROJECT_DIR` here** — it points at that project, not at the
bridge. Hard-code the path to the bridge. Pick your own mailbox name (`web`
above), one per session.

The Codex side can then address it by name:

```bash
node scripts/inbox.mjs push --to web "fix that CORS rule first"
node scripts/inbox.mjs list       # check the name is right and the session is alive
```

`list` is built from each session's Stop hook registering itself every time it
runs, so **that session has to have finished at least once** before it shows up.

## Approvals (when Codex wants to change something)

If a turn Claude Code starts needs to run a command or edit a file, Codex raises
an approval request. The app-server **broadcasts it to every attached client** and
the first answer wins (the others get `serverRequest/resolved`). Hence the default
policy **`tui`: the bridge stays silent so the prompt in the window in front of
you decides**.

Nobody answering would wedge the whole turn, so there is a backstop: past
`CODEX_BRIDGE_APPROVAL_TIMEOUT_MS` (300s by default) the bridge fail-closes with a
refusal and the turn moves on.

```bash
node scripts/talk.mjs say --approvals decline "..."   # when no TUI is attached
node scripts/talk.mjs say --approvals accept  "..."   # only in an already-trusted workspace
```

`CODEX_BRIDGE_APPROVALS` sets the default.

**Broadcast routing was settled on macOS** (`spike-approvals.mjs`, 11/11): one
client approves, the silent client receives the same request and then
`serverRequest/resolved`, and the turn completes normally. So "the bridge stays
silent" really does mean "a human decides".

The reply shapes are **not consistent across request types**: only the two
`item/*/requestApproval` methods take `{decision:"decline"}`;
`item/permissions/requestApproval` wants an (empty) permissions profile, and the
older `execCommandApproval` / `applyPatchApproval` want
`{decision:{denied:{rejection}}}`. Returning the wrong shape is a schema error,
not a polite refusal. The mapping lives in `DEFAULT_SERVER_REQUEST_RESPONSES` in
`src/appServerWsClient.mjs`.

### Two settings that quietly disable "let the human in the TUI decide"

Before an approval request reaches any client, it passes through the user's own
Codex configuration. With either of these in effect, **the TUI in front of you is
never asked**, and the bridge staying silent no longer means a human is deciding:

| Setting | Location | Effect |
|---|---|---|
| `PermissionRequest` hook | `~/.codex/hooks.json` | The hook takes the request first. Measured on macOS: with the hook live, **neither client received a single approval request**, and the file was written anyway |
| `approvals_reviewer = "auto_review"` | `~/.codex/config.toml` | Handed to a subagent that decides by risk, without asking |

Both are legitimate personal settings and this project does not touch them. Just
know that while they are on, **`--approvals tui`'s "human" is them**. To find out
which case your machine is in, run `spike-approvals.mjs` — it starts its own
app-server with `--disable hooks -c approvals_reviewer=user` to switch both off,
so it measures the protocol rather than anyone's configuration.

## Why not something else

| Approach | Problem |
|---|---|
| `wezterm cli send-text` / `get-text` | Reads the TUI after rendering: box-drawing characters, spinners, wrapped and truncated lines; "is it done yet" can only be answered by polling for screen changes |
| A shared file mailbox (forward direction) | Workable, but no live status, and triggering it needs a human |
| A `/codex:rescue` subagent | Cold start every time, its own session, and **cannot reach the TUI in front of you** |
| This | Structured events; `turn/steer` can even interject into a running turn |

The reverse direction is still a file mailbox — but only because Claude Code has
no socket to attach to, and the Stop hook removes the manual trigger.

## Security

- The listener binds loopback. `--ws-auth` only applies to non-loopback, so no
  token is needed locally.
- Approvals default to a human (`tui`) and fail closed on timeout. Non-approval
  server→client requests (tool calls, MCP elicitation) always fail closed — the
  bridge has no UI with which to ask anyone.

## Verified / not verified

Three spikes, each starting its own app-server on an ephemeral port, so none of
them touches the thread you are watching:

```bash
node scripts/spike-multiclient.mjs   # 9/9   two clients sharing one thread
node scripts/spike-multithread.mjs   # 7/7   two threads at once, replies never cross
node scripts/spike-approvals.mjs     # 11/11 on macOS; 3 SKIP on Windows, see below
```

macOS (26.5.1, Node v24.19.0 LTS, codex-cli 0.147.0): all three spikes pass,
`npm test` 21/21, `npm run test:integration:mcp-app-server` PASS.
`scripts/serve.mjs --cwd`, `scripts/talk.mjs list` and `scripts/inbox.mjs`
(push / list / peek / hook, including CJK text) were exercised by hand as well;
the inbox hook even runs on Node 20, so the Stop hook is not version-sensitive.

Confirmed against a **real TUI** (`codex --remote`): messages sent from Claude
Code render as user messages in the TUI, Codex answers normally, and the answer
streams back to Claude Code. The full MCP path was verified the same way
(`spike-mcp-send.mjs`, 7/7).

Established (codex-cli 0.147.0):

- **Every notification carries `threadId`**; streaming ones
  (`item/agentMessage/delta`) also carry `turnId`, and the `turn.id` returned by
  `turn/start` matches the stream exactly. The earlier belief that notifications
  lacked `threadId` was really the symptom of **a client that had not joined the
  thread**.
- **A thread must be joined via `thread/resume`** before its notifications arrive,
  and a thread is only resumable once **its first turn has completed**.
- **`historyMode: "paginated"`** (threads created by the TUI) makes `thread/read`
  with `includeTurns` fail (`list_turns is not supported yet`). Fetching history
  after the fact is currently a dead end; replies are picked up from the live
  stream instead.
- **Approvals are broadcast to every client and the first answer wins** (settled
  on macOS). The silent client receives the request too and is later told
  `serverRequest/resolved`; the turn does not hang. On a machine whose OS sandbox
  helper cannot launch — some managed corporate Windows machines report
  `ShellExecuteExW failed to launch setup helper: 1223` — writes fail before
  anyone is asked, no approval is ever raised, and those three checks report
  **SKIP**: an environment limit, not a protocol problem.
- **A user-level `PermissionRequest` hook intercepts approvals entirely**, and no
  client sees them (measured on macOS). See the approvals section above.
- **`codex --remote` without `-C`** gives the thread **the app-server's cwd**, not
  the TUI process's own — regardless of the directory you ran it from. With
  `-C <dir>` it becomes that directory. (macOS, driving a TUI through a pty and
  reading `thread/read` back from a second client.)

Not verified:

- `turn/steer` (interjecting into a running turn) — schema read, never exercised.
- The whole protocol is marked `[experimental]`; it may drift as codex is
  upgraded.

## Reference

Why the reverse direction is a Stop hook rather than something else:
[`docs/reverse-channel.md`](docs/reverse-channel.md)

Protocol schema: `codex app-server generate-json-schema --out <dir>`
