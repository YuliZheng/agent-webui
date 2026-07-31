import { open, stat } from "node:fs/promises";
import chokidar, { type FSWatcher } from "chokidar";
import type { IndexedRawLine } from "../types.js";
import { JsonStore } from "../util/json-store.js";

export interface FileSnapshot {
  lines: IndexedRawLine[];
  trailing: Buffer;
  trailingDiscarded: boolean;
  completeBytes: number;
  size: number;
  lineCount: number;
}

interface ScanOptions {
  from?: number;
  to?: number;
  tailN?: number;
  maxBytes?: number;
  /**
   * Display/tail reads cap pathological individual records. Exact mutation
   * snapshots opt out so rewind/fork never replace source bytes with the
   * display-only omission marker.
   */
  maxRecordBytes?: number;
}

interface LineIndex {
  size: number;
  mtimeMs: number;
  lineCount: number;
  completeBytes: number;
  /** Byte offsets at exact line boundaries for every N physical lines. */
  anchors: number[];
  /**
   * Exact byte boundaries for the most recent physical lines. Keeping this
   * small suffix lets the usual tail/reconnect path skip a multi-megabyte tool
   * result without rereading it merely to find its terminating newline.
   */
  tailOffsets: number[];
  prefixSignature: Buffer;
  tailSignatureStart: number;
  tailSignature: Buffer;
}

interface PersistedLineIndex {
  path: string;
  size: number;
  mtimeMs: number;
  lineCount: number;
  completeBytes: number;
  anchors: number[];
  tailOffsets: number[];
  prefixSignature: string;
  tailSignatureStart: number;
  tailSignature: string;
}

interface PersistedLineIndexCache {
  version: 2;
  entries: PersistedLineIndex[];
}

export const MAX_LINE_INDEX_CACHE_ENTRIES = 12;
export const MAX_LINE_INDEX_CACHE_BYTES = 4 * 1024 * 1024;
export const LINE_INDEX_READ_CHUNK_BYTES = 1024 * 1024;
// A cold exact index must inspect the selected source file once to recover
// stable physical line indexes. Keep that one reader deliberately below full
// disk duty cycle; warm reconnects and normal appends use the persisted /
// incremental path and do not pay this delay.
export const LINE_INDEX_COLD_YIELD_MS = 8;
export const LINE_INDEX_ANCHOR_STRIDE = 256;
export const LINE_INDEX_TAIL_BOUNDARIES = 513;
export const MAX_JSONL_RECORD_BYTES = 4 * 1024 * 1024;
export const MAX_READ_RANGE_LINES = 2_000;
export const MAX_READ_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_STREAM_BATCH_BYTES = 2 * 1024 * 1024;
export const MAX_STREAM_BATCH_LINES = 200;
const LINE_INDEX_SIGNATURE_BYTES = 64;
const TAIL_APPEND_CHUNK_BYTES = 1024 * 1024;
const lineIndexes = new Map<string, LineIndex>();
const lineIndexBuilds = new Map<string, Promise<LineIndex>>();
let lineIndexStore: JsonStore<PersistedLineIndexCache> | undefined;
let lineIndexStorePath: string | undefined;
let lineIndexWriteTimer: NodeJS.Timeout | undefined;
let lineIndexStoreDirty = false;
let loadingPersistedIndexes = false;
let fullIndexBytesRead = 0;
let appendedIndexBytesRead = 0;
let activeColdIndexBuilds = 0;
let peakColdIndexBuilds = 0;
const interactiveColdIndexWaiters: Array<() => void> = [];
const backgroundColdIndexWaiters: Array<() => void> = [];
type LineIndexPriority = "background" | "interactive";

export function jsonlIndexIoCounters(): { fullBytes: number; appendedBytes: number } {
  return { fullBytes: fullIndexBytesRead, appendedBytes: appendedIndexBytesRead };
}

export function resetJsonlIndexIoCounters(): void {
  fullIndexBytesRead = 0;
  appendedIndexBytesRead = 0;
  peakColdIndexBuilds = activeColdIndexBuilds;
}

export function jsonlColdIndexConcurrency(): { active: number; peak: number } {
  return { active: activeColdIndexBuilds, peak: peakColdIndexBuilds };
}

async function withColdIndexPermit<T>(
  work: () => Promise<T>,
  priority: LineIndexPriority = "background",
): Promise<T> {
  if (activeColdIndexBuilds > 0) {
    await new Promise<void>(resolve => {
      const waiter = () => {
      // Ownership is handed directly to this waiter. Keep the active count at
      // one throughout the handoff so a newly arriving build cannot slip in.
        resolve();
      };
      // A selected/live session must not sit behind an archive-prefetch queue.
      // It still waits for the one build already reading disk, then jumps ahead
      // of queued background HTTP tails and preview work.
      if (priority === "interactive") interactiveColdIndexWaiters.push(waiter);
      else backgroundColdIndexWaiters.push(waiter);
    });
  } else {
    activeColdIndexBuilds = 1;
  }
  peakColdIndexBuilds = Math.max(peakColdIndexBuilds, activeColdIndexBuilds);
  try {
    return await work();
  } finally {
    const next = interactiveColdIndexWaiters.shift() ?? backgroundColdIndexWaiters.shift();
    if (next) next();
    else activeColdIndexBuilds = 0;
  }
}

function scheduleLineIndexWrite(): void {
  if (!lineIndexStore || loadingPersistedIndexes) return;
  lineIndexStoreDirty = true;
  if (lineIndexWriteTimer) return;
  lineIndexWriteTimer = setTimeout(() => {
    lineIndexWriteTimer = undefined;
    void flushLineIndexPersistence();
  }, 1_000);
  lineIndexWriteTimer.unref?.();
}

function touchLineIndex(path: string, index: LineIndex): LineIndex {
  lineIndexes.delete(path);
  lineIndexes.set(path, index);
  while (
    lineIndexes.size > MAX_LINE_INDEX_CACHE_ENTRIES ||
    (lineIndexes.size > 1 && lineIndexCacheBytes() > MAX_LINE_INDEX_CACHE_BYTES)
  ) {
    const oldest = lineIndexes.keys().next().value;
    if (typeof oldest !== "string") break;
    lineIndexes.delete(oldest);
  }
  scheduleLineIndexWrite();
  return index;
}

