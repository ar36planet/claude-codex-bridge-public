const decoder = new TextDecoder("utf-8", { fatal: true });

export const utf8Bytes = (value) => Buffer.byteLength(String(value ?? ""), "utf8");

export function utf8PrefixBuffer(value, maxBytes) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ""), "utf8");
  if (input.length <= maxBytes) return input;
  let end = Math.max(0, maxBytes);
  while (end > 0) {
    try {
      decoder.decode(input.subarray(0, end));
      return input.subarray(0, end);
    } catch {
      end -= 1;
    }
  }
  return Buffer.alloc(0);
}
export function utf8SuffixBuffer(value, maxBytes) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ""), "utf8");
  if (input.length <= maxBytes) return input;
  let start = Math.max(0, input.length - maxBytes);
  while (start < input.length && (input[start] & 0xc0) === 0x80) start += 1;
  return input.subarray(start);
}

export const truncateUtf8 = (value, maxBytes) => utf8PrefixBuffer(value, maxBytes).toString("utf8");
export const truncateUtf8Tail = (value, maxBytes) => utf8SuffixBuffer(value, maxBytes).toString("utf8");

export function boundedPreview(head, tail, { headBytes = 8_192, tailBytes = 8_192 } = {}) {
  const first = truncateUtf8(head, headBytes);
  const last = truncateUtf8Tail(tail, tailBytes);
  if (!last || first === last) return first;
  return `${first}\n\n… output omitted …\n\n${last}`;
}
