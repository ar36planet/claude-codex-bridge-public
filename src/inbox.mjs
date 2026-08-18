// The reverse direction: Codex -> Claude Code.
//
// Claude Code has no app-server to attach to, so there is no socket to push a
// message down. What it does have is the Stop hook: a hook that runs when Claude
// is about to finish its turn and can hand back `{"decision": "block", "reason":
// ...}`, at which point Claude keeps working with `reason` as its new input.
// That is a real delivery path into the session the human is already watching —
// no polling, no pasting, no cold subagent.
//
// So this file is the mailbox in between: Codex appends lines, the Stop hook
// drains them. A JSONL file rather than a socket because the two ends do not run
// at the same time — Codex writes whenever it likes, Claude reads when it stops.
//
// Mailboxes are NAMED because more than one Claude Code session can be listening
// at once, and a single shared file would let whichever one stops first swallow
// mail meant for the others.

import {
  appendFileSync, readFileSync, writeFileSync, renameSync, rmSync,
  existsSync, mkdirSync, readdirSync, createReadStream,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createInterface } from "node:readline";

export const DEFAULT_MAILBOX = "default";

/** Where all mailboxes live. One directory, one file per named session. */
export function mailboxDir() {
  return process.env.CODEX_BRIDGE_INBOX_DIR
    ?? fileURLToPath(new URL("../.bridge-inbox", import.meta.url));
}

/** Whatever name was not given explicitly comes from the environment. */
export function mailboxName(name = null) {
  return name || process.env.CODEX_BRIDGE_MAILBOX || DEFAULT_MAILBOX;
}

// A name becomes a filename, so keep it to things that safely are one.
const safe = (name) => {
  const cleaned = String(name).trim().replace(/[^A-Za-z0-9._-]/g, "-");
  if (!cleaned || cleaned === "." || cleaned === "..") throw new Error(`bad mailbox name: ${name}`);
  return cleaned;
};

export function mailboxPath(name = null) {
  // A full-path override still wins, so a test (or a one-off) can point
  // somewhere else entirely without knowing about the directory layout.
  if (process.env.CODEX_BRIDGE_INBOX) return process.env.CODEX_BRIDGE_INBOX;
  return join(mailboxDir(), `${safe(mailboxName(name))}.jsonl`);
}

const sessionPath = (name) => join(mailboxDir(), `${safe(mailboxName(name))}.session.json`);

const ensureDir = () => {
  const dir = mailboxDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
};

/** Append one message to a mailbox. Returns what was stored. */
export function push({ text, from = "codex", to = null }) {
  const body = String(text ?? "").trim();
  if (!body) throw new Error("nothing to push: message is empty");
  ensureDir();
  const message = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    from,
    to: mailboxName(to),
    text: body,
  };
  appendFileSync(mailboxPath(to), `${JSON.stringify(message)}\n`, "utf8");
  return message;
}

const parse = (raw) =>
  raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        // A hand-written line is still a message worth delivering.
        return { id: null, at: null, from: "unknown", text: line };
      }
    });

/** Read without consuming. */
export function peek(name = null) {
  const path = mailboxPath(name);
  if (!existsSync(path)) return [];
  return parse(readFileSync(path, "utf8"));
}

/**
 * Read a bounded mailbox preview without loading the whole JSONL file.
 * `onRawLine` can stream a stable snapshot into an output collector.
 */
export async function peekLimited(name = null, {
  maxMessages = 20,
  maxBytes = 65_536,
  onRawLine = null,
} = {}) {
  const path = mailboxPath(name);
  if (!existsSync(path)) return { messages: [], count: 0, returned: 0, truncated: false };

  const messages = [];
  let count = 0;
  let usedBytes = 0;
  let truncated = false;
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    count += 1;
    await onRawLine?.(`${line}\n`);
    if (messages.length >= maxMessages) {
      truncated = true;
      continue;
    }

    const message = parse(line)[0];
    const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    if (usedBytes + bytes <= maxBytes) {
      messages.push(message);
      usedBytes += bytes;
      continue;
    }

    truncated = true;
    if (messages.length === 0) {
      const preview = {
        ...message,
        text: takeUtf8(String(message?.text ?? ""), Math.max(0, Math.floor(maxBytes / 2))),
        previewTruncated: true,
      };
      messages.push(preview);
      usedBytes = Buffer.byteLength(JSON.stringify(preview), "utf8");
    }
  }

  return { messages, count, returned: messages.length, truncated };
}

/**
 * Read and consume, exactly once.
 *
 * Renaming first is what makes that "exactly once": a writer appending
 * concurrently either lands in the file we took or in the fresh one, never in
 * both and never half in each.
 */
export function drain(name = null) {
  const path = mailboxPath(name);
  if (!existsSync(path)) return [];
  const taken = `${path}.taking-${process.pid}`;
  try {
    renameSync(path, taken);
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  try {
    return parse(readFileSync(taken, "utf8"));
  } finally {
    try { rmSync(taken, { force: true }); } catch {}
  }
}

/**
 * Record that a session is listening on this mailbox.
 *
 * The Stop hook calls this on every run, so `listMailboxes()` can answer "who
 * is out there right now" — otherwise the sender has no way to know which names
 * are real, and a typo just means the message is never delivered.
 */
export function announce(name = null, { cwd = process.cwd() } = {}) {
  ensureDir();
  const record = { name: mailboxName(name), cwd, lastSeen: new Date().toISOString() };
  writeFileSync(sessionPath(name), JSON.stringify(record, null, 2), "utf8");
  return record;
}

/** Every mailbox that has either pending mail or a session that announced itself. */
export function listMailboxes() {
  const dir = mailboxDir();
  if (!existsSync(dir)) return [];
  const found = new Map();
  const of = (n) => found.get(n) ?? found.set(n, { name: n, pending: 0, cwd: null, lastSeen: null }).get(n);

  for (const entry of readdirSync(dir)) {
    if (entry.endsWith(".session.json")) {
      const name = entry.slice(0, -".session.json".length);
      try {
        const rec = JSON.parse(readFileSync(join(dir, entry), "utf8"));
        Object.assign(of(name), { cwd: rec.cwd ?? null, lastSeen: rec.lastSeen ?? null });
      } catch {
        of(name);
      }
    } else if (entry.endsWith(".jsonl")) {
      const name = entry.slice(0, -".jsonl".length);
      try {
        of(name).pending = parse(readFileSync(join(dir, entry), "utf8")).length;
      } catch {
        of(name);
      }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Render drained messages as the text Claude Code should pick up as input. */
export function formatForClaude(messages) {
  if (!messages.length) return "";
  const head = messages.length === 1
    ? "Message from the Codex session you are paired with:"
    : `${messages.length} messages from the Codex session you are paired with:`;
  const body = messages
    .map((m) => `[${m.from}${m.at ? ` ${m.at}` : ""}] ${m.text}`)
    .join("\n\n");
  return `${head}\n\n${body}`;
}

const takeUtf8 = (value, maxBytes) => {
  let output = "";
  let size = 0;
  for (const char of value) {
    const bytes = Buffer.byteLength(char, "utf8");
    if (size + bytes > maxBytes) break;
    output += char;
    size += bytes;
  }
  return output;
};
