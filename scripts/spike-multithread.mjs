// Spike: with two live threads, does say() still return only ITS thread's reply?
//
// The old filter treated any notification without a threadId as its own, which
// is correct with one thread and wrong with two — the other session's text
// would be spliced into the answer. This runs both threads at once and checks
// that each reply comes back clean.
//
// Safe by construction: read-only sandbox, approvals never, prompts that only
// ask for a word back.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerClient } from "../src/appServerWsClient.mjs";
import { say, listThreads, describeThreads } from "../src/bridge.mjs";
import { startAppServer, scoreboard, samePath } from "./_harness.mjs";

const TURN_TIMEOUT_MS = 180_000;
const { record, report } = scoreboard();

const main = async () => {
  const cwdA = mkdtempSync(join(tmpdir(), "codex-bridge-A-"));
  const cwdB = mkdtempSync(join(tmpdir(), "codex-bridge-B-"));
  const { url, stop } = await startAppServer({ cwd: cwdA });

  try {
    // Two "TUI" windows, each on its own thread in its own workspace.
    const tui = new CodexAppServerClient({ url, clientName: "spike-tui" });
    await tui.connect();

    const mk = async (cwd) => {
      const started = await tui.request("thread/start", {
        cwd, sandbox: "read-only", approvalPolicy: "never",
      });
      const id = started?.thread?.id;
      // A thread does not materialize until its first turn has FINISHED — not
      // merely started. Until then `thread/resume` answers "no rollout found",
      // and a bridge that skipped this wait would look like a filtering bug.
      const settled = new Promise((resolve) => {
        const onDone = (params) => {
          if (params?.threadId !== id) return;
          tui.off("turn/completed", onDone);
          resolve(true);
        };
        tui.on("turn/completed", onDone);
        setTimeout(() => resolve(false), TURN_TIMEOUT_MS);
      });
      await tui.request("turn/start", {
        threadId: id,
        input: [{ type: "text", text: "Reply with exactly the single word: READY" }],
      }, TURN_TIMEOUT_MS);
      if (!(await settled)) throw new Error(`thread ${id} never finished its first turn`);
      return id;
    };

    const threadA = await mk(cwdA);
    const threadB = await mk(cwdB);
    record("two threads live at once", threadA !== threadB, `${threadA} / ${threadB}`);

    // --- the bridge, as Claude Code drives it ------------------------------
    const bridge = new CodexAppServerClient({
      url, clientName: "claude-code", log: (m) => console.log(`[bridge] ${m}`),
    });
    await bridge.connect();

    const ids = await listThreads(bridge);
    record("bridge sees both threads", ids.includes(threadA) && ids.includes(threadB),
      `loaded=${ids.length}`);

    const described = await describeThreads(bridge);
    const byId = Object.fromEntries(described.map((t) => [t.id, t]));
    record("each thread reports its own cwd (how a human tells them apart)",
      samePath(byId[threadA]?.cwd, cwdA) && samePath(byId[threadB]?.cwd, cwdB),
      described.map((t) => `${t.id.slice(0, 8)}=${t.cwd ?? "?"}`).join("  "));

    // Both turns in flight simultaneously: whatever ordering the server picks,
    // neither reply may contain the other's word.
    const [resA, resB] = await Promise.all([
      say(bridge, {
        threadId: threadA,
        text: "Reply with exactly the single word: ALPHA",
        timeoutMs: TURN_TIMEOUT_MS,
      }),
      say(bridge, {
        threadId: threadB,
        text: "Reply with exactly the single word: BRAVO",
        timeoutMs: TURN_TIMEOUT_MS,
      }),
    ]);

    record("say() on thread A returns A's reply, uncontaminated",
      /ALPHA/.test(resA.reply) && !/BRAVO/.test(resA.reply), JSON.stringify(resA.reply));
    record("say() on thread B returns B's reply, uncontaminated",
      /BRAVO/.test(resB.reply) && !/ALPHA/.test(resB.reply), JSON.stringify(resB.reply));
    record("each call bound itself to a distinct turn",
      Boolean(resA.turnId) && Boolean(resB.turnId) && resA.turnId !== resB.turnId,
      `${resA.turnId} / ${resB.turnId}`);
    record("turn/completed was matched per thread",
      resA.turn?.threadId === threadA && resB.turn?.threadId === threadB,
      `${resA.turn?.threadId} / ${resB.turn?.threadId}`);

    tui.close();
    bridge.close();
  } catch (err) {
    record("spike completed without throwing", false, err?.message ?? String(err));
  } finally {
    stop();
  }

  report();
};

main();
