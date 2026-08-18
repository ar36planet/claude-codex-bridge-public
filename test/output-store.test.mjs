import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutputStore } from "../src/mcp/outputStore.mjs";

const roots = [];
test.afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const makeStore = (overrides = {}) => {
  const root = mkdtempSync(join(tmpdir(), "bridge-output-test-"));
  roots.push(root);
  return new OutputStore({
    root,
    maxInlineBytes: 16,
    maxCaptureBytes: 1_024,
    maxDirectoryBytes: 4_096,
    defaultPageBytes: 7,
    maxPageBytes: 32,
    ttlMs: 60_000,
    stalePartMs: 60_000,
    previewHeadBytes: 8,
    previewTailBytes: 8,
    ...overrides,
  });
};

test("small output stays inline", async () => {
  const store = makeStore();
  const collector = store.createCollector({ kind: "test", ownerRole: "claude" });
  collector.append("hello");
  const result = await collector.finalize();
  assert.equal(result.inline, "hello");
  assert.equal(result.artifact, null);
  assert.equal(result.truncated, false);
});

test("large UTF-8 output becomes a pageable signed artifact", async () => {
  const store = makeStore();
  const source = "甲乙丙丁戊己庚辛壬癸-abcdefghijklmnopqrstuvwxyz";
  const collector = store.createCollector({ kind: "test", ownerRole: "claude" });
  collector.append(source.slice(0, 10));
  collector.append(source.slice(10));
  const result = await collector.finalize();
  assert.ok(result.artifact?.id);
  assert.equal(result.truncated, true);

  let cursor = null;
  let rebuilt = "";
  do {
    const page = await store.read({
      artifactId: result.artifact.id,
      cursor,
      maxBytes: 7,
      ownerRole: "claude",
    });
    rebuilt += page.content;
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(rebuilt, source);

  await assert.rejects(() => store.read({
    artifactId: result.artifact.id,
    cursor: `${result.artifact.nextCursor}x`,
    ownerRole: "claude",
  }), { code: "INVALID_CURSOR" });
  await assert.rejects(() => store.read({
    artifactId: result.artifact.id,
    ownerRole: "codex",
  }), { code: "ARTIFACT_NOT_FOUND" });
});

test("capture limit is explicit and bounded", async () => {
  const store = makeStore({ maxCaptureBytes: 24 });
  const collector = store.createCollector({ kind: "test", ownerRole: "claude" });
  collector.append("0123456789abcdefghijklmnopqrstuvwxyz");
  const result = await collector.finalize();
  assert.equal(result.captureTruncated, true);
  assert.equal(result.capturedBytes, 24);
  assert.ok(result.totalBytes > result.capturedBytes);
});

test("concurrent finalize calls share one artifact finalization", async () => {
  const store = makeStore();
  const collector = store.createCollector({ kind: "test", ownerRole: "claude" });
  collector.append("this output is long enough to spill");
  const [first, second] = await Promise.all([collector.finalize(), collector.finalize()]);
  assert.equal(first.artifact.id, second.artifact.id);
  assert.equal(first.totalBytes, second.totalBytes);
});

test("expired artifacts are rejected and removed", async () => {
  let now = Date.now();
  const store = makeStore({ ttlMs: 10, now: () => now });
  const collector = store.createCollector({ kind: "test", ownerRole: "claude" });
  collector.append("this is longer than inline");
  const result = await collector.finalize();
  now += 11;
  await assert.rejects(() => store.read({
    artifactId: result.artifact.id,
    ownerRole: "claude",
  }), { code: "ARTIFACT_EXPIRED" });
});
