import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createClaudeAdapter, createCodexAdapter } from "./adapters.mjs";
import { registerClaudeTools } from "./claudeTools.mjs";
import { CodexConnectionManager } from "./codexConnection.mjs";
import { registerCodexTools } from "./codexTools.mjs";
import { registerCommonTools } from "./commonTools.mjs";
import { loadMcpConfig } from "./config.mjs";
import { OutputStore } from "./outputStore.mjs";
import { ThreadQueue } from "./threadQueue.mjs";

export function createBridgeMcp({
  role,
  config = loadMcpConfig({ role }),
  outputStore = new OutputStore(config.output),
  connectionManager = null,
  codexAdapter = null,
  claudeAdapter = createClaudeAdapter(),
  env = process.env,
  log = () => {},
} = {}) {
  try { outputStore.cleanup(); } catch (error) { log(`output cleanup warning: ${error?.message ?? error}`); }

  let manager = connectionManager;
  let activeCodexAdapter = codexAdapter;
  if (role === "claude" && !activeCodexAdapter) {
    manager ??= new CodexConnectionManager({
      approvals: config.approvalMode,
      deferMs: config.approvalDeferMs,
      log,
    });
    activeCodexAdapter = createCodexAdapter({
      manager,
      queue: new ThreadQueue(),
      queueWaitMs: config.queueWaitMs,
    });
  }

  const server = new McpServer({
    name: "claude-codex-bridge",
    version: config.version,
  }, {
    instructions: instructionsFor(role),
  });

  const toolNames = registerCommonTools(server, {
    config,
    outputStore,
    connectionManager: manager,
    claudeAdapter,
  });

  if (role === "claude") {
    toolNames.push(...registerCodexTools(server, {
      adapter: activeCodexAdapter,
      outputStore,
      config,
    }));
  } else if (role === "codex") {
    toolNames.push(...registerClaudeTools(server, {
      adapter: claudeAdapter,
      outputStore,
      config,
      env,
    }));
  } else {
    throw new Error(`invalid MCP role: ${role}`);
  }

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await outputStore.closeAll();
    await manager?.close();
    await server.close();
  };

  return { server, close, config, outputStore, toolNames };
}

export const instructionsFor = (role) => role === "claude"
  ? [
    "This server lets Claude actively talk to a human-visible Codex TUI thread.",
    "List targets before sending when no thread is explicit; never guess among multiple threads.",
    "A send waits for the Codex turn and may require approval in the human TUI.",
    "Do not retry a started turn after timeout.",
    "Long replies are bounded artifacts; page them with bridge_output_read instead of requesting them again.",
  ].join(" ")
  : [
    "This server lets Codex actively queue a message for a Claude Code session.",
    "List targets before sending when no mailbox is explicit; never guess among multiple mailboxes.",
    "A successful send means queued, not delivered; delivery occurs at the target session's next Stop hook.",
    "Long peek results are bounded artifacts; page them with bridge_output_read.",
  ].join(" ");
