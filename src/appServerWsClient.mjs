// WebSocket JSON-RPC client for `codex app-server --listen ws://...`.
//
// Adapted from a stdio app-server client:
// same JSON-RPC 2.0 envelopes and same initialize/initialized handshake, but
// over a WebSocket instead of a spawned child's stdio. The reason for ws is
// that the Codex TUI can attach to the very same endpoint via
// `codex --remote ws://host:port`, so a human can watch the thread this client
// drives. Loopback listeners need no auth (`--ws-auth` is for non-loopback).
//
// The app-server protocol is EXPERIMENTAL and drifts between CLI versions;
// verified against codex-cli 0.147.0.

import { EventEmitter } from "node:events";

const DEFAULT_PROTOCOL_VERSION = "1.0";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Return this from `onServerRequest` to leave a server->client request
 * unanswered on purpose — the app-server fans these out to every attached
 * client and takes the first answer, so staying quiet is how this client
 * defers a decision to the human's TUI. See DEFER in src/approvals.mjs.
 */
export const IGNORE_REQUEST = Symbol("ignore-server-request");

/**
 * Fail-closed answers, per method. The shapes are NOT uniform: only the two
 * item/*Approval methods take `{decision: "decline"}`; permissions grants an
 * (empty) profile instead, the legacy methods take a `ReviewDecision` whose
 * refusal is an object, and the non-approval requests have their own payloads.
 * Answering the wrong shape is a schema error, not a polite refusal.
 * (codex-cli 0.147.0 — see `codex app-server generate-json-schema`.)
 */
const REFUSAL = "declined by claude-codex-bridge (no approval handler)";

export const DEFAULT_SERVER_REQUEST_RESPONSES = {
  "item/commandExecution/requestApproval": { decision: "decline" },
  "item/fileChange/requestApproval": { decision: "decline" },
  "item/permissions/requestApproval": { permissions: {}, scope: "turn" },
  "item/tool/requestUserInput": { answers: {} },
  "item/tool/call": { success: false, contentItems: [{ type: "inputText", text: REFUSAL }] },
  "mcpServer/elicitation/request": { action: "decline" },
  // Legacy (pre-item/*) approval methods, still emitted by some code paths.
  execCommandApproval: { decision: { denied: { rejection: REFUSAL } } },
  applyPatchApproval: { decision: { denied: { rejection: REFUSAL } } },
};

/** True for any method that asks a human to allow something. */
export const isApprovalRequest = (method) =>
  /requestApproval$/.test(method) || method === "execCommandApproval" || method === "applyPatchApproval";

export class CodexAppServerClient extends EventEmitter {
  #ws = null;
  #nextId = 1;
  #pending = new Map();
  #closed = false;

  constructor({
    url,
    clientName = "claude-codex-bridge",
    clientVersion = "0.1.0",
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    authToken = null,
    log = null,
    // Decide any server->client request. Return the JSON-RPC result to send, or
    // IGNORE_REQUEST to stay silent and let another client answer. Fail-closed
    // (DEFAULT_SERVER_REQUEST_RESPONSES) when absent or when it throws.
    onServerRequest = null,
  }) {
    super();
    this.url = url;
    this.clientName = clientName;
    this.clientVersion = clientVersion;
    this.requestTimeoutMs = requestTimeoutMs;
    this.authToken = authToken;
    this.serverInfo = null;
    this.onServerRequest = onServerRequest;
    this.log = log ?? (() => {});
  }

  get isClosed() {
    return this.#closed;
  }

  /** Open the socket, then run the initialize/initialized handshake. */
  async connect() {
    const opts = this.authToken
      ? { headers: { Authorization: `Bearer ${this.authToken}` } }
      : undefined;
    const ws = new WebSocket(this.url, opts);
    this.#ws = ws;

    await new Promise((resolve, reject) => {
      const onOpen = () => {
        ws.removeEventListener("error", onError);
        resolve();
      };
      const onError = () => {
        ws.removeEventListener("open", onOpen);
        reject(new Error(`websocket failed to open: ${this.url}`));
      };
      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onError, { once: true });
    });

