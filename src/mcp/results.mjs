import { normalizeError } from "./errors.mjs";

const shortJson = (value) => JSON.stringify(value);

export function successResult(data, { warnings = [], summary = "Operation completed." } = {}) {
  const structuredContent = { ok: true, data, warnings };
  return {
    content: [{ type: "text", text: summary }],
    structuredContent,
  };
}
export function failureResult(error, fallbackCode) {
  const normalized = normalizeError(error, fallbackCode);
  const structuredContent = {
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
      details: normalized.details ?? {},
    },
  };
  return {
    isError: true,
    content: [{ type: "text", text: `${normalized.code}: ${normalized.message}` }],
    structuredContent,
  };
}

export const summarize = (label, value) => `${label}: ${typeof value === "string" ? value : shortJson(value)}`;

export function wrapTool(handler, fallbackCode = "INTERNAL_ERROR") {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return failureResult(error, fallbackCode);
    }
  };
}
