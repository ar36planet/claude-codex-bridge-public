import { describeThreads, say } from "../bridge.mjs";
import { listMailboxes, mailboxDir, peekLimited, push } from "../inbox.mjs";

export function createCodexAdapter({ manager, queue, queueWaitMs }) {
  return {
    get connected() { return manager.connected; },

    listThreads() {
      return manager.run((client) => describeThreads(client), { readOnly: true });
    },

    readThread(threadId) {
      return manager.run(async (client) => {
        const response = await client.request("thread/read", { threadId });
        const thread = response?.thread ?? response ?? {};
        return {
          threadId,
          metadata: {
            cwd: thread.cwd ?? null,
            name: thread.name ?? null,
            status: typeof thread.status === "string"
              ? thread.status
              : thread.status?.type ?? null,
          },
          historyComplete: false,
        };
      }, { readOnly: true });
    },

    sendMessage({ threadId, text, timeoutMs, signal, collector }) {
      return queue.run(threadId, () => manager.run((client) => say(client, {
        threadId,
        text,
        timeoutMs,
        signal,
        collector,
      })), { waitMs: queueWaitMs, signal });
    },
  };
}

export function createClaudeAdapter() {
  return {
    mailboxDir,
    listMailboxes,
    peekMailbox(mailbox, options) {
      return peekLimited(mailbox, options);
    },
    sendMessage({ mailbox, text }) {
      return push({ text, from: "codex", to: mailbox });
    },
  };
}
