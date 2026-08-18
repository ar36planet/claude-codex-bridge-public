// Approval policies for server->client requests.
//
// The app-server fans an approval request out to EVERY attached client and
// takes whichever answer arrives first; the clients that lost the race then
// receive a `serverRequest/resolved` notification. That is what makes "hand the
// decision to the human" implementable at all: this client simply says nothing
// and the Codex TUI's own prompt is the one that resolves it.
//
// Staying silent forever would hang the turn if nobody is watching, so `defer`
// arms a deadline and answers fail-closed once it lapses.

import { IGNORE_REQUEST, DEFAULT_SERVER_REQUEST_RESPONSES, isApprovalRequest } from "./appServerWsClient.mjs";

export const DEFAULT_DEFER_MS = 300_000;

/** Human-readable one-liner for an approval request, for logs and prompts. */
export function describeApproval({ method, params }) {
  if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
    const cmd = params?.command ?? (Array.isArray(params?.command) ? params.command.join(" ") : null);
    return `run: ${cmd ?? "(command not reported)"}${params?.cwd ? `  [cwd ${params.cwd}]` : ""}`;
  }
  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
    return `edit files${params?.grantRoot ? ` under ${params.grantRoot}` : ""}${params?.reason ? ` — ${params.reason}` : ""}`;
  }
  if (method === "item/permissions/requestApproval") {
    return `extra permissions${params?.reason ? ` — ${params.reason}` : ""}`;
  }
  return method;
}

/**
 * Build an `onServerRequest` handler.
 *
 * mode:
 *  - "tui"     (default) stay silent on approvals so the human's TUI decides;
 *              fail closed if nothing resolves it within `deferMs`.
 *  - "decline" answer fail-closed immediately — the old behaviour, useful when
 *              no TUI is attached and a hung turn is worse than a refused one.
 *  - "accept"  approve everything. Only for a sandbox you already trust; the
 *              caller has to opt in explicitly.
 *
 * Non-approval server requests (tool calls, elicitations) always take the
 * fail-closed default: this bridge has no UI to answer them with.
 */
export function makeApprovalHandler({
  mode = "tui",
  deferMs = DEFAULT_DEFER_MS,
  log = () => {},
  // Called only for requests this handler leaves unanswered, so the caller can
  // arm a fallback. Anything already answered here must NOT be reported, or the
  // fallback would send a second response for the same id.
  onDeferred = null,
} = {}) {
  return ({ method, params, id }) => {
    if (!isApprovalRequest(method)) return DEFAULT_SERVER_REQUEST_RESPONSES[method] ?? {};

    const what = describeApproval({ method, params });

    if (mode === "accept") {
      log(`approval auto-accepted: ${what}`);
      return acceptFor(method);
    }
    if (mode === "decline") {
      log(`approval auto-declined: ${what}`);
      return DEFAULT_SERVER_REQUEST_RESPONSES[method] ?? {};
    }

    // "tui": say nothing and let the human's window answer. Fail closed if the
    // deadline passes so the turn cannot wedge forever.
    log(`approval deferred to the TUI (${Math.round(deferMs / 1000)}s): ${what}`);
    onDeferred?.({ method, params, id });
    return IGNORE_REQUEST;
  };
}

/** The "yes" answer for each method — shapes differ per method, like the refusals do. */
export function acceptFor(method) {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "accept" };
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: "approved" };
    case "item/permissions/requestApproval":
      // An empty profile grants nothing; there is no blanket "all permissions"
      // literal, so accepting here still means "no extra permissions".
      return { permissions: {}, scope: "turn" };
    default:
      return DEFAULT_SERVER_REQUEST_RESPONSES[method] ?? {};
  }
}

/**
 * Track deferred approvals so a turn cannot hang when no TUI answers.
 *
 * Call `watch()` for each request left unanswered and `resolved()` when a
 * `serverRequest/resolved` notification names it. Anything still outstanding at
 * the deadline is answered fail-closed by this client.
 */
export function createDeferTracker({ client, deferMs = DEFAULT_DEFER_MS, log = () => {} }) {
  const open = new Map();

  const watch = ({ method, params, id }) => {
    if (id === undefined || id === null) return;
    const timer = setTimeout(() => {
      open.delete(id);
      log(`no client answered ${method} within ${deferMs}ms — declining so the turn can continue`);
      try {
        client.respond(id, DEFAULT_SERVER_REQUEST_RESPONSES[method] ?? {});
      } catch (err) {
        log(`could not decline stale ${method}: ${err?.message ?? err}`);
      }
    }, deferMs);
    timer.unref?.();
    open.set(id, { timer, method, params });
  };

  const resolved = (requestId) => {
    const entry = open.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    open.delete(requestId);
    log(`${entry.method} was answered by another client (the TUI)`);
    return true;
  };

  const dispose = () => {
    for (const { timer } of open.values()) clearTimeout(timer);
    open.clear();
  };

  return { watch, resolved, dispose, get size() { return open.size; } };
}
