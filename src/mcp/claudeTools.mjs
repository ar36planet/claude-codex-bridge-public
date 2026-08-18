import * as z from "zod/v4";
import { successResult, wrapTool } from "./results.mjs";
import { selectMailbox } from "./selection.mjs";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

export function registerClaudeTools(server, { adapter, outputStore, config, env = process.env }) {
  server.registerTool("claude_mailboxes_list", {
    description: "List Claude Code mailboxes that have pending mail or have announced through a Stop hook.",
    inputSchema: {
      limit: z.number().int().min(1).max(100).default(50),
    },
    annotations: READ_ONLY,
  }, wrapTool(async ({ limit }) => {
    const mailboxes = adapter.listMailboxes();
    const returned = mailboxes.slice(0, limit);
    return successResult({
      count: mailboxes.length,
      returned: returned.length,
      truncated: returned.length < mailboxes.length,
      mailboxes: returned,
    }, {
      warnings: returned.length < mailboxes.length ? [`Only the first ${returned.length} mailboxes were returned.`] : [],
      summary: `${returned.length}/${mailboxes.length} Claude mailbox(es) returned.`,
    });
  }));

  server.registerTool("claude_mailbox_peek", {
    description: "Inspect a bounded, non-consuming preview of one Claude mailbox. This never drains messages.",
    inputSchema: {
      mailbox: z.string().min(1).optional(),
      maxMessages: z.number().int().min(1).max(100).default(20),
    },
    annotations: READ_ONLY,
  }, wrapTool(async ({ mailbox, maxMessages }) => {
    const mailboxes = adapter.listMailboxes();
    const selected = selectMailbox(mailboxes, mailbox, env.CODEX_BRIDGE_MAILBOX ?? null);
    try { outputStore.cleanup(); } catch {}
    const collector = outputStore.createCollector({
      kind: "mailbox-snapshot",
      ownerRole: config.role,
      mailbox: selected,
    });
    const preview = await adapter.peekMailbox(selected, {
      maxMessages,
      maxBytes: Math.floor(config.output.maxInlineBytes / 2),
      onRawLine: (line) => collector.append(line),
    });
    const output = await collector.finalize({ complete: true, forceArtifact: preview.truncated });
    const truncated = preview.truncated || output.truncated;
    return successResult({
      mailbox: selected,
      count: preview.count,
      returned: preview.returned,
      truncated,
      messages: preview.messages,
      artifact: output.artifact,
      captureTruncated: output.captureTruncated,
    }, {
      warnings: output.artifact
        ? ["Mailbox preview was bounded; page the snapshot artifact with bridge_output_read."]
        : [],
      summary: `Mailbox ${selected}: ${preview.returned}/${preview.count} message(s) returned.`,
    });
  }, "MAILBOX_READ_FAILED"));

  server.registerTool("claude_message_send", {
    description: "Queue one message for a Claude Code mailbox. Success means queued, not delivered; delivery waits for the target Stop hook.",
    inputSchema: {
      mailbox: z.string().min(1).optional(),
      text: z.string().trim().min(1).max(config.maxTextLength),
    },
    annotations: WRITE,
  }, wrapTool(async ({ mailbox, text }) => {
    const mailboxes = adapter.listMailboxes();
    const selected = selectMailbox(mailboxes, mailbox, env.CODEX_BRIDGE_MAILBOX ?? null);
    const message = adapter.sendMessage({ mailbox: selected, text });
    return successResult({
      messageId: message.id,
      mailbox: selected,
      queuedAt: message.at,
      delivery: "queued",
      delivered: false,
    }, {
      warnings: ["Delivery occurs when the target Claude Code session next runs its Stop hook."],
      summary: `Message ${message.id} queued for Claude mailbox ${selected}; not yet delivered.`,
    });
  }, "MAILBOX_WRITE_FAILED"));

  return ["claude_mailboxes_list", "claude_mailbox_peek", "claude_message_send"];
}
