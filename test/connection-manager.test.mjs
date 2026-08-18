import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CodexConnectionManager } from "../src/mcp/codexConnection.mjs";

test("connection that finishes during shutdown is closed", async () => {
  let resolveConnect;
  const connecting = new Promise((resolve) => { resolveConnect = resolve; });
  const client = new EventEmitter();
  client.isClosed = false;
  client.close = () => { client.isClosed = true; };
  const manager = new CodexConnectionManager({ connectFn: () => connecting });

  const getting = manager.getClient();
  const closing = manager.close();
  resolveConnect(client);
  await getting;
  await closing;
  assert.equal(client.isClosed, true);
  assert.equal(manager.connected, false);
});
