import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { BridgeToolError } from "./errors.mjs";
import {
  boundedPreview,
  truncateUtf8,
  truncateUtf8Tail,
  utf8Bytes,
  utf8PrefixBuffer,
} from "./outputBudget.mjs";

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class OutputStore {
  #active = new Set();

  constructor({
    root,
    maxInlineBytes = 65_536,
    maxCaptureBytes = 10_485_760,
    maxDirectoryBytes = 104_857_600,
    defaultPageBytes = 16_384,
    maxPageBytes = 65_536,
    ttlMs = 86_400_000,
    stalePartMs = 7_200_000,
    previewHeadBytes = 8_192,
    previewTailBytes = 8_192,
    now = () => Date.now(),
  }) {
    this.root = resolve(root);
    this.tmpRoot = join(this.root, ".tmp");
    this.maxInlineBytes = maxInlineBytes;
    this.maxCaptureBytes = maxCaptureBytes;
    this.maxDirectoryBytes = maxDirectoryBytes;
    this.defaultPageBytes = defaultPageBytes;
    this.maxPageBytes = maxPageBytes;
    this.ttlMs = ttlMs;
    this.stalePartMs = stalePartMs;
    this.previewHeadBytes = previewHeadBytes;
    this.previewTailBytes = previewTailBytes;
    this.now = now;
  }

  ensure() {
    mkdirSync(this.tmpRoot, { recursive: true });
  }

  createCollector({ kind, ownerRole, ...context }) {
    this.ensure();
    const collector = new OutputCollector(this, { kind, ownerRole, ...context });
    this.#active.add(collector);
    collector.onClosed = () => this.#active.delete(collector);
    return collector;
  }

  async read({ artifactId, cursor = null, maxBytes, ownerRole }) {
    const id = validateId(artifactId);
    const metadata = this.#readMetadata(id);
    if (metadata.ownerRole !== ownerRole) throw artifactNotFound(id);
    if (Date.parse(metadata.expiresAt) <= this.now()) {
      this.#removeArtifact(id);
      throw new BridgeToolError("ARTIFACT_EXPIRED", `Artifact ${id} has expired.`);
    }

    const offset = cursor ? decodeCursor(cursor, metadata) : 0;
    const limit = clampPage(maxBytes ?? this.defaultPageBytes, this.maxPageBytes);
    if (offset < 0 || offset > metadata.capturedBytes) {
      throw new BridgeToolError("INVALID_CURSOR", "Artifact cursor offset is outside the captured output.");
    }

    const contentPath = this.#contentPath(id);
    assertRegularFile(contentPath);
    const handle = await open(contentPath, "r");
    try {
      const remaining = Math.max(0, metadata.capturedBytes - offset);
      const buffer = Buffer.alloc(Math.min(remaining, limit + 4));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      const page = utf8PrefixBuffer(buffer.subarray(0, bytesRead), Math.min(limit, remaining));
      const nextOffset = offset + page.length;
      const eof = nextOffset >= metadata.capturedBytes;
      return {
        artifactId: id,
        kind: metadata.kind,
        content: page.toString("utf8"),
        pageBytes: page.length,
        totalBytes: metadata.totalBytes,
        capturedBytes: metadata.capturedBytes,
        complete: metadata.complete,
        captureTruncated: metadata.captureTruncated,
        cursor: encodeCursor(metadata, offset),
        nextCursor: eof ? null : encodeCursor(metadata, nextOffset),
        eof,
        expiresAt: metadata.expiresAt,
      };
    } finally {
      await handle.close();
    }
  }

  cleanup() {
    if (!existsSync(this.root)) return { removed: 0, bytesFreed: 0 };
    this.ensure();
    const now = this.now();
    let removed = 0;
    let bytesFreed = 0;
    const finalized = [];

    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -5);
      if (!ID_RE.test(id)) continue;
      try {
        const meta = this.#readMetadata(id);
        const size = safeSize(this.#contentPath(id)) + safeSize(this.#metadataPath(id));
        if (Date.parse(meta.expiresAt) <= now) {
          this.#removeArtifact(id);
          removed += 1;
          bytesFreed += size;
        } else {
          finalized.push({ id, createdAt: Date.parse(meta.createdAt), size });
        }
      } catch {
        // Unknown or partially written metadata is left alone for manual inspection.
      }
    }

    if (existsSync(this.tmpRoot)) {
      for (const entry of readdirSync(this.tmpRoot, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".part")) continue;
        const path = join(this.tmpRoot, basename(entry.name));
        try {
          const stat = statSync(path);
          if (now - stat.mtimeMs >= this.stalePartMs) {
            rmSync(path, { force: true });
            removed += 1;
            bytesFreed += stat.size;
          }
        } catch {
          // A racing writer or cleanup process won; nothing else to do.
        }
      }
    }

    let total = finalized.reduce((sum, item) => sum + item.size, 0);
    for (const item of finalized.sort((a, b) => a.createdAt - b.createdAt)) {
      if (total <= this.maxDirectoryBytes) break;
      this.#removeArtifact(item.id);
      total -= item.size;
      removed += 1;
      bytesFreed += item.size;
    }
    return { removed, bytesFreed };
  }

  async closeAll() {
    await Promise.allSettled([...this.#active].map((collector) => collector.finalize({ complete: false })));
  }

  descriptor(metadata) {
    return {
      id: metadata.id,
      kind: metadata.kind,
      capturedBytes: metadata.capturedBytes,
      complete: metadata.complete,
      captureTruncated: metadata.captureTruncated,
      nextCursor: metadata.capturedBytes ? encodeCursor(metadata, 0) : null,
      expiresAt: metadata.expiresAt,
    };
  }

  #readMetadata(id) {
    try {
      const path = this.#metadataPath(id);
      assertRegularFile(path);
      const metadata = JSON.parse(readFileSync(path, "utf8"));
      if (metadata.id !== id || !metadata.cursorKey) throw new Error("invalid metadata");
      return metadata;
    } catch (error) {
      if (error?.code === "ENOENT") throw artifactNotFound(id);
      if (error instanceof BridgeToolError) throw error;
      throw new BridgeToolError("ARTIFACT_STORE_UNAVAILABLE", `Could not read artifact ${id}.`, {
        cause: error,
      });
    }
  }

  #removeArtifact(id) {
    rmSync(this.#contentPath(id), { force: true });
    rmSync(this.#metadataPath(id), { force: true });
  }

  #contentPath(id) {
    return safeChild(this.root, `${validateId(id)}.txt`);
  }

  #metadataPath(id) {
    return safeChild(this.root, `${validateId(id)}.json`);
  }
}

