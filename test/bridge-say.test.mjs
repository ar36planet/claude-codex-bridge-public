import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { say } from "../src/bridge.mjs";

class FakeClient extends EventEmitter {
  constructor({ failStart = false, complete = true, earlyDelta = "early " } = {}) {
    super();
    this.failStart = failStart;
    this.complete = complete;
    this.earlyDelta = earlyDelta;
    this.log = () => {};
  }

  async request(method) {
    if (method === "thread/resume") return {};
    if (method === "thread/loaded/list") return { data: [{ id: "thread-1" }] };
    if (method === "turn/start") {
      if (this.failStart) throw new Error("start failed");
      this.emit("item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        delta: this.earlyDelta,
      });
      queueMicrotask(() => {
        this.emit("item/agentMessage/delta", {
          threadId: "thread-1",
          turnId: "turn-1",
          delta: "reply",
        });
        if (this.complete) this.emit("turn/completed", {
          threadId: "thread-1",
          turn: { id: "turn-1" },
        });
      });
      return { turn: { id: "turn-1" } };
    }
    throw new Error(`unexpected method ${method}`);
  }
}

test("say pins early deltas and streams them into a collector", async () => {
  const client = new FakeClient();
  const chunks = [];
  const context = {};
  const collector = {
    append: (value) => chunks.push(value),
    setContext: (value) => Object.assign(context, value),
    markCaptureTruncated: () => {},
  };
  const result = await say(client, {
    threadId: "thread-1",
    text: "hello",
    collector,
    timeoutMs: 100,
  });
  assert.equal(chunks.join(""), "early reply");
  assert.equal(result.turnId, "turn-1");
  assert.equal(result.joined, true);
  assert.deepEqual(context, { threadId: "thread-1", turnId: "turn-1" });
  assert.equal(client.listenerCount("turn/completed"), 0);
  assert.equal(client.listenerCount("item/agentMessage/delta"), 0);
});

test("say cleans listeners when turn/start fails", async () => {
  const client = new FakeClient({ failStart: true });
  await assert.rejects(() => say(client, {
    threadId: "thread-1",
    text: "hello",
    timeoutMs: 50,
  }), /start failed/);
  assert.equal(client.listenerCount("turn/completed"), 0);
  assert.equal(client.listenerCount("item/agentMessage/delta"), 0);
});

test("say bounds pre-pin output and accounts for dropped bytes", async () => {
  const client = new FakeClient({ earlyDelta: "abcdefghij" });
  const chunks = [];
  let dropped = 0;
  const collector = {
    append: (value) => chunks.push(value),
    setContext: () => {},
    noteUncapturedBytes: (bytes) => { dropped += bytes; },
  };
  const result = await say(client, {
    threadId: "thread-1",
    text: "hello",
    collector,
    timeoutMs: 100,
    prePinMaxBytes: 4,
  });
  assert.equal(chunks.join(""), "abcd");
  assert.equal(dropped, 11);
  assert.equal(result.prePinTruncated, true);
});

test("say times out with started turn metadata and cleans listeners", async () => {
  // Node's test runner before v24 treats "no ref'd handles left" as "the event
  // loop resolved" and cancels a test whose only pending work is an unref()'d
  // timer — which is precisely what a timeout path is. The unref() is correct in
  // production (a pending timeout must not hold the MCP server or CLI open), so
  // the test holds a ref'd handle of its own rather than weakening the code
  // under test.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    const client = new FakeClient({ complete: false });
    await assert.rejects(() => say(client, {
      threadId: "thread-1",
      text: "hello",
      timeoutMs: 10,
    }), (error) => error.code === "TURN_TIMEOUT" && error.turnId === "turn-1" && error.started);
    assert.equal(client.listenerCount("turn/completed"), 0);
    assert.equal(client.listenerCount("item/agentMessage/delta"), 0);
  } finally {
    clearInterval(keepAlive);
  }
});
