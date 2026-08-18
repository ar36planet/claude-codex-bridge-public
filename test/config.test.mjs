import test from "node:test";
import assert from "node:assert/strict";
import { loadMcpConfig, resolveRole } from "../src/mcp/config.mjs";

test("resolveRole requires an explicit valid role", () => {
  assert.equal(resolveRole(["--role", "claude"], {}), "claude");
  assert.equal(resolveRole([], { CODEX_BRIDGE_MCP_ROLE: "codex" }), "codex");
  assert.throws(() => resolveRole([], {}), /role is required/);
  assert.throws(() => resolveRole(["--role", "all"], {}), /role is required/);
});
test("MCP config rejects automatic approval acceptance", () => {
  assert.throws(() => loadMcpConfig({
    role: "claude",
    env: { CODEX_BRIDGE_APPROVALS: "accept" },
  }), /only permits/);
});

test("MCP config has bounded output defaults", () => {
  const config = loadMcpConfig({ role: "codex", env: {} });
  assert.equal(config.version, "0.2.0");
  assert.equal(config.output.maxInlineBytes, 65_536);
  assert.equal(config.output.defaultPageBytes, 16_384);
  assert.equal(config.output.maxCaptureBytes, 10_485_760);
});
