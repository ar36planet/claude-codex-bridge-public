import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PACKAGE = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

const intSetting = (env, name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
};

export function resolveRole(argv = process.argv.slice(2), env = process.env) {
  const index = argv.indexOf("--role");
  const value = index === -1 ? env.CODEX_BRIDGE_MCP_ROLE : argv[index + 1];
  if (value !== "claude" && value !== "codex") {
    throw new Error("MCP role is required: pass --role claude or --role codex");
  }
  return value;
}
export function loadMcpConfig({ role, env = process.env } = {}) {
  if (role !== "claude" && role !== "codex") throw new Error(`invalid MCP role: ${role}`);

  const approvalMode = env.CODEX_BRIDGE_APPROVALS ?? "tui";
  if (approvalMode !== "tui" && approvalMode !== "decline") {
    throw new Error("MCP only permits CODEX_BRIDGE_APPROVALS=tui or decline");
  }

  const maxInlineBytes = intSetting(env, "CODEX_BRIDGE_MCP_MAX_INLINE_BYTES", 65_536, {
    min: 4_096,
    max: 262_144,
  });
  const maxPageBytes = intSetting(env, "CODEX_BRIDGE_MCP_MAX_PAGE_BYTES", 65_536, {
    min: 1_024,
    max: 262_144,
  });
  const defaultPageBytes = intSetting(env, "CODEX_BRIDGE_MCP_PAGE_BYTES", 16_384, {
    min: 1_024,
    max: maxPageBytes,
  });

  return {
    version: PACKAGE.version,
    role,
    transport: "stdio",
    logLevel: env.CODEX_BRIDGE_MCP_LOG_LEVEL ?? "warn",
    approvalMode,
    approvalDeferMs: intSetting(env, "CODEX_BRIDGE_APPROVAL_TIMEOUT_MS", 300_000, {
      min: 1_000,
      max: 3_600_000,
    }),
    maxTextLength: intSetting(env, "CODEX_BRIDGE_MCP_MAX_TEXT_LENGTH", 200_000, {
      min: 1,
      max: 2_000_000,
    }),
    queueWaitMs: intSetting(env, "CODEX_BRIDGE_MCP_QUEUE_WAIT_MS", 300_000, {
      min: 1_000,
      max: 3_600_000,
    }),
    output: {
      root: env.CODEX_BRIDGE_OUTPUT_DIR
        ?? fileURLToPath(new URL("../../.bridge-output", import.meta.url)),
      maxInlineBytes,
      defaultPageBytes,
      maxPageBytes,
      maxCaptureBytes: intSetting(env, "CODEX_BRIDGE_MCP_MAX_CAPTURE_BYTES", 10_485_760, {
        min: 1_048_576,
        max: 104_857_600,
      }),
      maxDirectoryBytes: intSetting(env, "CODEX_BRIDGE_MCP_MAX_OUTPUT_DIR_BYTES", 104_857_600, {
        min: 10_485_760,
        max: 1_073_741_824,
      }),
      ttlMs: intSetting(env, "CODEX_BRIDGE_MCP_ARTIFACT_TTL_HOURS", 24, {
        min: 1,
        max: 168,
      }) * 3_600_000,
      stalePartMs: intSetting(env, "CODEX_BRIDGE_MCP_STALE_PART_HOURS", 2, {
        min: 1,
        max: 168,
      }) * 3_600_000,
      previewHeadBytes: Math.min(8_192, Math.floor(maxInlineBytes / 4)),
      previewTailBytes: Math.min(8_192, Math.floor(maxInlineBytes / 4)),
    },
  };
}
