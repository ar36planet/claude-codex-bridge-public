import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { peekLimited, push } from "../src/inbox.mjs";

test("peekLimited bounds returned messages without consuming the mailbox", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bridge-inbox-test-"));
  const previous = process.env.CODEX_BRIDGE_INBOX_DIR;
  process.env.CODEX_BRIDGE_INBOX_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_BRIDGE_INBOX_DIR;
    else process.env.CODEX_BRIDGE_INBOX_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });

  for (let i = 0; i < 5; i += 1) push({ to: "web", text: `message-${i}` });
  const raw = [];
  const result = await peekLimited("web", {
    maxMessages: 2,
    maxBytes: 1_024,
    onRawLine: (line) => raw.push(line),
  });
  assert.equal(result.count, 5);
  assert.equal(result.returned, 2);
  assert.equal(result.truncated, true);
  assert.equal(raw.length, 5);

  const again = await peekLimited("web", { maxMessages: 10, maxBytes: 1_024 });
  assert.equal(again.count, 5);
});