    ws.addEventListener("message", (ev) => {
      // Server may batch multiple JSON-RPC objects as newline-delimited text.
      for (const line of String(ev.data).split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let payload;
        try {
          payload = JSON.parse(trimmed);
        } catch {
          this.log(`non-json frame: ${trimmed.slice(0, 200)}`);
          continue;
        }
        void this.#handleEnvelope(payload);
      }
    });
    ws.addEventListener("close", (ev) => {
      this.#closed = true;
      for (const p of this.#pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`socket closed before ${p.method} responded (code=${ev.code})`));
      }
      this.#pending.clear();
      this.emit("close", ev.code, ev.reason);
    });
    // EventEmitter throws on an "error" event with no listener, and teardown
    // routinely produces one; only forward it if someone is actually listening.
    ws.addEventListener("error", (err) => {
      if (this.#closed) return;
      if (this.listenerCount("error") > 0) this.emit("error", err);
      else this.log(`websocket error: ${err?.message ?? "unknown"}`);
    });

    this.serverInfo = await this.request("initialize", {
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
      clientInfo: { name: this.clientName, version: this.clientVersion },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
    this.log(`initialized codexHome=${this.serverInfo?.codexHome ?? "?"}`);
    return this.serverInfo;
  }

  request(method, params, timeoutMs = this.requestTimeoutMs) {
    if (this.#closed) return Promise.reject(new Error(`client closed; cannot ${method}`));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      try {
        this.#write({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method, params) {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  /** Answer a server->client request that `onServerRequest` deferred. */
  respond(id, result) {
    this.#write({ jsonrpc: "2.0", id, result });
  }

  #write(payload) {
    if (!this.#ws || this.#closed) throw new Error("websocket unavailable");
    this.#ws.send(JSON.stringify(payload));
  }

  async #handleEnvelope(payload) {
    if (!payload || typeof payload !== "object") return;
    const hasId = payload.id !== undefined && payload.id !== null;
    const method = typeof payload.method === "string" ? payload.method : undefined;

    // Response to one of our requests: has id, no method.
    if (hasId && !method) {
      const pending = this.#pending.get(payload.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(payload.id);
      if (payload.error) {
        pending.reject(new Error(`${pending.method}: ${payload.error.message ?? "rpc error"}`));
      } else {
        pending.resolve(payload.result);
      }
      return;
    }

    // Server->client request. The server broadcasts these to every attached
    // client and uses whichever answer lands first (the losers then get a
    // `serverRequest/resolved` notification), so silence is a valid move: it
    // hands the decision to the human's TUI.
    if (hasId && method) {
      const fallback = DEFAULT_SERVER_REQUEST_RESPONSES[method] ?? {};
      let result = fallback;
      if (this.onServerRequest) {
        try {
          const decided = await this.onServerRequest({ method, params: payload.params, id: payload.id });
          if (decided === IGNORE_REQUEST) {
            this.emit("serverRequest", { method, params: payload.params, id: payload.id, answered: null });
            return;
          }
          if (decided !== undefined) result = decided;
        } catch (err) {
          this.log(`server-request handler threw on ${method}, using fail-closed answer: ${err?.message ?? err}`);
        }
      }
      try {
        this.respond(payload.id, result);
      } catch (err) {
        this.log(`failed to answer ${method}: ${err?.message ?? err}`);
        return;
      }
      this.emit("serverRequest", { method, params: payload.params, id: payload.id, answered: result });
      if (isApprovalRequest(method)) {
        this.emit("approval", { method, params: payload.params, decision: result });
      }
      return;
    }

    // Notification.
    if (method) {
      this.emit("notification", method, payload.params);
      this.emit(method, payload.params);
    }
  }

  close() {
    this.#closed = true;
    try {
      this.#ws?.close();
    } catch {
      /* already gone */
    }
  }
}
