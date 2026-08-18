// Task-level helpers over the raw app-server client: find the live thread the
// human's TUI is attached to, and hold a conversation on it.

import { readFileSync } from "node:fs";
import { CodexAppServerClient } from "./appServerWsClient.mjs";
import { makeApprovalHandler, createDeferTracker, DEFAULT_DEFER_MS } from "./approvals.mjs";

export const STATE_FILE = new URL("../.bridge.json", import.meta.url);

/** Endpoint written by scripts/serve.mjs, overridable via CODEX_BRIDGE_URL. */
export function bridgeUrl() {
  if (process.env.CODEX_BRIDGE_URL) return process.env.CODEX_BRIDGE_URL;
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")).url;
  } catch {
    throw new Error("no app-server endpoint: run `node scripts/serve.mjs` first, or set CODEX_BRIDGE_URL");
  }
}

/**
 * Connect and wire up approval handling.
 *
 * `approvals` picks who decides when Codex asks permission to run something:
 * "tui" (default) leaves the request unanswered so the human's window resolves
 * it, "decline" refuses immediately, "accept" allows everything.
 */
export async function connect({
  url = bridgeUrl(),
  log = null,
  approvals = process.env.CODEX_BRIDGE_APPROVALS ?? "tui",
  deferMs = Number(process.env.CODEX_BRIDGE_APPROVAL_TIMEOUT_MS ?? DEFAULT_DEFER_MS),
} = {}) {
  const say = log ?? (() => {});
  let tracker = null;

  const client = new CodexAppServerClient({
    url,
    clientName: "claude-code",
    log,
    onServerRequest: makeApprovalHandler({
      mode: approvals,
      deferMs,
      log: say,
      // Staying quiet is only safe because something eventually answers; arm
      // the fallback the moment we decide to. `tracker` is assigned just below,
      // before any request can arrive.
      onDeferred: (req) => tracker?.watch(req),
    }),
  });

  await client.connect();

  if (approvals === "tui") {
    tracker = createDeferTracker({ client, deferMs, log: say });
    client.on("serverRequest/resolved", (params) => tracker.resolved(params?.requestId));
    client.on("close", () => tracker.dispose());
  }
  client.approvals = approvals;
  return client;
}

/** Thread ids currently live in the server (i.e. what the TUI has open). */
export async function listThreads(client) {
  const res = await client.request("thread/loaded/list", {});
  return (res?.data ?? []).map((t) => (typeof t === "string" ? t : t?.id));
}

/**
 * Thread ids plus whatever metadata the server will part with. `thread/read`
 * can fail on TUI-created threads, so a thread that will not describe itself
 * still shows up — with a bare id — rather than disappearing from the list.
 */
export async function describeThreads(client) {
  const ids = await listThreads(client);
  return Promise.all(ids.map(async (id) => {
    try {
      const t = await client.request("thread/read", { threadId: id });
      const thread = t?.thread ?? t;
      return { id, cwd: thread?.cwd ?? null, name: thread?.name ?? null };
    } catch (err) {
      return { id, cwd: null, name: null, error: err?.message ?? String(err) };
    }
  }));
}

/**
 * Resolve which thread to talk to. With one live thread, that one; with several,
 * the caller must be explicit rather than us guessing at someone else's session.
 */
export async function resolveThread(client, threadId = null) {
  if (threadId) return threadId;
  const ids = await listThreads(client);
  if (ids.length === 1) return ids[0];
  if (ids.length === 0) {
    throw new Error("no live threads — is the TUI attached, and has it sent at least one message?");
  }
  const described = await describeThreads(client);
  const lines = described.map((t) => `  ${t.id}${t.cwd ? `  (${t.cwd})` : ""}`).join("\n");
  throw new Error(`${ids.length} live threads; pass one explicitly:\n${lines}`);
}

/**
 * Join a running thread so its notifications reach us.
 *
 * For a running thread `thread/resume` means "rejoin", not "reload from disk" —
 * that subscription is what makes the stream arrive at all. It fails on threads
 * the TUI created (`historyMode: "paginated"` → "list_turns is not supported
 * yet"), so failure is reported, not fatal: turn/start alone still gets us most
 * of the stream.
 */
export async function join(client, threadId) {
  try {
    await client.request("thread/resume", { threadId });
    return true;
  } catch (err) {
    // Worth saying out loud: without the subscription, a missing reply later on
    // is this, not a slow model.
    client.log?.(`thread/resume failed for ${threadId} (${err?.message ?? err}) — `
      + "continuing without a subscription; the stream may be incomplete");
    return false;
  }
}

/**
 * Send a message into a live thread and wait for the reply.
 *
 * Every turn/item notification carries `threadId`, and the streaming ones also
 * carry `turnId`, so a reply can be pinned to exactly the turn we started even
 * when the human is typing into another thread at the same time. The one gap is
 * the window before `turn/start` returns our turnId: deltas can already be
 * arriving, so they are buffered with their own turnId and filtered once ours
 * is known.
 */