export function jsonlIndexCacheSize(): number {
  return lineIndexes.size;
}

export function lineIndexCacheBytes(): number {
  let bytes = 0;
  for (const index of lineIndexes.values()) {
    // JS numbers are implementation-defined; 16 bytes is a conservative
    // resident estimate including array slots/overhead.
    bytes += 176
      + (index.anchors.length * 16)
      + (index.tailOffsets.length * 16)
      + index.prefixSignature.length
      + index.tailSignature.length;
  }
  return bytes;
}

export function jsonlIndexCachePaths(): string[] {
  return [...lineIndexes.keys()];
}

function finiteInteger(value: unknown, minimum = 0): number | undefined {
  return typeof value === "number"
    && Number.isFinite(value)
    && Number.isSafeInteger(value)
    && value >= minimum
    ? value
    : undefined;
}

function decodeSignature(value: unknown): Buffer | undefined {
  if (typeof value !== "string" || value.length > 256 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64");
  return decoded.length <= LINE_INDEX_SIGNATURE_BYTES ? decoded : undefined;
}

function normalizePersistedLineIndex(value: unknown): PersistedLineIndex | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const path = typeof item.path === "string" ? item.path : undefined;
  const size = finiteInteger(item.size);
  const mtimeMs = typeof item.mtimeMs === "number" && Number.isFinite(item.mtimeMs) && item.mtimeMs >= 0
    ? item.mtimeMs
    : undefined;
  const lineCount = finiteInteger(item.lineCount);
  const completeBytes = finiteInteger(item.completeBytes);
  const tailSignatureStart = finiteInteger(item.tailSignatureStart);
  const prefixSignature = decodeSignature(item.prefixSignature);
  const tailSignature = decodeSignature(item.tailSignature);
  const anchors = Array.isArray(item.anchors)
    ? item.anchors.map(value => finiteInteger(value)).filter((entry): entry is number => entry !== undefined)
    : [];
  const tailOffsets = Array.isArray(item.tailOffsets)
    ? item.tailOffsets.map(value => finiteInteger(value)).filter((entry): entry is number => entry !== undefined)
    : [];
  if (
    !path || size === undefined || mtimeMs === undefined || lineCount === undefined
    || completeBytes === undefined || completeBytes > size
    || tailSignatureStart === undefined || tailSignatureStart > size
    || !prefixSignature || !tailSignature || anchors[0] !== 0
    || anchors.length !== Math.floor(lineCount / LINE_INDEX_ANCHOR_STRIDE) + 1
    || tailOffsets.length < 1 || tailOffsets.length > LINE_INDEX_TAIL_BOUNDARIES
    || tailOffsets.length > lineCount + 1
    || tailOffsets[tailOffsets.length - 1] !== completeBytes
  ) return null;
  for (let index = 1; index < anchors.length; index++) {
    if (anchors[index]! <= anchors[index - 1]! || anchors[index]! > completeBytes) return null;
  }
  for (let index = 1; index < tailOffsets.length; index++) {
    if (tailOffsets[index]! <= tailOffsets[index - 1]! || tailOffsets[index]! > completeBytes) return null;
  }
  return {
    path,
    size,
    mtimeMs,
    lineCount,
    completeBytes,
    anchors,
    tailOffsets,
    prefixSignature: prefixSignature.toString("base64"),
    tailSignatureStart,
    tailSignature: tailSignature.toString("base64"),
  };
}

function normalizePersistedLineIndexCache(value: unknown): PersistedLineIndexCache {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const entries = Array.isArray(record.entries)
    ? record.entries.map(normalizePersistedLineIndex).filter((item): item is PersistedLineIndex => item !== null)
    : [];
  return { version: 2, entries: entries.slice(-MAX_LINE_INDEX_CACHE_ENTRIES) };
}

function serializeLineIndex(path: string, index: LineIndex): PersistedLineIndex {
  return {
    path,
    size: index.size,
    mtimeMs: index.mtimeMs,
    lineCount: index.lineCount,
    completeBytes: index.completeBytes,
    anchors: [...index.anchors],
    tailOffsets: [...index.tailOffsets],
    prefixSignature: index.prefixSignature.toString("base64"),
    tailSignatureStart: index.tailSignatureStart,
    tailSignature: index.tailSignature.toString("base64"),
  };
}

/**
 * Persist only the small LRU of sparse line indexes. This is what makes opening
 * the tail of a very large transcript cheap after a backend restart: the
 * source file is validated with tiny signatures and only appended bytes are
 * scanned. The JSONL remains the sole transcript source of truth.
 */
export async function configureLineIndexPersistence(path: string): Promise<void> {
  if (lineIndexStorePath === path && lineIndexStore) {
    if (!lineIndexes.size) await loadConfiguredLineIndexes();
    return;
  }
  await flushLineIndexPersistence();
  if (lineIndexWriteTimer) clearTimeout(lineIndexWriteTimer);
  lineIndexWriteTimer = undefined;
  lineIndexStorePath = path;
  lineIndexStore = new JsonStore(
    path,
    () => ({ version: 2, entries: [] }),
    normalizePersistedLineIndexCache,
  );
  lineIndexes.clear();
  lineIndexStoreDirty = false;
  await loadConfiguredLineIndexes();
}

async function loadConfiguredLineIndexes(): Promise<void> {
  if (!lineIndexStore) return;
  loadingPersistedIndexes = true;
  try {
    const cached = await lineIndexStore.get();
    for (const entry of cached.entries) {
      touchLineIndex(entry.path, {
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        lineCount: entry.lineCount,
        completeBytes: entry.completeBytes,
        anchors: [...entry.anchors],
        tailOffsets: [...entry.tailOffsets],
        prefixSignature: Buffer.from(entry.prefixSignature, "base64"),
        tailSignatureStart: entry.tailSignatureStart,
        tailSignature: Buffer.from(entry.tailSignature, "base64"),
      });
    }
  } finally {
    loadingPersistedIndexes = false;
    lineIndexStoreDirty = false;
  }
}

