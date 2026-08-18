import * as z from "zod/v4";
import { bridgeUrl, STATE_FILE } from "../bridge.mjs";
import { fileURLToPath } from "node:url";
import { successResult, wrapTool } from "./results.mjs";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export function registerCommonTools(server, {
  config,
  outputStore,
  connectionManager = null,
  claudeAdapter,
}) {
  server.registerTool("bridge_status", {
    description: "Inspect the local bridge role, endpoint, mailbox path, approvals, and output limits without connecting.",
    inputSchema: {},
    annotations: READ_ONLY,
  }, wrapTool(async () => {
    let url = null;
    let configured = false;
    const warnings = [];
    try {
      url = bridgeUrl();
      configured = true;
    } catch (error) {
      warnings.push(error?.message ?? String(error));
    }
    return successResult({
      version: config.version,
      role: config.role,
      transport: config.transport,
      appServer: {
        configured,
        url,
        connected: connectionManager?.connected ?? false,
        stateFile: fileURLToPath(STATE_FILE),
      },
      mailbox: { directory: claudeAdapter.mailboxDir() },
      approvals: { mode: config.approvalMode, deferMs: config.approvalDeferMs },
      outputPolicy: {
        maxInlineBytes: config.output.maxInlineBytes,
        defaultPageBytes: config.output.defaultPageBytes,
        maxPageBytes: config.output.maxPageBytes,
        maxCaptureBytes: config.output.maxCaptureBytes,
        maxDirectoryBytes: config.output.maxDirectoryBytes,
        artifactTtlHours: config.output.ttlMs / 3_600_000,
      },
    }, {
      warnings,
      summary: `Bridge role=${config.role}; app-server ${configured ? "configured" : "not configured"}.`,
    });
  }));

  server.registerTool("bridge_output_read", {
    description: "Read one bounded UTF-8 page from a bridge output artifact using its opaque id and cursor.",
    inputSchema: {
      artifactId: z.string().uuid(),
      cursor: z.string().min(1).optional(),
      maxBytes: z.number().int().min(1).max(config.output.maxPageBytes).optional(),
    },
    annotations: READ_ONLY,
  }, wrapTool(async ({ artifactId, cursor, maxBytes }) => {
    const page = await outputStore.read({
      artifactId,
      cursor: cursor ?? null,
      maxBytes,
      ownerRole: config.role,
    });
    return successResult(page, {
      summary: `Artifact ${artifactId}: ${page.pageBytes} bytes; eof=${page.eof}.`,
    });
  }, "ARTIFACT_STORE_UNAVAILABLE"));

  return ["bridge_status", "bridge_output_read"];
}
