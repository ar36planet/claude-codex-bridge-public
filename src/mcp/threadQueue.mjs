import { BridgeToolError } from "./errors.mjs";

export class ThreadQueue {
  #tails = new Map();

  async run(threadId, operation, { waitMs = 300_000, signal } = {}) {
    const previous = this.#tails.get(threadId) ?? Promise.resolve();
    let release;
    const ownDone = new Promise((resolve) => { release = resolve; });
    const current = Promise.allSettled([previous, ownDone]).then(() => undefined);
    this.#tails.set(threadId, current);
    void current.finally(() => {
      if (this.#tails.get(threadId) === current) this.#tails.delete(threadId);
    });

    try {
      await waitForTurn(previous, threadId, waitMs, signal);
      if (signal?.aborted) throw abortError();
      return await operation();
    } finally {
      release();
    }
  }

  get size() {
    return this.#tails.size;
  }
}

const abortError = () => new BridgeToolError("CANCELLED", "The queued operation was cancelled.");

const waitForTurn = (previous, threadId, waitMs, signal) => new Promise((resolve, reject) => {
  let settled = false;
  const finish = (fn, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    fn(value);
  };
  const onAbort = () => finish(reject, abortError());
  const timer = setTimeout(() => finish(reject, new BridgeToolError(
    "THREAD_QUEUE_TIMEOUT",
    `Waited ${waitMs}ms for the previous turn on thread ${threadId}.`,
  )), waitMs);
  timer.unref?.();
  signal?.addEventListener("abort", onAbort, { once: true });
  previous.then(() => finish(resolve), () => finish(resolve));
});
