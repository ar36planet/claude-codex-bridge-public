// Spike: the full MCP path, end to end, against the TUI a human is watching.
//
// Every other spike starts its own throwaway app-server. This one deliberately
// does not: it drives the REAL MCP server as a STDIO child process, which
// connects to the endpoint in .bridge.json — the same one your TUI is attached
// to. That is the only way to prove the last link in the chain:
//
//   MCP client → scripts/mcp.mjs (child process) → app-server → your TUI
//                → Codex replies → streamed back into the tool result
//
// Because of that it is NOT part of `npm run test:spikes`. It creates a real
// turn in the thread you are watching, so run it deliberately:
//
//   node scripts/serve.mjs --cwd <你的專案>     # 視窗 1
//   codex --remote ws://127.0.0.1:8787          # 視窗 2 — 先講一句話讓它跑完
//   node scripts/spike-mcp-send.mjs             # 視窗 3
//
// The "先講一句話" step is load-bearing: a thread shows up in
// codex_threads_list as soon as the TUI attaches, but is not resumable until
// its first turn has finished. Skip it and the send succeeds while the reply
// never arrives.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { scoreboard } from "./_harness.mjs";

const { record, report } = scoreboard();
const repo = fileURLToPath(new URL("..", import.meta.url));
const TEXT = process.argv.slice(2).join(" ")
  || "這則是經由 MCP tool codex_message_send 送出的。請只回覆一個詞：MCP-OK";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["scripts/mcp.mjs", "--role", "claude"],
  cwd: repo,
  env: { ...process.env, CODEX_BRIDGE_MCP_LOG_LEVEL: "error" },
  stderr: "pipe",
});
const client = new Client({ name: "spike-mcp-send", version: "1.0.0" });

try {
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  record("claude role exposes the Codex-direction tools", names.length === 5, names.join(", "));

  const status = await client.callTool({ name: "bridge_status", arguments: {} });
  record("bridge_status reaches the live app-server",
    status.structuredContent?.ok === true && status.structuredContent?.data?.role === "claude",
    `role=${status.structuredContent?.data?.role}`);

  const list = await client.callTool({ name: "codex_threads_list", arguments: {} });
  const threads = list.structuredContent?.data?.threads ?? [];
  record("a live thread is attached (your TUI)", threads.length > 0,
    threads.map((t) => `${t.id} ${t.cwd ?? "?"}`).join(" | ") || "none — attach the TUI first");
  if (!threads.length) throw new Error("no live thread");

  console.log("\n--- calling codex_message_send; watch the TUI ---\n");
  const sent = await client.callTool({ name: "codex_message_send", arguments: { text: TEXT } });
  const data = sent.structuredContent?.data;

  record("codex_message_send returns ok", sent.structuredContent?.ok === true);
  record("the tool result is bound to a turn", Boolean(data?.turnId), `turnId=${data?.turnId}`);
  record("the bridge joined the thread, so the reply stream is complete",
    data?.joined === true,
    data?.joined ? "joined" : "NOT joined — did the TUI complete its first turn?");
  record("a reply came back through the MCP tool result",
    typeof data?.reply === "string" && data.reply.length > 0,
    JSON.stringify(data?.reply ?? null));
} catch (err) {
  record("spike completed without throwing", false, err?.message ?? String(err));
} finally {
  try { await client.close(); } catch {}
  try { await transport.close(); } catch {}
}

report();
