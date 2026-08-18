#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadMcpConfig, resolveRole } from "../src/mcp/config.mjs";
import { createBridgeMcp } from "../src/mcp/server.mjs";

const rank = { error: 0, warn: 1, info: 2, debug: 3 };
let threshold = rank.warn;
const log = (message, level = "info") => {
  if ((rank[level] ?? rank.info) <= threshold) process.stderr.write(`[bridge-mcp] ${message}\n`);
};

let bridge = null;
let stopping = false;
const shutdown = async (code = 0) => {
  if (stopping) return;
  stopping = true;
  try { await bridge?.close(); } catch (error) { log(`shutdown error: ${error?.message ?? error}`, "error"); }
  process.exitCode = code;
};

process.on("SIGINT", () => { void shutdown(130); });
process.on("SIGTERM", () => { void shutdown(143); });
try {
  const role = resolveRole();
  const config = loadMcpConfig({ role });
  threshold = rank[config.logLevel] ?? rank.warn;
  bridge = createBridgeMcp({ role, config, log });
  const transport = new StdioServerTransport();
  await bridge.server.connect(transport);
  log(`started role=${role}`, "info");
} catch (error) {
  log(`startup failed: ${error?.message ?? error}`, "error");
  await shutdown(1);
}
