import { BridgeToolError } from "./errors.mjs";

export function selectThread(threads, explicitId = null) {
  if (explicitId) return explicitId;
  if (threads.length === 1) return threads[0].id;
  if (threads.length === 0) {
    throw new BridgeToolError(
      "NO_LIVE_THREAD",
      "No live Codex thread is available. Attach the TUI and complete its first turn.",
      { retryable: true },
    );
  }
  throw new BridgeToolError(
    "AMBIGUOUS_THREAD",
    `${threads.length} live Codex threads are available; choose one explicitly.`,
    {
      details: {
        total: threads.length,
        truncated: threads.length > 20,
        threads: threads.slice(0, 20).map(({ id, cwd, name }) => ({
          id,
          cwd: cwd ?? null,
          name: name ?? null,
        })),
      },
    },
  );
}

export function selectMailbox(mailboxes, explicitName = null, configuredName = null) {
  if (explicitName) return explicitName;
  if (configuredName) return configuredName;
  if (mailboxes.length === 1) return mailboxes[0].name;
  if (mailboxes.length === 0) {
    throw new BridgeToolError(
      "NO_MAILBOX",
      "No Claude mailbox is registered. The target Stop hook must run at least once.",
      { retryable: true },
    );
  }
  throw new BridgeToolError(
    "AMBIGUOUS_MAILBOX",
    `${mailboxes.length} Claude mailboxes are available; choose one explicitly.`,
    {
      details: {
        total: mailboxes.length,
        truncated: mailboxes.length > 20,
        mailboxes: mailboxes.slice(0, 20).map(({ name, cwd, lastSeen }) => ({
          name,
          cwd: cwd ?? null,
          lastSeen: lastSeen ?? null,
        })),
      },
    },
  );
}
