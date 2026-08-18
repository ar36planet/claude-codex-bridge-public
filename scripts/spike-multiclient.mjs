// Make-or-break spike: can two independent clients share ONE live app-server
// thread, and does a turn started by client B stream to client A?
//
// That property is what makes the whole design work: the Codex TUI attaches via
// `codex --remote ws://...` as one client (the human watches it), and this
// bridge attaches as a second client to drive the same thread. If B's turn does
// not stream to A, the human sees nothing and the design collapses.
//
// Safe by construction: sandbox read-only, approvalPolicy never, trivial prompt.

import { CodexAppServerClient } from "../src/appServerWsClient.mjs";
import { startAppServer, scoreboard } from "./_harness.mjs";

const TURN_TIMEOUT_MS = 120_000;
const { record, report } = scoreboard();

const main = async () => {
  const { url, stop: cleanup } = await startAppServer();
  console.log(`# app-server on ${url}\n`);

  try {
    // --- client A: the stand-in for the human's TUI ------------------------
    const a = new CodexAppServerClient({ url, clientName: "spike-A", log: (m) => console.log(`[A] ${m}`) });
    await a.connect();
    record("client A initialize", true, `codexHome=${a.serverInfo?.codexHome ?? "?"}`);

    const started = await a.request("thread/start", {
      cwd: process.cwd(),
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    const threadId = started?.thread?.id;
    record("client A thread/start", Boolean(threadId), `threadId=${threadId}`);
    if (!threadId) throw new Error("no threadId");

    // Capture everything A hears, so we can prove B's turn reaches A.
    const aHeard = [];
    a.on("notification", (method, params) => {
      if (params?.threadId === threadId || method.startsWith("turn/") || method.startsWith("item/")) {
        aHeard.push(method);
      }
    });

    const awaitTurnOn = (client, tag) =>
      new Promise((resolve) => {
        const onTurn = (params) => {
          if (params?.threadId === threadId) { client.off("turn/completed", onTurn); resolve(tag); }
        };
        client.on("turn/completed", onTurn);
        setTimeout(() => resolve("timeout"), TURN_TIMEOUT_MS);
      });

    // A thread is not "materialized" until its first user message, so send one
    // from A before any listing/reading can work. This also mirrors reality:
    // the human has talked to Codex before the bridge joins.
    const aTurnDone = awaitTurnOn(a, "A");
    await a.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "Reply with exactly the single word: PONG" }],
    }, TURN_TIMEOUT_MS);
    record("client A first turn completes (materializes thread)",
      (await aTurnDone) === "A");

    // --- client B: the stand-in for Claude Code ----------------------------
    const b = new CodexAppServerClient({ url, clientName: "spike-B", log: (m) => console.log(`[B] ${m}`) });
    await b.connect();
    record("client B initialize (2nd client, same server)", true);

    const loaded = await b.request("thread/loaded/list", {});
    console.log(`  raw thread/loaded/list = ${JSON.stringify(loaded).slice(0, 400)}`);
    // `data` is an array of bare thread-id strings on codex-cli 0.147.0.
    const list = loaded?.data ?? loaded?.threads ?? loaded?.items ?? [];
    const ids = list.map((t) => (typeof t === "string" ? t : (t?.id ?? t?.thread?.id ?? t?.threadId)));
    record("client B sees A's thread via thread/loaded/list", ids.includes(threadId),
      `loaded=${JSON.stringify(ids)}`);

    const read = await b.request("thread/read", { threadId, includeTurns: true });
    record("client B thread/read on A's thread", Boolean(read),
      `keys=${Object.keys(read ?? {}).join(",")}`);

    const rejoined = await b.request("thread/resume", { threadId });
    record("client B thread/resume rejoins the RUNNING thread",
      rejoined?.thread?.id === threadId, `got=${rejoined?.thread?.id}`);

    // --- the decisive test -------------------------------------------------
    aHeard.length = 0;
    const relayed = awaitTurnOn(a, "A");
    await b.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "Reply with exactly the single word: PING" }],
    }, TURN_TIMEOUT_MS);
    record("client B turn/start on A's thread accepted", true);

    const who = await relayed;
    record("client A RECEIVES the turn B started (live visibility)", who === "A",
      who === "A" ? `A heard ${aHeard.length} notifications` : "A heard nothing before timeout");
    console.log(`
[A] notification methods heard: ${[...new Set(aHeard)].join(", ") || "(none)"}`);

    a.close();
    b.close();
  } catch (err) {
    record("spike completed without throwing", false, err?.message ?? String(err));
  } finally {
    cleanup();
  }

  report();
};

main();
