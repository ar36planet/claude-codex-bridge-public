// MCP-to-app-server integration smoke without creating a model turn.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startAppServer } from "./_harness.mjs";
import { loadMcpConfig } from "../src/mcp/config.mjs";
import { createBridgeMcp } from "../src/mcp/server.mjs";

const outputRoot = mkdtempSync(join(tmpdir(), "bridge-mcp-spike-"));
const previousUrl = process.env.CODEX_BRIDGE_URL;
let appServer = null;
let bridge = null;
let client = null;

try {
  appServer = await startAppServer({ quiet: true });
  process.env.CODEX_BRIDGE_URL = appServer.url;
  const config = loadMcpConfig({
    role: "claude",
    env: {
      ...process.env,
      CODEX_BRIDGE_OUTPUT_DIR: outputRoot,
      CODEX_BRIDGE_APPROVALS: "decline",
    },
  });
  bridge = createBridgeMcp({ role: "claude", config });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "bridge-mcp-spike", version: "1.0.0" });
  await bridge.server.connect(serverTransport);
  await client.connect(clientTransport);

  const result = await client.callTool({ name: "codex_threads_list", arguments: {} });
  if (result.isError || result.structuredContent?.data?.count !== 0) {
    throw new Error(`unexpected list result: ${JSON.stringify(result.structuredContent)}`);
  }
  process.stdout.write("PASS  MCP connected to an ephemeral app-server and listed zero live threads\n");
} finally {
  try { await client?.close(); } catch {}
  try { await bridge?.close(); } catch {}
  try { appServer?.stop(); } catch {}
  if (previousUrl === undefined) delete process.env.CODEX_BRIDGE_URL;
  else process.env.CODEX_BRIDGE_URL = previousUrl;
  rmSync(outputRoot, { recursive: true, force: true });
}