class OutputCollector {
  constructor(store, context) {
    this.store = store;
    this.context = { ...context };
    this.id = randomUUID();
    this.cursorKey = randomBytes(32).toString("base64url");
    this.inline = "";
    this.inlineBytes = 0;
    this.totalBytes = 0;
    this.capturedBytes = 0;
    this.captureTruncated = false;
    this.head = "";
    this.tail = "";
    this.fd = null;
    this.partPath = safeChild(store.tmpRoot, `${this.id}.part`);
    this.closed = false;
    this.finalizing = null;
    this.onClosed = null;
  }

  setContext(values) {
    Object.assign(this.context, values);
  }

  markCaptureTruncated() {
    this.captureTruncated = true;
  }

  noteUncapturedBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.totalBytes += Math.floor(bytes);
    this.captureTruncated = true;
  }

  append(value) {
    if (this.closed) return;
    const text = String(value ?? "");
    if (!text) return;
    const bytes = utf8Bytes(text);
    this.totalBytes += bytes;
    this.head = truncateUtf8(this.head + text, this.store.previewHeadBytes);
    this.tail = truncateUtf8Tail(this.tail + text, this.store.previewTailBytes);

    try {
      if (this.fd === null && this.inlineBytes + bytes <= this.store.maxInlineBytes) {
        this.inline += text;
        this.inlineBytes += bytes;
        this.capturedBytes += bytes;
        return;
      }

      if (this.fd === null) this.#spill();
      this.#writeCaptured(text);
    } catch {
      this.captureTruncated = true;
      try { if (this.fd !== null) closeSync(this.fd); } catch {}
      this.fd = null;
      try { rmSync(this.partPath, { force: true }); } catch {}
      this.inline = boundedPreview(this.head, this.tail, {
        headBytes: this.store.previewHeadBytes,
        tailBytes: this.store.previewTailBytes,
      });
      this.inlineBytes = utf8Bytes(this.inline);
      this.capturedBytes = utf8Bytes(this.inline);
    }
  }

  async finalize(options = {}) {
    if (this.closed) return this.result;
    if (this.finalizing) return this.finalizing;
    this.finalizing = this.#finish(options);
    return this.finalizing;
  }

  async #finish({ complete = true, forceArtifact = false } = {}) {
    if (forceArtifact && this.fd === null && this.inline) this.#spill();

    let metadata = null;
    try {
      if (this.fd !== null) {
        closeSync(this.fd);
        this.fd = null;
        const contentPath = safeChild(this.store.root, `${this.id}.txt`);
        renameSync(this.partPath, contentPath);
        const createdAt = new Date(this.store.now());
        metadata = {
          id: this.id,
          kind: this.context.kind,
          ownerRole: this.context.ownerRole,
          createdAt: createdAt.toISOString(),
          expiresAt: new Date(createdAt.getTime() + this.store.ttlMs).toISOString(),
          totalBytes: this.totalBytes,
          capturedBytes: this.capturedBytes,
          complete,
          captureTruncated: this.captureTruncated,
          cursorKey: this.cursorKey,
          ...safeContext(this.context),
        };
        const tempMeta = safeChild(this.store.tmpRoot, `${this.id}.json.part`);
        writeFileSync(tempMeta, JSON.stringify(metadata, null, 2), { encoding: "utf8", flag: "wx" });
        renameSync(tempMeta, safeChild(this.store.root, `${this.id}.json`));
      }
    } catch {
      try { if (this.fd !== null) closeSync(this.fd); } catch {}
      this.fd = null;
      try { rmSync(this.partPath, { force: true }); } catch {}
      try { rmSync(safeChild(this.store.root, `${this.id}.txt`), { force: true }); } catch {}
      try { rmSync(safeChild(this.store.tmpRoot, `${this.id}.json.part`), { force: true }); } catch {}
      metadata = null;
      this.captureTruncated = true;
      this.inline = boundedPreview(this.head, this.tail, {
        headBytes: this.store.previewHeadBytes,
        tailBytes: this.store.previewTailBytes,
      });
      this.inlineBytes = utf8Bytes(this.inline);
      this.capturedBytes = utf8Bytes(this.inline);
    }

    const lostOutput = this.captureTruncated || this.totalBytes > this.capturedBytes;
    const inline = metadata ? null : this.inline;
    this.result = {
      inline,
      preview: metadata || lostOutput ? boundedPreview(this.head, this.tail, {
        headBytes: this.store.previewHeadBytes,
        tailBytes: this.store.previewTailBytes,
      }) : null,
      truncated: Boolean(metadata) || lostOutput,
      totalBytes: this.totalBytes,
      capturedBytes: this.capturedBytes,
      complete,
      captureTruncated: this.captureTruncated,
      artifact: metadata ? this.store.descriptor(metadata) : null,
    };
    this.closed = true;
    this.onClosed?.();
    return this.result;
  }

  #spill() {
    try {
      this.fd = openSync(this.partPath, "wx");
      const prior = this.inline;
      this.inline = "";
      this.inlineBytes = 0;
      this.capturedBytes = 0;
      if (prior) this.#writeCaptured(prior);
    } catch {
      this.captureTruncated = true;
      try { if (this.fd !== null) closeSync(this.fd); } catch {}
      this.fd = null;
      try { rmSync(this.partPath, { force: true }); } catch {}
      this.inline = truncateUtf8(this.inline, this.store.maxInlineBytes);
      this.inlineBytes = utf8Bytes(this.inline);
    }
  }

  #writeCaptured(text) {
    if (this.fd === null) return;
    const remaining = this.store.maxCaptureBytes - this.capturedBytes;
    if (remaining <= 0) {
      this.captureTruncated = true;
      return;
    }
    const captured = utf8PrefixBuffer(text, remaining);
    if (captured.length) {
      writeSync(this.fd, captured);
      this.capturedBytes += captured.length;
    }
    if (captured.length < utf8Bytes(text)) this.captureTruncated = true;
  }
}