export async function flushLineIndexPersistence(): Promise<void> {
  if (!lineIndexStore || !lineIndexStoreDirty) return;
  if (lineIndexWriteTimer) clearTimeout(lineIndexWriteTimer);
  lineIndexWriteTimer = undefined;
  lineIndexStoreDirty = false;
  await lineIndexStore.put({
    version: 2,
    entries: [...lineIndexes].map(([path, index]) => serializeLineIndex(path, index)),
  });
}

/** Test/diagnostic helper; production normally retains the bounded LRU. */
export function clearLineIndexMemoryCache(): void {
  lineIndexes.clear();
}

async function readIndexSignatures(path: string, size: number): Promise<Pick<LineIndex, "prefixSignature" | "tailSignatureStart" | "tailSignature">> {
  const prefixLength = Math.min(LINE_INDEX_SIGNATURE_BYTES, size);
  const tailSignatureStart = Math.max(0, size - LINE_INDEX_SIGNATURE_BYTES);
  const tailLength = size - tailSignatureStart;
  const prefixSignature = Buffer.allocUnsafe(prefixLength);
  const tailSignature = Buffer.allocUnsafe(tailLength);
  const handle = await open(path, "r");
  try {
    let prefixOffset = 0;
    while (prefixOffset < prefixLength) {
      const result = await handle.read(prefixSignature, prefixOffset, prefixLength - prefixOffset, prefixOffset);
      if (!result.bytesRead) break;
      prefixOffset += result.bytesRead;
    }
    let tailOffset = 0;
    while (tailOffset < tailLength) {
      const result = await handle.read(tailSignature, tailOffset, tailLength - tailOffset, tailSignatureStart + tailOffset);
      if (!result.bytesRead) break;
      tailOffset += result.bytesRead;
    }
    return {
      prefixSignature: prefixSignature.subarray(0, prefixOffset),
      tailSignatureStart,
      tailSignature: tailSignature.subarray(0, tailOffset),
    };
  } finally {
    await handle.close();
  }
}

async function signaturesStillMatch(path: string, index: LineIndex): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    if (index.prefixSignature.length) {
      const prefix = Buffer.allocUnsafe(index.prefixSignature.length);
      const result = await handle.read(prefix, 0, prefix.length, 0);
      if (result.bytesRead !== prefix.length || !prefix.equals(index.prefixSignature)) return false;
    }
    if (index.tailSignature.length) {
      const tail = Buffer.allocUnsafe(index.tailSignature.length);
      const result = await handle.read(tail, 0, tail.length, index.tailSignatureStart);
      if (result.bytesRead !== tail.length || !tail.equals(index.tailSignature)) return false;
    }
    return true;
  } finally {
    await handle.close();
  }
}

async function buildLineIndexUnthrottled(path: string, info: { size: number; mtimeMs: number }): Promise<LineIndex> {
  const anchors = [0];
  const tailOffsets = [0];
  let lineCount = 0;
  let completeBytes = 0;
  const handle = await open(path, "r");
  let fileOffset = 0;
  try {
    // Index exactly the stat snapshot. If the file grows while this loop runs,
    // the next poll begins at this byte boundary with a matching physical index.
    while (fileOffset < info.size) {
      const requested = Math.min(LINE_INDEX_READ_CHUNK_BYTES, info.size - fileOffset);
      const chunk = Buffer.allocUnsafe(requested);
      let filled = 0;
      while (filled < requested) {
        const result = await handle.read(chunk, filled, requested - filled, fileOffset + filled);
        if (!result.bytesRead) break;
        filled += result.bytesRead;
      }
      if (!filled) break;
      fullIndexBytesRead += filled;
      const actual = chunk.subarray(0, filled);
      let cursor = 0;
      while (cursor < actual.length) {
        const newline = actual.indexOf(0x0a, cursor);
        if (newline < 0) break;
        lineCount++;
        completeBytes = fileOffset + newline + 1;
        if (lineCount % LINE_INDEX_ANCHOR_STRIDE === 0) anchors.push(completeBytes);
        tailOffsets.push(completeBytes);
        if (tailOffsets.length > LINE_INDEX_TAIL_BOUNDARIES) tailOffsets.shift();
        cursor = newline + 1;
      }
      fileOffset += filled;
      if (filled < requested) break;
      if (fileOffset < info.size) {
        // A cold exact line count is unavoidable, but it must not monopolize
        // the disk or event loop. A short duty-cycle pause keeps the desktop
        // responsive while warm/appended reads remain unthrottled.
        await new Promise<void>(resolve => setTimeout(resolve, LINE_INDEX_COLD_YIELD_MS));
      }
    }
  } finally { await handle.close(); }
  // A short read means the stat snapshot was invalidated (usually truncate).
  // Cache only bytes we actually inspected; a later stat will rebuild it.
  const indexedSize = Math.min(info.size, fileOffset);
  const signatures = await readIndexSignatures(path, indexedSize);
  const index = {
    size: indexedSize,
    mtimeMs: info.mtimeMs,
    lineCount,
    completeBytes,
    anchors,
    tailOffsets,
    ...signatures,
  };
  return touchLineIndex(path, index);
}

async function buildLineIndex(
  path: string,
  info: { size: number; mtimeMs: number },
  priority: LineIndexPriority = "background",
): Promise<LineIndex> {
  // Different sessions may be opened/prefetched at once. Serialize only cold
  // full-file indexing; same-session callers are also deduplicated by
  // lineIndexBuilds below. Incremental append indexing stays concurrent.
  return withColdIndexPermit(() => buildLineIndexUnthrottled(path, info), priority);
}

