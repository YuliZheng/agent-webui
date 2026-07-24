import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { IndexedRawLine } from "@/types";

interface CacheSchema extends DBSchema {
  sessions: { key: string; value: { id: string; lines: IndexedRawLine[]; updatedAt: number } };
  attachments: { key: string; value: { id: string; blob: Blob; name: string; type: string } };
}

let dbPromise: Promise<IDBPDatabase<CacheSchema>> | undefined;
function database(): Promise<IDBPDatabase<CacheSchema>> {
  if (!dbPromise) dbPromise = openDB<CacheSchema>("agent-webui", 5, {
    upgrade(db, oldVersion, _newVersion, transaction) {
      if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "id" });
      if (!db.objectStoreNames.contains("attachments")) db.createObjectStore("attachments", { keyPath: "id" });
      // Older versions could cache an entire multi-hundred-megabyte rollout.
      // Drop only the derived transcript cache; the agent JSONL remains truth.
      if (oldVersion > 0 && oldVersion < 5) transaction.objectStore("sessions").clear();
    }
  });
  return dbPromise;
}

export function mergeIndexedLines(current: readonly IndexedRawLine[], incoming: readonly IndexedRawLine[], priority: "forward" | "backfill" = "forward"): IndexedRawLine[] {
  const map = new Map<number, IndexedRawLine>();
  for (const line of current) map.set(line.index, { index: line.index, raw: line.raw });
  for (const line of incoming) {
    if (priority === "forward" || !map.has(line.index)) map.set(line.index, { index: line.index, raw: line.raw });
  }
  return [...map.values()].sort((a, b) => a.index - b.index);
}

export function truncateIndexedLines(lines: readonly IndexedRawLine[], keepCount: number): IndexedRawLine[] {
  return lines.filter((line) => line.index < Math.max(0, keepCount)).map((line) => ({ ...line }));
}

export const MAX_PERSISTED_CACHE_LINES = 500;
export const MAX_PERSISTED_CACHE_CHARS = 8 * 1024 * 1024;
export function linesForPersistence(lines: readonly IndexedRawLine[]): IndexedRawLine[] {
  const out: IndexedRawLine[] = [];
  let chars = 0;
  for (let index = lines.length - 1; index >= 0 && out.length < MAX_PERSISTED_CACHE_LINES; index--) {
    const line = lines[index]!;
    if (line.raw.length > MAX_PERSISTED_CACHE_CHARS) continue;
    if (chars + line.raw.length > MAX_PERSISTED_CACHE_CHARS) break;
    chars += line.raw.length;
    out.push({ index: line.index, raw: line.raw });
  }
  return out.reverse();
}

export class RawSessionCache {
  lines: IndexedRawLine[] = [];
  restored = false;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private restorePromise?: Promise<IndexedRawLine[]>;

  constructor(public readonly sessionId: string) {}
  get nextLineIndex(): number {
    let last = -1;
    for (const line of this.lines) if (line.index > last) last = line.index;
    return last + 1;
  }

  async restore(): Promise<IndexedRawLine[]> {
    if (this.restored) return this.lines;
    if (this.restorePromise) return this.restorePromise;
    this.restorePromise = (async () => {
      try {
        const record = await (await database()).get("sessions", this.sessionId);
        // Enforce the current memory ceiling while restoring too. This also
        // protects against a stale/partially-migrated browser cache written by
        // an older build before transcript persistence was bounded.
        if (!this.disposed) {
          const restored = Array.isArray(record?.lines)
            ? record.lines
              .filter((line) => Number.isSafeInteger(line?.index) && typeof line?.raw === "string")
              .map(({ index, raw }) => ({ index, raw }))
            : [];
          this.lines = linesForPersistence(restored);
        }
      } catch {
        if (!this.disposed) this.lines = [];
      }
      if (this.disposed) return [];
      this.restored = true;
      return this.lines;
    })();
    try {
      return await this.restorePromise;
    } finally {
      this.restorePromise = undefined;
    }
  }

  merge(incoming: readonly IndexedRawLine[], priority: "forward" | "backfill" = "forward"): IndexedRawLine[] {
    if (this.disposed) return [];
    this.lines = mergeIndexedLines(this.lines, incoming, priority);
    this.scheduleFlush();
    return this.lines;
  }

  replace(incoming: readonly IndexedRawLine[]): IndexedRawLine[] {
    if (this.disposed) return [];
    this.lines = mergeIndexedLines([], incoming, "forward");
    this.scheduleFlush();
    return this.lines;
  }

  async truncate(keepCount: number): Promise<IndexedRawLine[]> {
    this.lines = truncateIndexedLines(this.lines, keepCount);
    await this.flush();
    return this.lines;
  }

  reset(): Promise<IndexedRawLine[]> { return this.truncate(0); }

  scheduleFlush(delay = 200): void {
    if (this.disposed) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => void this.flush(), delay);
  }

  async flush(): Promise<void> {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.disposed) return;
    const plain = linesForPersistence(this.lines);
    try { await (await database()).put("sessions", { id: this.sessionId, lines: plain, updatedAt: Date.now() }); } catch { /* unavailable/quota */ }
  }

  dispose(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.lines = [];
    this.restored = false;
    this.disposed = true;
  }
}

export const MAX_RESIDENT_SESSION_CACHES = 6;
export class SessionCacheRegistry {
  private caches = new Map<string, RawSessionCache>();
  constructor(private readonly maxResident = MAX_RESIDENT_SESSION_CACHES) {}
  get(sessionId: string): RawSessionCache {
    let cache = this.caches.get(sessionId);
    if (cache) {
      this.caches.delete(sessionId);
      this.caches.set(sessionId, cache);
      return cache;
    }
    cache = new RawSessionCache(sessionId);
    this.caches.set(sessionId, cache);
    this.evictOverflow();
    return cache;
  }
  private evictOverflow(): void {
    while (this.caches.size > Math.max(1, this.maxResident)) {
      const oldestId = this.caches.keys().next().value;
      if (typeof oldestId !== "string") break;
      const cache = this.caches.get(oldestId);
      this.caches.delete(oldestId);
      if (cache) void cache.flush().finally(() => cache.dispose());
    }
  }
  async release(sessionId: string): Promise<void> {
    const cache = this.caches.get(sessionId);
    if (!cache) return;
    this.caches.delete(sessionId);
    await cache.flush();
    cache.dispose();
  }
  residentCount(): number { return this.caches.size; }
  has(sessionId: string): boolean { return this.caches.has(sessionId); }
  async flushAll(): Promise<void> { await Promise.allSettled([...this.caches.values()].map((cache) => cache.flush())); }
}

export const sessionCaches = new SessionCacheRegistry();

export function installCacheFlushHandlers(registry = sessionCaches): () => void {
  const flush = () => { void registry.flushAll(); };
  const hidden = () => { if (document.visibilityState === "hidden") flush(); };
  window.addEventListener("pagehide", flush);
  window.addEventListener("beforeunload", flush);
  document.addEventListener("visibilitychange", hidden);
  return () => {
    window.removeEventListener("pagehide", flush);
    window.removeEventListener("beforeunload", flush);
    document.removeEventListener("visibilitychange", hidden);
  };
}

export async function putAttachment(id: string, blob: Blob, name: string): Promise<void> {
  await (await database()).put("attachments", { id, blob, name, type: blob.type });
}

export async function getAttachment(id: string): Promise<{ id: string; blob: Blob; name: string; type: string } | undefined> {
  return (await database()).get("attachments", id);
}

export async function deleteAttachment(id: string): Promise<void> { await (await database()).delete("attachments", id); }