const validateId = (id) => {
  if (!ID_RE.test(String(id ?? ""))) {
    throw new BridgeToolError("ARTIFACT_NOT_FOUND", "Artifact was not found.");
  }
  return String(id);
};

const artifactNotFound = (id) => new BridgeToolError("ARTIFACT_NOT_FOUND", `Artifact ${id} was not found.`);

const safeChild = (root, name) => {
  const target = resolve(root, name);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!target.startsWith(prefix)) throw new BridgeToolError("INVALID_INPUT", "Unsafe artifact path.");
  return target;
};

const safeSize = (path) => {
  try { return statSync(path).size; } catch { return 0; }
};

const assertRegularFile = (path) => {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new BridgeToolError("ARTIFACT_STORE_UNAVAILABLE", "Artifact storage entry is not a regular file.");
  }
};

const safeContext = ({ threadId, turnId, mailbox } = {}) => Object.fromEntries(
  Object.entries({ threadId, turnId, mailbox }).filter(([, value]) => value != null),
);

const clampPage = (value, max) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new BridgeToolError("INVALID_INPUT", `maxBytes must be an integer between 1 and ${max}.`);
  }
  return value;
};

const encodeCursor = (metadata, offset) => {
  const payload = Buffer.from(JSON.stringify({ v: 1, id: metadata.id, offset }), "utf8").toString("base64url");
  const signature = createHmac("sha256", metadata.cursorKey).update(payload).digest("base64url");
  return `${payload}.${signature}`;
};

const decodeCursor = (cursor, metadata) => {
  try {
    const [payload, signature, extra] = String(cursor).split(".");
    if (!payload || !signature || extra) throw new Error("bad cursor shape");
    const expected = createHmac("sha256", metadata.cursorKey).update(payload).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("bad signature");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (decoded.v !== 1 || decoded.id !== metadata.id || !Number.isSafeInteger(decoded.offset)) {
      throw new Error("bad cursor payload");
    }
    return decoded.offset;
  } catch (error) {
    throw new BridgeToolError("INVALID_CURSOR", "Artifact cursor is invalid.", { cause: error });
  }
};