async function extendLineIndex(
  path: string,
  cached: LineIndex,
  info: { size: number; mtimeMs: number },
): Promise<LineIndex> {
  const anchors = [...cached.anchors];
  const tailOffsets = [...cached.tailOffsets];
  let lineCount = cached.lineCount;
  let completeBytes = cached.completeBytes;
  const handle = await open(path, "r");
  let fileOffset = cached.size;
  try {
    while (fileOffset < info.size) {
      const requested = Math.min(LINE_INDEX_READ_CHUNK_BYTES, info.size - fileOffset);
      const chunk = Buffer.allocUnsafe(requested);
      let filled = 0;
      while (filled < requested) {
        const result = await handle.read(chunk, filled, requested - filled, fileOffset + filled);
        if (!result.bytesRead) break;
        filled += result.bytesRead;
      }
      if (!filled) break;
      appendedIndexBytesRead += filled;
      const actual = chunk.subarray(0, filled);
      let cursor = 0;
      while (cursor < actual.length) {
        const newline = actual.indexOf(0x0a, cursor);
        if (newline < 0) break;
        lineCount++;
        completeBytes = fileOffset + newline + 1;
        if (lineCount % LINE_INDEX_ANCHOR_STRIDE === 0) anchors.push(completeBytes);
        tailOffsets.push(completeBytes);
        if (tailOffsets.length > LINE_INDEX_TAIL_BOUNDARIES) tailOffsets.shift();
        cursor = newline + 1;
      }
      fileOffset += filled;
      if (filled < requested) break;
      if (fileOffset < info.size) await new Promise<void>(resolve => setImmediate(resolve));
    }
  } finally {
    await handle.close();
  }
  const size = Math.min(info.size, fileOffset);
  const signatures = await readIndexSignatures(path, size);
  return touchLineIndex(path, {
    size,
    mtimeMs: info.mtimeMs,
    lineCount,
    completeBytes,
    anchors,
    tailOffsets,
    ...signatures,
  });
}

async function getLineIndex(
  path: string,
  priority: LineIndexPriority = "background",
): Promise<LineIndex> {
  const info = await stat(path);
  const cached = lineIndexes.get(path);
  if (cached?.size === info.size && cached.mtimeMs === info.mtimeMs) return touchLineIndex(path, cached);

  const inFlight = lineIndexBuilds.get(path);
  if (inFlight) {
    const built = await inFlight;
    if (built.size === info.size && built.mtimeMs === info.mtimeMs) return touchLineIndex(path, built);
    return getLineIndex(path, priority);
  }

  const build = cached && info.size > cached.size
    ? signaturesStillMatch(path, cached).then(matches => (
      matches ? extendLineIndex(path, cached, info) : buildLineIndex(path, info, priority)
    ))
    : buildLineIndex(path, info, priority);
  lineIndexBuilds.set(path, build);
  try {
    return await build;
  } finally {
    if (lineIndexBuilds.get(path) === build) lineIndexBuilds.delete(path);
  }
}

function oversizedRecordRaw(bytes: number): string {
  return JSON.stringify({
    type: "agent-webui-record-omitted",
    bytes,
    message: `This JSONL record exceeds the ${MAX_JSONL_RECORD_BYTES / (1024 * 1024)} MiB display limit.`,
  });
}

async function readDirectTailLines(
  path: string,
  index: LineIndex,
  start: number,
  end: number,
  maxBytes: number,
  mode: "all" | "suffix" | "forward",
  maxRecordBytes: number,
): Promise<IndexedRawLine[] | undefined> {
  const tailStartLine = index.lineCount - (index.tailOffsets.length - 1);
  if (start < tailStartLine || end > index.lineCount) return undefined;

  const lines: IndexedRawLine[] = [];
  let retainedFrom = 0;
  let retainedBytes = 0;
  const handle = await open(path, "r");
  try {
    for (let physicalIndex = start; physicalIndex < end; physicalIndex++) {
      const boundaryIndex = physicalIndex - tailStartLine;
      const startByte = index.tailOffsets[boundaryIndex];
      const endByte = index.tailOffsets[boundaryIndex + 1];
      if (startByte === undefined || endByte === undefined || endByte <= startByte) return undefined;
      const payloadBytes = Math.max(0, endByte - startByte - 1);
      let raw: string;
      if (payloadBytes > maxRecordBytes) {
        raw = oversizedRecordRaw(payloadBytes);
      } else {
        const value = Buffer.allocUnsafe(payloadBytes);
        let offset = 0;
        while (offset < payloadBytes) {
          const result = await handle.read(value, offset, payloadBytes - offset, startByte + offset);
          if (!result.bytesRead) break;
          offset += result.bytesRead;
        }
        raw = value.subarray(0, offset).toString("utf8");
        if (raw.endsWith("\r")) raw = raw.slice(0, -1);
      }

      const rawBytes = Buffer.byteLength(raw);
      if (mode === "forward" && lines.length > 0 && retainedBytes + rawBytes > maxBytes) return lines;
      lines.push({ index: physicalIndex, raw });
      retainedBytes += rawBytes;
      if (mode === "suffix") {
        while (retainedFrom < lines.length - 1 && retainedBytes > maxBytes) {
          retainedBytes -= Buffer.byteLength(lines[retainedFrom]!.raw);
          retainedFrom++;
        }
      }
    }
  } finally {
    await handle.close();
  }
  return retainedFrom ? lines.slice(retainedFrom) : lines;
}

