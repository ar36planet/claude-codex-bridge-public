import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadMcpConfig } from "../src/mcp/config.mjs";
import { OutputStore } from "../src/mcp/outputStore.mjs";
import { createBridgeMcp } from "../src/mcp/server.mjs";

const roots = [];
test.afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const setup = async (role, overrides = {}) => {
  const root = mkdtempSync(join(tmpdir(), "bridge-mcp-test-"));
  roots.push(root);
  const env = { CODEX_BRIDGE_OUTPUT_DIR: join(root, "output") };
  const config = loadMcpConfig({ role, env });
  config.output.maxInlineBytes = 4_096;
  config.output.defaultPageBytes = 1_024;
  const outputStore = new OutputStore(config.output);
  const claudeAdapter = overrides.claudeAdapter ?? {
    mailboxDir: () => join(root, "inbox"),
    listMailboxes: () => [{ name: "web", pending: 0, cwd: root, lastSeen: null }],
    peekMailbox: async () => ({ messages: [], count: 0, returned: 0, truncated: false }),
    sendMessage: ({ mailbox }) => ({ id: "message-1", at: new Date(0).toISOString(), to: mailbox }),
  };
  const codexAdapter = overrides.codexAdapter ?? {
    listThreads: async () => [{ id: "thread-1", cwd: root, name: null }],
    readThread: async (threadId) => ({
      threadId,
      metadata: { cwd: root, name: null, status: "idle" },
      historyComplete: false,
    }),
    sendMessage: async ({ threadId, collector }) => {
      collector.append("x".repeat(5_000));
      collector.setContext({ threadId, turnId: "turn-1" });
      return { threadId, turnId: "turn-1", joined: true };
    },
  };
  const bridge = createBridgeMcp({
    role,
    config,
    outputStore,
    claudeAdapter,
    codexAdapter,
    env,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "bridge-test", version: "1.0.0" });
  await bridge.server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    bridge,
    client,
    close: async () => {
      await client.close();
      await bridge.close();
    },
  };
};

test("claude role exposes only common and Codex-direction tools", async (t) => {
  const fixture = await setup("claude");
  t.after(fixture.close);
  const listed = await fixture.client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
    "bridge_output_read",
    "bridge_status",
    "codex_message_send",
    "codex_thread_read",
    "codex_threads_list",
  ]);

  const sent = await fixture.client.callTool({
    name: "codex_message_send",
    arguments: { text: "hello", timeoutMs: 1_000 },
  });
  assert.equal(sent.isError, undefined);
  assert.equal(sent.structuredContent.ok, true);
  assert.equal(sent.structuredContent.data.truncated, true);
  const artifact = sent.structuredContent.data.artifact;
  assert.ok(artifact?.id);

  const page = await fixture.client.callTool({
    name: "bridge_output_read",
    arguments: { artifactId: artifact.id, maxBytes: 1_024 },
  });
  assert.equal(page.structuredContent.ok, true);
  assert.equal(page.structuredContent.data.pageBytes, 1_024);
});

test("codex role exposes only common and Claude-direction tools", async (t) => {
  const fixture = await setup("codex");
  t.after(fixture.close);
  const listed = await fixture.client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
    "bridge_output_read",
    "bridge_status",
    "claude_mailbox_peek",
    "claude_mailboxes_list",
    "claude_message_send",
  ]);

  const queued = await fixture.client.callTool({
    name: "claude_message_send",
    arguments: { text: "hello" },
  });
  assert.equal(queued.structuredContent.data.delivery, "queued");
  assert.equal(queued.structuredContent.data.delivered, false);
});

test("failed started turn keeps partial output as an incomplete artifact", async (t) => {
  const fixture = await setup("claude", {
    codexAdapter: {
      listThreads: async () => [{ id: "thread-1", cwd: null, name: null }],
      readThread: async () => ({}),
      sendMessage: async ({ collector }) => {
        collector.setContext({ turnId: "turn-timeout" });
        collector.append("partial reply");
        const error = new Error("turn timed out");
        error.code = "TURN_TIMEOUT";
        error.turnId = "turn-timeout";
        error.started = true;
        throw error;
      },
    },
  });
  t.after(fixture.close);
  const failed = await fixture.client.callTool({
    name: "codex_message_send",
    arguments: { text: "hello", timeoutMs: 1_000 },
  });
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent.error.code, "TURN_TIMEOUT");
  const artifact = failed.structuredContent.error.details.partialOutput;
  assert.ok(artifact?.id);
  assert.equal(artifact.complete, false);

  const page = await fixture.client.callTool({
    name: "bridge_output_read",
    arguments: { artifactId: artifact.id },
  });
  assert.equal(page.structuredContent.data.content, "partial reply");
  assert.equal(page.structuredContent.data.complete, false);
});
