export class BridgeToolError extends Error {
  constructor(code, message, { retryable = false, details = {}, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "BridgeToolError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}
export const toolError = (code, message, options) => new BridgeToolError(code, message, options);

export function normalizeError(error, fallbackCode = "INTERNAL_ERROR") {
  if (error instanceof BridgeToolError) return error;
  if (error?.name === "AbortError") {
    return new BridgeToolError("CANCELLED", "The operation was cancelled.", {
      retryable: false,
      cause: error,
    });
  }
  return new BridgeToolError(fallbackCode, error?.message ?? String(error), {
    retryable: false,
    cause: error,
  });
}