async function readIndexedLines(
  path: string,
  index: LineIndex,
  from: number,
  to: number,
  maxBytes = Number.POSITIVE_INFINITY,
  mode: "all" | "suffix" | "forward" = "all",
  maxRecordBytes = MAX_JSONL_RECORD_BYTES,
): Promise<IndexedRawLine[]> {
  const start = Math.max(0, Math.min(index.lineCount, Math.floor(from)));
  const end = Math.max(start, Math.min(index.lineCount, Math.floor(to)));
  if (start === end) return [];
  const directTail = await readDirectTailLines(path, index, start, end, maxBytes, mode, maxRecordBytes);
  if (directTail) return directTail;
  const anchorLine = Math.floor(start / LINE_INDEX_ANCHOR_STRIDE) * LINE_INDEX_ANCHOR_STRIDE;
  const startByte = index.anchors[Math.floor(anchorLine / LINE_INDEX_ANCHOR_STRIDE)] ?? 0;
  const lines: IndexedRawLine[] = [];
  let retainedFrom = 0;
  let retainedBytes = 0;
  const handle = await open(path, "r");
  let fileOffset = startByte;
  let physicalIndex = anchorLine;
  let parts: Buffer[] = [];
  let partBytes = 0;
  let discardedBytes = 0;

  function appendPart(value: Buffer): void {
    if (!value.length) return;
    if (discardedBytes) {
      discardedBytes += value.length;
      return;
    }
    if (partBytes + value.length > maxRecordBytes) {
      discardedBytes = partBytes + value.length;
      parts = [];
      partBytes = 0;
      return;
    }
    parts.push(Buffer.from(value));
    partBytes += value.length;
  }

  function finishLine(): string {
    let raw: string;
    if (discardedBytes) raw = oversizedRecordRaw(discardedBytes);
    else {
      raw = partBytes ? Buffer.concat(parts, partBytes).toString("utf8") : "";
      if (raw.endsWith("\r")) raw = raw.slice(0, -1);
    }
    parts = [];
    partBytes = 0;
    discardedBytes = 0;
    return raw;
  }

  try {
    while (fileOffset < index.completeBytes && physicalIndex < end) {
      const requested = Math.min(LINE_INDEX_READ_CHUNK_BYTES, index.completeBytes - fileOffset);
      const chunk = Buffer.allocUnsafe(requested);
      const result = await handle.read(chunk, 0, requested, fileOffset);
      if (!result.bytesRead) break;
      const actual = chunk.subarray(0, result.bytesRead);
      let cursor = 0;
      while (cursor < actual.length && physicalIndex < end) {
        const newline = actual.indexOf(0x0a, cursor);
        if (newline < 0) {
          if (physicalIndex >= start) appendPart(actual.subarray(cursor));
          break;
        }
        if (physicalIndex >= start) appendPart(actual.subarray(cursor, newline));
        if (physicalIndex >= start) {
          const raw = finishLine();
          const rawBytes = Buffer.byteLength(raw);
          if (mode === "forward" && lines.length > 0 && retainedBytes + rawBytes > maxBytes) {
            return lines;
          }
          lines.push({ index: physicalIndex, raw });
          retainedBytes += rawBytes;
          if (mode === "suffix") {
            while (retainedFrom < lines.length - 1 && retainedBytes > maxBytes) {
              retainedBytes -= Buffer.byteLength(lines[retainedFrom]!.raw);
              retainedFrom++;
            }
          }
        }
        physicalIndex++;
        cursor = newline + 1;
      }
      fileOffset += result.bytesRead;
      if (result.bytesRead < requested) break;
      if (fileOffset < index.completeBytes && physicalIndex < end) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }
  } finally { await handle.close(); }
  return retainedFrom ? lines.slice(retainedFrom) : lines;
}

async function snapshotFromIndex(path: string, index: LineIndex, options: ScanOptions): Promise<FileSnapshot> {
  const lineCount = index.lineCount;
  const requestedFrom = Math.max(0, Math.floor(options.from ?? 0));
  const requestedTo = Math.max(requestedFrom, Math.floor(options.to ?? Number.MAX_SAFE_INTEGER));
  const from = options.tailN === undefined
    ? Math.min(lineCount, requestedFrom)
    : Math.max(0, lineCount - Math.max(0, Math.floor(options.tailN)));
  const to = options.tailN === undefined ? Math.min(lineCount, requestedTo) : lineCount;
  const completeBytes = index.completeBytes;
  const trailingLength = index.size - completeBytes;
  let trailing = Buffer.alloc(0);
  const maxRecordBytes = options.maxRecordBytes ?? MAX_JSONL_RECORD_BYTES;
  const trailingDiscarded = trailingLength > maxRecordBytes;
  if (trailingLength > 0 && !trailingDiscarded) {
    trailing = Buffer.allocUnsafe(trailingLength);
    const handle = await open(path, "r");
    let offset = 0;
    try {
      while (offset < trailingLength) {
        const result = await handle.read(trailing, offset, trailingLength - offset, completeBytes + offset);
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
    } finally { await handle.close(); }
    trailing = trailing.subarray(0, offset);
  }
  return {
    lines: await readIndexedLines(
      path,
      index,
      from,
      to,
      options.maxBytes ?? Number.POSITIVE_INFINITY,
      options.maxBytes === undefined ? "all" : "suffix",
      maxRecordBytes,
    ),
    trailing,
    trailingDiscarded,
    completeBytes,
    size: index.size,
    lineCount,
  };
}

async function indexedSnapshot(path: string, options: ScanOptions): Promise<FileSnapshot> {
  return snapshotFromIndex(path, await getLineIndex(path), options);
}

async function scanJsonl(path: string, options: ScanOptions = {}): Promise<FileSnapshot> {
  return indexedSnapshot(path, options);
}

export async function snapshotJsonl(path: string): Promise<FileSnapshot> {
  return scanJsonl(path, { maxRecordBytes: Number.POSITIVE_INFINITY });
}

export async function countJsonlLines(path: string): Promise<number> {
  return (await getLineIndex(path)).lineCount;
}

export interface StreamedJsonlLine {
  /** Zero-based physical line index. */
  index: number;
  /** Exact byte range in the source, including the terminating LF. */
  startByte: number;
  endByte: number;
  /** Source bytes before the terminating LF (and including a possible CR). */
  bytes: number;
  /**
   * Present only when the record fits within maxRecordBytes. Consumers must
   * handle an omitted raw value explicitly instead of accidentally buffering
   * an unbounded base64/file-history record.
   */
  raw?: string;
  /** A small ASCII-safe diagnostic prefix used to classify omitted records. */
  prefix: string;
}

export interface StreamJsonlOptions {
  maxRecordBytes?: number;
  prefixBytes?: number;
}

/**
 * Iterate complete physical JSONL records from a fixed stat snapshot.
 *
 * Unlike readline and snapshotJsonl, this scanner never retains an unbounded
 * physical line. Byte offsets are calculated from the source buffers, not
 * from decoded strings, so callers can safely use them for exact truncation
 * and prefix-copy mutations even when the file contains multi-byte UTF-8.
 */
export async function* streamJsonlLines(
  path: string,
  options: StreamJsonlOptions = {},
): AsyncGenerator<StreamedJsonlLine> {
  const maxRecordBytes = Math.floor(options.maxRecordBytes ?? MAX_JSONL_RECORD_BYTES);
  const prefixLimit = Math.floor(options.prefixBytes ?? 64 * 1024);
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) {
    throw new TypeError("maxRecordBytes must be a positive, finite safe integer");
  }
  if (!Number.isSafeInteger(prefixLimit) || prefixLimit < 0) {
    throw new TypeError("prefixBytes must be a non-negative, finite safe integer");
  }

  const snapshotSize = (await stat(path)).size;
  const handle = await open(path, "r");
  let fileOffset = 0;
  let lineStart = 0;
  let lineIndex = 0;
  let lineBytes = 0;
  let retainedBytes = 0;
  let prefixBytes = 0;
  let oversized = false;
  let parts: Buffer[] = [];
  const prefixBuffer = Buffer.allocUnsafe(prefixLimit);

  const append = (value: Buffer): void => {
    if (!value.length) return;
    lineBytes += value.length;
    if (prefixBytes < prefixLimit) {
      const keep = Math.min(value.length, prefixLimit - prefixBytes);
      if (keep) {
        value.copy(prefixBuffer, prefixBytes, 0, keep);
        prefixBytes += keep;
      }
    }
    if (oversized) return;
    if (retainedBytes + value.length > maxRecordBytes) {
      oversized = true;
      retainedBytes = 0;
      parts = [];
      return;
    }
    parts.push(Buffer.from(value));
    retainedBytes += value.length;
  };

  try {
    while (fileOffset < snapshotSize) {
      const requested = Math.min(LINE_INDEX_READ_CHUNK_BYTES, snapshotSize - fileOffset);
      const chunk = Buffer.allocUnsafe(requested);
      const result = await handle.read(chunk, 0, requested, fileOffset);
      if (!result.bytesRead) break;
      const actual = chunk.subarray(0, result.bytesRead);
      let cursor = 0;
      while (cursor < actual.length) {
        const newline = actual.indexOf(0x0a, cursor);
        if (newline < 0) {
          append(actual.subarray(cursor));
          break;
        }
        append(actual.subarray(cursor, newline));
        let raw: string | undefined;
        if (!oversized) {
          raw = retainedBytes ? Buffer.concat(parts, retainedBytes).toString("utf8") : "";
          if (raw.endsWith("\r")) raw = raw.slice(0, -1);
        }
        const endByte = fileOffset + newline + 1;
        yield {
          index: lineIndex,
          startByte: lineStart,
          endByte,
          bytes: lineBytes,
          raw,
          prefix: raw === undefined && prefixBytes
            ? prefixBuffer.subarray(0, prefixBytes).toString("utf8")
            : "",
        };
        lineIndex++;
        lineStart = endByte;
        lineBytes = 0;
        retainedBytes = 0;
        prefixBytes = 0;
        oversized = false;
        parts = [];
        cursor = newline + 1;
      }
      fileOffset += result.bytesRead;
      if (result.bytesRead < requested) break;
    }
  } finally {
    await handle.close();
  }
}

