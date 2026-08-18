// Spike: who answers an approval request when two clients share one thread?
//
// The bridge stays silent on approvals so the human's Codex TUI is the one that
// decides. That only works if the app-server broadcasts the request to every
// attached client and takes the first answer. This proves (or kills) that
// assumption without needing a real TUI: client A stands in for the human's
// window, client B for Claude Code.
//
// It also pins down what serve.mjs --cwd relies on: a thread inherits the
// app-server's working directory unless `thread/start` names its own.
//
// Safety: the only thing it ever asks for is a small file in a fresh temp
// directory, under a read-only sandbox, so writing it REQUIRES an approval.
//
// Note: raising an approval at all needs a working OS sandbox. Where the
// sandbox helper cannot launch — a locked-down corporate Windows box, say —
// every write fails before anyone is asked, and the routing checks are reported
// as skipped rather than failed. Run this on a machine with a working sandbox
// (macOS or Linux will do) to actually settle the question.
//
// The spike's own app-server is started with the user's approval machinery
// switched off, because two ambient settings can otherwise answer the approval
// before any client sees it and make the result meaningless:
//   - a `PermissionRequest` hook in ~/.codex/hooks.json (measured on macOS:
//     with the hook live, zero approvals reach any client);
//   - `approvals_reviewer = "auto_review"`, which hands the decision to a
//     subagent instead of the humans.
// Both are legitimate user choices — see README for what they mean for the
// bridge in day-to-day use — but they are not what this spike is measuring.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerClient, IGNORE_REQUEST } from "../src/appServerWsClient.mjs";
import { acceptFor } from "../src/approvals.mjs";
import { startAppServer, scoreboard, samePath } from "./_harness.mjs";

const TURN_TIMEOUT_MS = 180_000;
const APPROVAL_WAIT_MS = 150_000;
const { record, skip, report } = scoreboard();

