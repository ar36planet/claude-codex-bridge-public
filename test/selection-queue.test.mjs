import test from "node:test";
import assert from "node:assert/strict";
import { selectMailbox, selectThread } from "../src/mcp/selection.mjs";
import { ThreadQueue } from "../src/mcp/threadQueue.mjs";

test("thread and mailbox selection never guesses among multiple targets", () => {
  assert.equal(selectThread([{ id: "only" }]), "only");
  assert.equal(selectThread([{ id: "a" }, { id: "b" }], "b"), "b");
  assert.throws(() => selectThread([{ id: "a" }, { id: "b" }]), { code: "AMBIGUOUS_THREAD" });
  assert.throws(() => selectThread([]), { code: "NO_LIVE_THREAD" });

  assert.equal(selectMailbox([{ name: "web" }]), "web");
  assert.equal(selectMailbox([{ name: "a" }, { name: "b" }], null, "b"), "b");
  assert.throws(() => selectMailbox([{ name: "a" }, { name: "b" }]), { code: "AMBIGUOUS_MAILBOX" });
  assert.throws(() => selectMailbox([]), { code: "NO_MAILBOX" });
});

test("ThreadQueue serializes one thread and allows different threads to overlap", async () => {
  const queue = new ThreadQueue();
  const events = [];
  let releaseA;
  const gateA = new Promise((resolve) => { releaseA = resolve; });

  const first = queue.run("a", async () => {
    events.push("a1-start");
    await gateA;
    events.push("a1-end");
  });
  const second = queue.run("a", async () => { events.push("a2"); });
  const other = queue.run("b", async () => { events.push("b1"); });

  await other;
  assert.deepEqual(events, ["a1-start", "b1"]);
  releaseA();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["a1-start", "b1", "a1-end", "a2"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queue.size, 0);
});

test("a timed-out queue waiter cannot let later work pass an active turn", async () => {
  const queue = new ThreadQueue();
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const events = [];
  const first = queue.run("a", async () => {
    events.push("first-start");
    await gate;
    events.push("first-end");
  });
  const timedOut = queue.run("a", async () => events.push("must-not-run"), { waitMs: 5 });
  await assert.rejects(() => timedOut, { code: "THREAD_QUEUE_TIMEOUT" });
  const third = queue.run("a", async () => events.push("third"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events, ["first-start"]);
  releaseFirst();
  await Promise.all([first, third]);
  assert.deepEqual(events, ["first-start", "first-end", "third"]);
});