export async function readRange(path: string, from: number, to?: number): Promise<IndexedRawLine[]> {
  const start = Math.max(0, Math.floor(from));
  const requestedEnd = to === undefined ? Number.MAX_SAFE_INTEGER : Math.max(start, Math.floor(to));
  const end = Math.min(requestedEnd, start + MAX_READ_RANGE_LINES);
  return (await indexedSnapshot(path, { from: start, to: end, maxBytes: MAX_READ_RESPONSE_BYTES })).lines;
}

/**
 * Read one exact physical record with a caller-selected record cap.
 *
 * Transcript image records can legitimately exceed the normal 4 MiB display
 * limit because they contain base64 bytes. The ordinary tail/range APIs keep
 * that defensive cap; the authenticated image endpoint uses this narrow
 * accessor and immediately decodes at most one bounded image.
 */
export async function readRecordAt(
  path: string,
  index: number,
  maxRecordBytes: number,
): Promise<IndexedRawLine | undefined> {
  if (!Number.isSafeInteger(index) || index < 0) return undefined;
  const boundedMax = Math.max(1, Math.floor(maxRecordBytes));
  return (await indexedSnapshot(path, {
    from: index,
    to: index + 1,
    maxBytes: boundedMax,
    maxRecordBytes: boundedMax,
  })).lines[0];
}

export async function readTail(path: string, n = 200): Promise<IndexedRawLine[]> {
  return (await indexedSnapshot(path, {
    tailN: Math.max(0, Math.min(MAX_READ_RANGE_LINES, Math.floor(n))),
    maxBytes: MAX_READ_RESPONSE_BYTES,
  })).lines;
}

export function preserveIndexes(lines: IndexedRawLine[], predicate: (raw: string) => boolean): IndexedRawLine[] {
  return lines.filter(line => predicate(line.raw));
}

/**
 * Claude writes several large bookkeeping records (most notably
 * file-history-snapshot) into the same append-only transcript. They are still
 * physical lines, and therefore still count toward every source index, but
 * they are not useful display payloads.
 */
export function isRenderableClaudeLine(raw: string): boolean {
  let record: unknown;
  try { record = JSON.parse(raw); } catch { return true; }
  if (!record || typeof record !== "object" || Array.isArray(record)) return true;
  const value = record as Record<string, unknown>;
  if (value.type === "user" || value.type === "assistant" || value.type === "system" || value.type === "queue-operation") {
    return true;
  }
  if (value.type !== "attachment") return false;
  return !!value.attachment
    && typeof value.attachment === "object"
    && !Array.isArray(value.attachment)
    && (value.attachment as Record<string, unknown>).type === "queued_command";
}

export type TailEvent =
  | { type: "stream-truncate"; keepCount: number }
  | { type: "stream-reset" }
  | { type: "stream-batch"; lines: IndexedRawLine[] }
  | { type: "stream-line"; index: number; data: string }
  // Advances the physical source high-water mark without sending a record.
  // Claude transcripts contain large bookkeeping records that the backend
  // intentionally filters out. The cursor prevents clients from repeatedly
  // requesting those hidden lines and also acts as a cheap tail-liveness
  // signal while an appended record is still incomplete.
  | { type: "stream-cursor"; nextIndex: number }
  | { type: "error"; code: number; message: string };

export interface TailOptions {
  from: number;
  tailN?: number;
  pollMs?: number;
  truncateVerifyMs?: number;
  filter?: (raw: string) => boolean;
}

