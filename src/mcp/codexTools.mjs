import * as z from "zod/v4";
import { BridgeToolError } from "./errors.mjs";
import { successResult, wrapTool } from "./results.mjs";
import { selectThread } from "./selection.mjs";

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

export function registerCodexTools(server, { adapter, outputStore, config }) {
  server.registerTool("codex_threads_list", {
    description: "List live Codex TUI threads with ids and working directories. Use this before sending when the target is unclear.",
    inputSchema: {
      limit: z.number().int().min(1).max(100).default(50),
    },
    annotations: READ_ONLY,
  }, wrapTool(async ({ limit }) => {
    const threads = await adapter.listThreads();
    const returned = threads.slice(0, limit).map((thread) => ({
      id: thread.id,
      cwd: thread.cwd ?? null,
      name: thread.name ?? null,
      descriptionError: thread.error ? String(thread.error).slice(0, 500) : null,
    }));
    return successResult({
      count: threads.length,
      returned: returned.length,
      truncated: returned.length < threads.length,
      threads: returned,
    }, {
      warnings: returned.length < threads.length ? [`Only the first ${returned.length} threads were returned.`] : [],
      summary: `${returned.length}/${threads.length} live Codex thread(s) returned.`,
    });
  }, "CODEX_CONNECT_FAILED"));

  server.registerTool("codex_thread_read", {
    description: "Read bounded metadata for one live Codex thread. Full paginated history is not returned.",
    inputSchema: {
      threadId: z.string().min(1).optional(),
    },
    annotations: READ_ONLY,
  }, wrapTool(async ({ threadId }) => {
    const threads = await adapter.listThreads();
    const selected = selectThread(threads, threadId);
    const data = await adapter.readThread(selected);
    return successResult(data, {
      warnings: data.historyComplete ? [] : ["Full turn history is unavailable for this thread."],
      summary: `Codex thread ${selected}; bounded metadata returned.`,
    });
  }, "THREAD_READ_FAILED"));

  server.registerTool("codex_message_send", {
    description: "Send one message to a human-visible Codex TUI thread and wait for that turn. This is non-idempotent; never retry a started turn automatically.",
    inputSchema: {
      threadId: z.string().min(1).optional(),
      text: z.string().trim().min(1).max(config.maxTextLength),
      timeoutMs: z.number().int().min(1_000).max(600_000).default(300_000),
    },
    annotations: WRITE,
  }, wrapTool(async ({ threadId, text, timeoutMs }, extra) => {
    const threads = await adapter.listThreads();
    const selected = selectThread(threads, threadId);
    try { outputStore.cleanup(); } catch {}
    const collector = outputStore.createCollector({
      kind: "codex-reply",
      ownerRole: config.role,
      threadId: selected,
    });

    try {
      const sent = await adapter.sendMessage({
        threadId: selected,
        text,
        timeoutMs,
        signal: extra.signal,
        collector,
      });
      const output = await collector.finalize({ complete: true });
      const warnings = [];
      if (output.truncated && output.artifact) {
        warnings.push("Reply exceeded the inline output budget; page it with bridge_output_read.");
      } else if (output.truncated) {
        warnings.push("Reply exceeded the inline output budget, but no artifact could be created.");
      }
      if (output.captureTruncated) {
        warnings.push("Reply capture was truncated because the output store was unavailable or reached its limit.");
      }
      return successResult({
        threadId: selected,
        turnId: sent.turnId,
        reply: output.truncated ? null : output.inline?.trim() ?? "",
        replyPreview: output.truncated ? output.preview : null,
        truncated: output.truncated,
        totalBytes: output.totalBytes,
        capturedBytes: output.capturedBytes,
        captureTruncated: output.captureTruncated,
        artifact: output.artifact,
        joined: sent.joined,
        completed: true,
      }, {
        warnings,
        summary: output.artifact
          ? `Codex turn ${sent.turnId} completed; long reply stored as artifact ${output.artifact.id}.`
          : `Codex turn ${sent.turnId} completed.`,
      });
    } catch (error) {
      const partial = await collector.finalize({ complete: false, forceArtifact: true });
      throw mapSendError(error, selected, partial);
    }
  }, "TURN_FAILED"));

  return ["codex_threads_list", "codex_thread_read", "codex_message_send"];
}

const mapSendError = (error, threadId, partial) => {
  if (error instanceof BridgeToolError) {
    return new BridgeToolError(error.code, error.message, {
      retryable: error.retryable,
      cause: error,
      details: {
        ...(error.details ?? {}),
        threadId,
        partialOutput: partial?.artifact ?? null,
        partialPreview: partial?.preview ?? partial?.inline ?? null,
        captureTruncated: partial?.captureTruncated ?? false,
      },
    });
  }
  const code = error?.name === "AbortError"
    ? "CANCELLED"
    : error?.code === "TURN_TIMEOUT"
      ? "TURN_TIMEOUT"
      : error?.started
        ? "TURN_FAILED"
        : "TURN_START_FAILED";
  return new BridgeToolError(code, error?.message ?? "Codex turn failed.", {
    retryable: code === "TURN_START_FAILED",
    cause: error,
    details: {
      threadId,
      turnId: error?.turnId ?? partial?.artifact?.turnId ?? null,
      started: Boolean(error?.started),
      partialOutput: partial?.artifact ?? null,
      partialPreview: partial?.preview ?? partial?.inline ?? null,
      captureTruncated: partial?.captureTruncated ?? false,
    },
  });
};