export async function say(client, {
  threadId,
  text,
  timeoutMs = 300_000,
  onDelta = null,
  cwd = null,
  signal = null,
  collector = null,
  prePinMaxBytes = 65_536,
  maxReplyBytes = 10_485_760,
}) {
  if (signal?.aborted) throw abortedError();
  const deadline = Date.now() + timeoutMs;
  const joined = await join(client, threadId);

  let turnId = null;
  let pinned = false;
  let prePinBytes = 0;
  let prePinTruncated = false;
  const prePin = [];
  const prePinDroppedBytes = new Map();
  const pendingCompletions = [];
  const seen = [];
  const replyChunks = [];
  let replyBytes = 0;
  let replyTruncated = false;
  let resolveDone = null;

  let soleThread = false;
  try {
    soleThread = (await listThreads(client)).length <= 1;
  } catch {
    /* listing is a nicety; thread/turn ids below carry the weight */
  }

  const sameThread = (params) => {
    if (params?.threadId !== undefined) return params.threadId === threadId;
    return soleThread;
  };
  const completionTurnId = (params) => params?.turn?.id ?? params?.turnId ?? null;
  const isOurCompletion = (params) => {
    if (!sameThread(params)) return false;
    const candidate = completionTurnId(params);
    return !candidate || candidate === turnId;
  };

  const trace = (method, params) => {
    seen.push(method);
    if (process.env.CODEX_BRIDGE_DEBUG) {
      process.stderr.write(`\n[notif] ${method}${params?.turnId ? ` turn=${params.turnId}` : ""}`);
    }
  };

  const appendReply = (delta) => {
    collector?.append(delta);
    if (!collector && !replyTruncated) {
      const remaining = maxReplyBytes - replyBytes;
      const accepted = takeUtf8(delta, remaining);
      if (accepted) {
        replyChunks.push(accepted);
        replyBytes += Buffer.byteLength(accepted, "utf8");
      }
      if (Buffer.byteLength(delta, "utf8") > Buffer.byteLength(accepted, "utf8")) replyTruncated = true;
    }
    onDelta?.(delta);
  };

  const onAgentDelta = (params) => {
    if (!sameThread(params)) return;
    const delta = String(params?.delta ?? "");
    if (!delta) return;

    if (!pinned) {
      const remaining = prePinMaxBytes - prePinBytes;
      const accepted = takeUtf8(delta, remaining);
      if (accepted) {
        prePin.push({ turnId: params?.turnId ?? null, delta: accepted });
        prePinBytes += Buffer.byteLength(accepted, "utf8");
      }
      if (Buffer.byteLength(delta, "utf8") > Buffer.byteLength(accepted, "utf8")) {
        const key = params?.turnId ?? null;
        const dropped = Buffer.byteLength(delta, "utf8") - Buffer.byteLength(accepted, "utf8");
        prePinDroppedBytes.set(key, (prePinDroppedBytes.get(key) ?? 0) + dropped);
      }
      return;
    }

    if (params?.turnId !== undefined && params.turnId !== turnId) return;
    appendReply(delta);
  };

  const onDone = (params) => {
    if (!sameThread(params)) return;
    if (!pinned || !resolveDone) {
      if (pendingCompletions.length < 100) pendingCompletions.push(params);
      return;
    }
    if (isOurCompletion(params)) resolveDone(params);
  };

  const cleanup = () => {
    client.off("turn/completed", onDone);
    client.off("item/agentMessage/delta", onAgentDelta);
    client.off("notification", trace);
  };

  client.on("notification", trace);
  client.on("item/agentMessage/delta", onAgentDelta);
  client.on("turn/completed", onDone);

  let started;
  try {
    started = await client.request("turn/start", {
      threadId,
      input: [{ type: "text", text }],
      ...(cwd ? { cwd } : {}),
    }, Math.max(1, deadline - Date.now()));
  } catch (error) {
    cleanup();
    throw error;
  }

  turnId = started?.turn?.id ?? null;
  collector?.setContext?.({ threadId, turnId });
  for (const chunk of prePin) {
    if (!turnId || chunk.turnId === null || chunk.turnId === turnId) appendReply(chunk.delta);
  }
  const droppedForTurn = (prePinDroppedBytes.get(turnId) ?? 0) + (prePinDroppedBytes.get(null) ?? 0);
  if (droppedForTurn > 0) {
    prePinTruncated = true;
    replyTruncated = true;
    collector?.noteUncapturedBytes?.(droppedForTurn);
  }
  pinned = true;

  try {
    const alreadyDone = pendingCompletions.find(isOurCompletion);
    const turn = alreadyDone ?? await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolveDone = null;
        fn(value);
      };
      resolveDone = (value) => finish(resolve, value);
      const onAbort = () => finish(reject, abortedError());
      const timer = setTimeout(() => {
        const error = new Error(
          `turn did not complete within ${timeoutMs}ms; heard: ${[...new Set(seen)].join(", ") || "(nothing)"}`,
        );
        error.code = "TURN_TIMEOUT";
        error.threadId = threadId;
        error.turnId = turnId;
        error.started = true;
        finish(reject, error);
      }, Math.max(1, deadline - Date.now()));
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });

    const reply = collector ? null : replyChunks.join("").trim();
    return {
      reply,
      replyTruncated: replyTruncated || prePinTruncated,
      turn,
      turnId,
      joined,
      prePinTruncated,
    };
  } finally {
    cleanup();
  }
}

const takeUtf8 = (value, maxBytes) => {
  if (maxBytes <= 0) return "";
  let result = "";
  let size = 0;
  for (const char of String(value ?? "")) {
    const bytes = Buffer.byteLength(char, "utf8");
    if (size + bytes > maxBytes) break;
    result += char;
    size += bytes;
  }
  return result;
};

const abortedError = () => {
  const error = new Error("operation cancelled");
  error.name = "AbortError";
  return error;
};

/** Full thread contents, including turn history. */
export async function read(client, threadId) {
  // includeTurns hits the same unsupported list_turns path on paginated threads.
  try {
    return await client.request("thread/read", { threadId, includeTurns: true });
  } catch {
    return client.request("thread/read", { threadId });
  }
}
