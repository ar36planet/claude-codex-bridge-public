import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("stdio entry point initializes without stdout contamination", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bridge-stdio-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["scripts/mcp.mjs", "--role", "codex"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODEX_BRIDGE_OUTPUT_DIR: join(root, "output"),
      CODEX_BRIDGE_INBOX_DIR: join(root, "inbox"),
      CODEX_BRIDGE_MAILBOX: "web",
      CODEX_BRIDGE_MCP_LOG_LEVEL: "error",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "stdio-smoke", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    await transport.close();
  });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 5);
  const status = await client.callTool({ name: "bridge_status", arguments: {} });
  assert.equal(status.structuredContent.ok, true);
  assert.equal(status.structuredContent.data.role, "codex");

  const queued = await client.callTool({
    name: "claude_message_send",
    arguments: { text: "stdio smoke" },
  });
  assert.equal(queued.structuredContent.data.delivery, "queued");
  const mailbox = join(root, "inbox", "web.jsonl");
  assert.equal(existsSync(mailbox), true);
  assert.match(readFileSync(mailbox, "utf8"), /stdio smoke/);
});