export class JsonlTailer {
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private checkPromise?: Promise<void>;
  private checkQueued = false;
  private positionBytes = 0;
  private nextIndex = 0;
  private incompleteParts: Buffer[] = [];
  private incompleteBytes = 0;
  private discardingIncomplete = false;
  private discardedIncompleteBytes = 0;
  private lastSize = -1;
  private lastMtimeMs = -1;
  private checkpoints: Array<{ position: number; data: Buffer }> = [];

  constructor(private path: string, private options: TailOptions, private emit: (event: TailEvent) => void) {}

  async start(): Promise<void> {
    const index = await getLineIndex(this.path, "interactive");
    const snapshot = await snapshotFromIndex(this.path, index, { from: 0, to: 0 });
    this.positionBytes = snapshot.size;
    this.lastSize = snapshot.size;
    this.nextIndex = snapshot.lineCount;
    this.setIncomplete(
      snapshot.trailing,
      snapshot.trailingDiscarded,
      snapshot.trailingDiscarded ? snapshot.size - snapshot.completeBytes : 0,
    );
    this.lastMtimeMs = (await stat(this.path)).mtimeMs;
    await this.updateCheckpoints();
    const initialFrom = this.options.tailN === undefined
      ? 0
      : Math.max(0, snapshot.lineCount - Math.min(MAX_READ_RANGE_LINES, Math.max(0, Math.floor(this.options.tailN))));
    // A new tailer has no proof that the reconnecting client's cached prefix
    // still matches disk. Reset before replay; tailN keeps normal UI reconnects
    // bounded, while a cursor-only subscriber must rebuild from zero.
    this.options.from = initialFrom;
    this.emit({ type: "stream-reset" });
    await this.emitInitialRange(index, initialFrom, snapshot.lineCount);
    if (this.stopped) return;
    this.watcher = chokidar.watch(this.path, { ignoreInitial: true, followSymlinks: false });
    this.watcher
      .on("change", () => void this.check())
      .on("unlink", () => {
        this.emit({ type: "error", code: 404, message: "Session file was removed" });
        void this.stop();
      })
      .on("error", (error) => {
        // Windows can surface EPERM from ReadDirectoryChangesW while a watched
        // JSONL is being removed. Chokidar emits that asynchronously, so an
        // absent listener becomes an unhandled process error even after the
        // unlink path has already stopped this tailer. Polling remains the
        // source-of-truth fallback for transient watcher failures.
        if (this.stopped) return;
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT" || code === "EPERM") {
          void this.check();
          return;
        }
        this.emit({ type: "error", code: 500, message: "Session watcher failed" });
      });
    this.timer = setInterval(() => void this.check(), this.options.pollMs ?? 2000);
    this.timer.unref?.();
  }

  private async emitInitialRange(index: LineIndex, from: number, to: number): Promise<void> {
    let cursor = Math.max(0, from);
    while (!this.stopped && cursor < to) {
      const lines = await readIndexedLines(
        this.path,
        index,
        cursor,
        Math.min(to, cursor + MAX_STREAM_BATCH_LINES),
        MAX_STREAM_BATCH_BYTES,
        "forward",
      );
      if (!lines.length) return;
      const visible = this.options.filter
        ? preserveIndexes(lines, this.options.filter)
        : lines;
      if (visible.length) this.emit({ type: "stream-batch", lines: visible });
      cursor = lines[lines.length - 1]!.index + 1;
      if (cursor < to) await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  private async verifyTruncation(size: number): Promise<boolean> {
    if (size >= this.positionBytes || !await this.observeShorterFile(size)) return false;
    await new Promise(resolve => setTimeout(resolve, this.options.truncateVerifyMs ?? 1500));
    // The file may already have regrown after rewind/fork. That still requires
    // a ground-truth rescan because bytes before the old offset were replaced.
    try {
      const current = await stat(this.path);
      if (current.size < this.positionBytes) return this.observeShorterFile(current.size);
      return this.checkpointChanged();
    } catch { return false; }
  }

  private async observeShorterFile(maxSize: number): Promise<boolean> {
    try {
      const current = await stat(this.path);
      if (current.size > maxSize || current.size >= this.positionBytes) return false;
      // Probe exactly at the observed EOF. A stale directory/stat cache can
      // report a smaller size while the file itself is already readable past
      // it on a network filesystem.
      const handle = await open(this.path, "r");
      try {
        const probe = Buffer.allocUnsafe(1);
        return (await handle.read(probe, 0, 1, current.size)).bytesRead === 0;
      } finally { await handle.close(); }
    } catch { return false; }
  }

  private setIncomplete(value: Buffer, discarded = false, discardedBytes = 0): void {
    this.incompleteParts = value.length ? [Buffer.from(value)] : [];
    this.incompleteBytes = value.length;
    this.discardingIncomplete = discarded;
    this.discardedIncompleteBytes = discarded ? discardedBytes : 0;
  }

  private appendIncomplete(value: Buffer): void {
    if (!value.length) return;
    if (this.discardingIncomplete) {
      this.discardedIncompleteBytes += value.length;
      return;
    }
    if (this.incompleteBytes + value.length > MAX_JSONL_RECORD_BYTES) {
      this.discardingIncomplete = true;
      this.discardedIncompleteBytes = this.incompleteBytes + value.length;
      this.incompleteParts = [];
      this.incompleteBytes = 0;
      return;
    }
    this.incompleteParts.push(Buffer.from(value));
    this.incompleteBytes += value.length;
  }

  private finishIncomplete(): string {
    let raw: string;
    if (this.discardingIncomplete) raw = oversizedRecordRaw(this.discardedIncompleteBytes);
    else {
      raw = this.incompleteBytes
        ? Buffer.concat(this.incompleteParts, this.incompleteBytes).toString("utf8")
        : "";
      if (raw.endsWith("\r")) raw = raw.slice(0, -1);
    }
    this.setIncomplete(Buffer.alloc(0));
    return raw;
  }

  private consumeAppend(value: Buffer): IndexedRawLine[] {
    const lines: IndexedRawLine[] = [];
    let cursor = 0;
    while (cursor < value.length) {
      const newline = value.indexOf(0x0a, cursor);
      if (newline < 0) {
        this.appendIncomplete(value.subarray(cursor));
        break;
      }
      this.appendIncomplete(value.subarray(cursor, newline));
      lines.push({ index: this.nextIndex++, raw: this.finishIncomplete() });
      cursor = newline + 1;
    }
    return lines;
  }

  private async updateCheckpoints(): Promise<void> {
    if (this.positionBytes <= 0) { this.checkpoints = []; return; }
    const positions = [...new Set([
      0,
      Math.max(0, Math.floor(this.positionBytes / 2) - 32),
      Math.max(0, this.positionBytes - 64),
    ])];
    const handle = await open(this.path, "r");
    try {
      const next: Array<{ position: number; data: Buffer }> = [];
      for (const position of positions) {
        const length = Math.min(64, this.positionBytes - position);
        const data = Buffer.alloc(length); let offset = 0;
        while (offset < length) {
          const result = await handle.read(data, offset, length - offset, position + offset);
          if (!result.bytesRead) break;
          offset += result.bytesRead;
        }
        next.push({ position, data: data.subarray(0, offset) });
      }
      this.checkpoints = next;
    } finally { await handle.close(); }
  }

  private async checkpointChanged(): Promise<boolean> {
    if (!this.checkpoints.length) return false;
    const handle = await open(this.path, "r");
    try {
      for (const checkpoint of this.checkpoints) {
        const data = Buffer.alloc(checkpoint.data.length); let offset = 0;
        while (offset < data.length) {
          const result = await handle.read(data, offset, data.length - offset, checkpoint.position + offset);
          if (!result.bytesRead) break;
          offset += result.bytesRead;
        }
        if (offset !== checkpoint.data.length || !data.equals(checkpoint.data)) return true;
      }
      return false;
    } finally { await handle.close(); }
  }

  private async rescan(): Promise<void> {
    const index = await getLineIndex(this.path, "interactive");
    const snapshot = await snapshotFromIndex(this.path, index, { from: 0, to: 0 });
    this.positionBytes = snapshot.size;
    this.lastSize = snapshot.size;
    this.lastMtimeMs = (await stat(this.path)).mtimeMs;
    this.nextIndex = snapshot.lineCount;
    this.setIncomplete(
      snapshot.trailing,
      snapshot.trailingDiscarded,
      snapshot.trailingDiscarded ? snapshot.size - snapshot.completeBytes : 0,
    );
    await this.updateCheckpoints();
    // rescan() runs only after previously observed bytes may have changed.
    // A smaller line count does not prove a pure suffix truncation: the file
    // may also have rewritten its retained prefix. Since clients deliberately
    // do not clobber populated cache slots during replay, always reset before
    // sending the authoritative snapshot.
    const initialFrom = this.options.tailN === undefined
      ? 0
      : Math.max(0, snapshot.lineCount - Math.min(MAX_READ_RANGE_LINES, Math.max(0, Math.floor(this.options.tailN))));
    // Reset clears every cached slot, so the old resume cursor is no longer a
    // valid lower bound. Re-anchor both this replay and future live filtering
    // at the range the client is about to receive.
    this.options.from = initialFrom;
    this.emit({ type: "stream-reset" });
    await this.emitInitialRange(index, initialFrom, snapshot.lineCount);
  }

  async check(): Promise<void> {
    if (this.stopped) return;
    if (this.checkPromise) {
      this.checkQueued = true;
      await this.checkPromise;
      return;
    }
    const run = (async () => {
      do {
        this.checkQueued = false;
        await this.checkOnce();
        if (this.checkQueued && !this.stopped) {
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      } while (this.checkQueued && !this.stopped);
    })();
    this.checkPromise = run;
    try {
      await run;
    } finally {
      if (this.checkPromise === run) this.checkPromise = undefined;
    }
  }

  private async checkOnce(): Promise<void> {
    try {
      const info = await stat(this.path);
      if (info.size === this.lastSize) {
        if (info.mtimeMs === this.lastMtimeMs) return;
        if (await this.checkpointChanged()) await this.rescan();
        else this.lastMtimeMs = info.mtimeMs;
        return;
      }
      if (info.size < this.positionBytes) {
        if (!await this.verifyTruncation(info.size) || this.stopped) return;
        await this.rescan();
        return;
      }
      if (await this.checkpointChanged()) { await this.rescan(); return; }
      const length = Math.min(info.size - this.positionBytes, TAIL_APPEND_CHUNK_BYTES);
      if (length <= 0) { this.lastSize = info.size; return; }
      const handle = await open(this.path, "r");
      const appended = Buffer.allocUnsafe(length);
      let bytesRead = 0;
      try {
        while (bytesRead < length) {
          const result = await handle.read(appended, bytesRead, length - bytesRead, this.positionBytes + bytesRead);
          if (!result.bytesRead) break;
          bytesRead += result.bytesRead;
        }
      } finally { await handle.close(); }
      if (!bytesRead) return;
      this.positionBytes += bytesRead;
      this.lastSize = this.positionBytes;
      this.lastMtimeMs = info.mtimeMs;
      const lines = this.consumeAppend(appended.subarray(0, bytesRead));
      const visible = lines.filter(line =>
        line.index >= this.options.from
        && (!this.options.filter || this.options.filter(line.raw)),
      );
      if (visible.length === 1) this.emit({ type: "stream-line", index: visible[0]!.index, data: visible[0]!.raw });
      else if (visible.length) this.emit({ type: "stream-batch", lines: visible });
      // If the last consumed physical line was hidden (or no newline has
      // completed yet), no visible stream event represents the current source
      // position. Emit a cursor-only event so the browser advances over
      // filtered records and its desync watchdog sees that this tail is alive.
      // When the last physical line is visible, stream-line/stream-batch
      // already carries the same high-water mark and this extra event is
      // unnecessary.
      const lastPhysical = lines.at(-1);
      const lastVisible = visible.at(-1);
      if (!lastPhysical || lastVisible?.index !== lastPhysical.index) {
        this.emit({ type: "stream-cursor", nextIndex: this.nextIndex });
      }
      await this.updateCheckpoints();
      if (this.positionBytes < info.size) this.checkQueued = true;
    } catch (error) {
      this.emit({ type: "error", code: 500, message: error instanceof Error ? error.message : "Tail failed" });
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") await this.stop();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.watcher?.close();
  }
}
