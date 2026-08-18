import { connect } from "../bridge.mjs";

export class CodexConnectionManager {
  #client = null;
  #connecting = null;

  constructor({
    connectFn = connect,
    approvals = "tui",
    deferMs = 300_000,
    log = () => {},
  } = {}) {
    this.connectFn = connectFn;
    this.approvals = approvals;
    this.deferMs = deferMs;
    this.log = log;
  }

  get connected() {
    return Boolean(this.#client && !this.#client.isClosed);
  }

  async getClient() {
    if (this.#client && !this.#client.isClosed) return this.#client;
    if (this.#connecting) return this.#connecting;

    this.#connecting = this.connectFn({
      approvals: this.approvals,
      deferMs: this.deferMs,
      log: this.log,
    }).then((client) => {
      this.#client = client;
      client.on?.("close", () => {
        if (this.#client === client) this.#client = null;
      });
      return client;
    }).finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  async run(operation, { readOnly = false } = {}) {
    const client = await this.getClient();
    try {
      return await operation(client);
    } catch (error) {
      if (!readOnly || !client.isClosed) throw error;
      if (this.#client === client) this.#client = null;
      const retry = await this.getClient();
      return operation(retry);
    }
  }

  async close() {
    const connecting = this.#connecting;
    try { await connecting; } catch {}
    const client = this.#client;
    this.#client = null;
    this.#connecting = null;
    try { client?.close(); } catch {}
  }
}