const main = async () => {
  const serverCwd = mkdtempSync(join(tmpdir(), "codex-bridge-spike-"));
  const otherCwd = mkdtempSync(join(tmpdir(), "codex-bridge-other-"));
  const srv = await startAppServer({
    cwd: serverCwd,
    extraArgs: ["--disable", "hooks", "-c", "approvals_reviewer=user"],
  });

  try {
    // --- client A: stand-in for the human's TUI ----------------------------
    const approvalsAtA = [];
    const a = new CodexAppServerClient({
      url: srv.url,
      clientName: "spike-tui",
      log: (m) => console.log(`[A] ${m}`),
      onServerRequest: ({ method, params }) => {
        approvalsAtA.push({ method, params });
        console.log(`[A] approving ${method}`);
        return acceptFor(method);
      },
    });
    await a.connect();

    // --- cwd: inherited by default, overridable per thread -----------------
    const defaulted = await a.request("thread/start", { sandbox: "read-only", approvalPolicy: "never" });
    record("thread cwd defaults to the app-server's own cwd",
      samePath(defaulted?.cwd, serverCwd), `thread cwd=${defaulted?.cwd}`);

    const overridden = await a.request("thread/start", {
      cwd: otherCwd, sandbox: "read-only", approvalPolicy: "never",
    });
    record("thread/start cwd overrides it",
      samePath(overridden?.cwd, otherCwd), `thread cwd=${overridden?.cwd}`);

    // --- the shared thread the approval test runs on -----------------------
    const started = await a.request("thread/start", {
      cwd: serverCwd,
      // read-only + on-request is what forces an approval: the model has to ask
      // before it can write anything.
      sandbox: "read-only",
      approvalPolicy: "on-request",
      // Belt and braces with the server's `-c approvals_reviewer=user`: pin the
      // reviewer to the human on the thread itself too.
      approvalsReviewer: "user",
    });
    const threadId = started?.thread?.id;
    record("thread/start for the shared thread", Boolean(threadId), `threadId=${threadId}`);
    if (!threadId) throw new Error("no threadId");

    const awaitTurn = (client) =>
      new Promise((resolve) => {
        const onTurn = (params) => {
          if (params?.threadId !== threadId) return;
          client.off("turn/completed", onTurn);
          resolve(params);
        };
        client.on("turn/completed", onTurn);
        setTimeout(() => resolve(null), TURN_TIMEOUT_MS);
      });

    // A thread is not resumable until its first turn has FINISHED.
    const firstDone = awaitTurn(a);
    await a.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "Reply with exactly the single word: PONG" }],
    }, TURN_TIMEOUT_MS);
    record("first turn completes (thread materialized)", Boolean(await firstDone));

    // --- client B: stand-in for Claude Code, defers every approval ---------
    const deferredAtB = [];
    const resolvedAtB = [];
    const b = new CodexAppServerClient({
      url: srv.url,
      clientName: "spike-bridge",
      log: (m) => console.log(`[B] ${m}`),
      onServerRequest: ({ method, params, id }) => {
        deferredAtB.push({ method, params, id });
        console.log(`[B] deferring ${method} (id=${id})`);
        return IGNORE_REQUEST;
      },
    });
    await b.connect();
    b.on("serverRequest/resolved", (params) => resolvedAtB.push(params));

    // A second client only hears a thread's stream once it has joined it;
    // connecting to the endpoint is not enough.
    let rejoined = null;
    try {
      rejoined = await b.request("thread/resume", { threadId });
    } catch (err) {
      console.log(`[B] thread/resume failed: ${err?.message ?? err}`);
    }
    record("bridge client rejoins the running thread", rejoined?.thread?.id === threadId,
      `got=${rejoined?.thread?.id ?? "(failed)"}`);

    // Does the stream carry the ids say() binds on?
    const idsSeen = { threadId: 0, turnId: 0, neither: 0 };
    const methodsAtB = new Set();
    b.on("notification", (method, params) => {
      methodsAtB.add(method);
      if (!method.startsWith("turn/") && !method.startsWith("item/")) return;
      if (params?.threadId !== undefined) idsSeen.threadId++;
      else if (params?.turnId !== undefined) idsSeen.turnId++;
      else idsSeen.neither++;
    });

    // --- the decisive test: B starts a turn that needs approval ------------
    const sawApprovalAtA = new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), APPROVAL_WAIT_MS);
      const tick = setInterval(() => {
        if (approvalsAtA.length) { clearInterval(tick); clearTimeout(t); resolve(true); }
      }, 100);
      tick.unref?.();
    });

    const bTurnDone = awaitTurn(b);
    const turnStart = await b.request("turn/start", {
      threadId,
      input: [{
        type: "text",
        text: "Create a file named spike.txt in the working directory whose entire contents are "
          + "the single line SPIKE-OK. Then reply with exactly the single word: DONE",
      }],
    }, TURN_TIMEOUT_MS);

    const turnId = turnStart?.turn?.id;
    record("turn/start returns a turn id (what say() binds the stream to)",
      typeof turnId === "string" && turnId.length > 0, `turnId=${turnId}`);

    const routed = await sawApprovalAtA;
    const completed = await bTurnDone;

    // Distinguish "no approval was raised" from "approvals do not route".
    const blocked = !routed && srv.sandboxUnavailable();
    const why = "this machine's OS sandbox helper cannot launch, so every write "
      + "fails before anyone is asked for approval";

    if (blocked) {
      skip("approval request reaches the OTHER client (the TUI stand-in)", why);
      skip("bridge client also receives it, so silence is a real choice", why);
      skip("deferring client is told the request was resolved elsewhere", why);
    } else {
      record("approval request reaches the OTHER client (the TUI stand-in)", routed,
        routed ? approvalsAtA.map((x) => x.method).join(", ") : "A never saw an approval request");
      record("bridge client also receives it, so silence is a real choice",
        deferredAtB.length > 0, `B deferred ${deferredAtB.length}`);
      record("deferring client is told the request was resolved elsewhere",
        resolvedAtB.length > 0, `serverRequest/resolved x${resolvedAtB.length}`);
    }

    record("turn completes rather than hanging on the deferred approval",
      Boolean(completed), completed ? `status=${completed?.turn?.status ?? "?"}` : "timed out");

    record("turn/item notifications carry threadId",
      idsSeen.threadId > 0 && idsSeen.neither === 0,
      `withThreadId=${idsSeen.threadId} turnIdOnly=${idsSeen.turnId} neither=${idsSeen.neither}`);
    console.log(`\n[B] notification methods heard: ${[...methodsAtB].join(", ") || "(none)"}`);

    a.close();
    b.close();
  } catch (err) {
    record("spike completed without throwing", false, err?.message ?? String(err));
  } finally {
    srv.stop();
  }

  report();
};

main();
