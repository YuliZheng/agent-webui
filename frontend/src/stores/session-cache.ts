import { defineStore } from "pinia";
import { loadSessionCache, saveSessionCache } from "../persist/idb.js";

interface PerSession {
  lines: string[];
  nextLineIndex: number;
  // Smallest absolute index containing real content (not a sparse empty pad).
  // Parser/pending-prompt reconciliation uses this visible-data boundary;
  // physical history fetches use loadedFromIndex below.
  firstLoadedIndex: number;
  // Lowest physical source index whose range has been fetched. This is
  // deliberately separate from firstLoadedIndex: a fetched range may contain
  // only backend-filtered bookkeeping and therefore add no visible line.
  // null means "coverage is not known yet"; 0 means the prefix is complete.
  loadedFromIndex: number | null;
  // IDB is consulted at most once for the lifetime of this in-memory entry.
  hydrated: boolean;
  // Only authoritative rewrites invalidate an in-flight restore. Ordinary
  // live appends must still merge with the older cached prefix when IDB lands.
  restoreEpoch: number;
  dirty: boolean;
  // Monotonic in-memory content generation. A flush only clears `dirty` when
  // the generation it snapshotted is still current after the async IDB write.
  revision: number;
  saveTimer: ReturnType<typeof setTimeout> | null;
}

interface State { bySession: Record<string, PerSession> }

const DEBOUNCE_MS = 200;
// Bound the amount of catch-up work one flush performs while a live transcript
// is changing continuously. One extra pass closes the ordinary append-during-
// write race; further changes retain `dirty` and use the normal debounce.
const MAX_COALESCED_FLUSH_PASSES = 2;

type CacheSnapshot = { id: string; lines: string[]; nextLineIndex: number; loadedFromIndex: number | null };
type CachedSnapshot = { id: string; lines: string[]; nextLineIndex: number; loadedFromIndex?: number | null };

function isOmittedRecord(raw: string | undefined): boolean {
  return typeof raw === "string" && raw.includes('"type":"agent-webui-record-omitted"');
}

function shouldReplaceCachedLine(current: string | undefined, incoming: string): boolean {
  return !current || (isOmittedRecord(current) && !isOmittedRecord(incoming));
}

// IDB writes for one session must preserve invocation order. In particular,
// clear(empty) must run after an older snapshot already in flight.
const writeTails = new Map<string, Promise<void>>();
const flushWork = new Map<string, Promise<void>>();
const restoreWork = new Map<string, Promise<void>>();

function enqueueWrite(value: CacheSnapshot): Promise<void> {
  const previous = writeTails.get(value.id) ?? Promise.resolve();
  const write = previous
    .catch(() => undefined)
    .then(() => saveSessionCache(value));
  let tracked!: Promise<void>;
  tracked = write.finally(() => {
    if (writeTails.get(value.id) === tracked) writeTails.delete(value.id);
  });
  writeTails.set(value.id, tracked);
  return tracked;
}

export const useSessionCacheStore = defineStore("session-cache", {
  state: (): State => ({ bySession: {} }),
  actions: {
    ensure(id: string): PerSession {
      if (!this.bySession[id]) {
        this.bySession[id] = {
          lines: [],
          nextLineIndex: 0,
          firstLoadedIndex: 0,
          loadedFromIndex: null,
          hydrated: false,
          restoreEpoch: 0,
          dirty: false,
          revision: 0,
          saveTimer: null,
        };
      }
      // Re-read so the returned reference is the reactive Proxy (not the raw object
      // we just assigned). Mutating through the raw reference would bypass Vue's
      // reactivity tracking and the UI would never re-render.
      return this.bySession[id]!;
    },
    async restore(id: string) {
      const entry = this.ensure(id);
      if (entry.hydrated) return;
      const existing = restoreWork.get(id);
      if (existing) return existing;
      const epochAtStart = entry.restoreEpoch;
      const work = (async () => {
        const cached = await loadSessionCache(id) as CachedSnapshot | undefined;
        if (this.bySession[id] !== entry) return;
        if (entry.restoreEpoch !== epochAtStart) {
          entry.hydrated = true;
          return;
        }
        if (!cached || cached.lines.length === 0) {
          entry.hydrated = true;
          return;
        }
        // MERGE rather than overwrite. Network replay can land while the IDB
        // read is pending; by the time it resolves entry.lines may therefore
        // contain fresher WS/HTTP tail rows. Overwriting would clobber them.
        //
        // Critical perf detail: do the merge on a plain Array first, THEN do a
        // single `entry.lines = next` reactive assignment. Touching entry.lines
        // per-slot would trigger Vue array reactivity 3000+ times on a long
        // session restore (~hundreds of ms even before computeds re-run). One
        // reassignment = one invalidation = one render pass.
        //
        // Rules:
        //   1. Only fill a slot from cache if entry.lines[i] is empty/missing.
        //      Network data is the freshest source of truth.
        //   2. nextLineIndex = max(network-known, cached).
        //   3. firstLoadedIndex = lowest non-empty slot (recomputed).
        const targetLen = Math.max(entry.lines.length, cached.lines.length);
        const next = new Array<string>(targetLen);
        for (let i = 0; i < targetLen; i++) {
          const cur = entry.lines[i] ?? "";
          if (cur) { next[i] = cur; continue; }
          const c = cached.lines[i];
          next[i] = c ?? "";
        }
        entry.lines = next;
        if (cached.nextLineIndex > entry.nextLineIndex) {
          entry.nextLineIndex = cached.nextLineIndex;
        }
        let first = next.length;
        for (let i = 0; i < next.length; i++) {
          if (next[i]) { first = i; break; }
        }
        entry.firstLoadedIndex = first;
        const inferredLoaded = first < next.length ? first : null;
        const loaded = cached.loadedFromIndex === undefined ? inferredLoaded : cached.loadedFromIndex;
        if (loaded !== null) {
          entry.loadedFromIndex = entry.loadedFromIndex === null
            ? loaded
            : Math.min(entry.loadedFromIndex, loaded);
        }
        entry.hydrated = true;
        entry.revision++;
        entry.dirty = true;
        this.scheduleSave(id);
      })();
      let tracked!: Promise<void>;
      tracked = work.finally(() => { if (restoreWork.get(id) === tracked) restoreWork.delete(id); });
      restoreWork.set(id, tracked);
      return tracked;
    },
    // Batched append: take a list of {index, raw} entries and update entry.lines
    // in a SINGLE reactive assignment (build the array off-reactivity, then
    // assign). 200 individual appendLine calls would each invalidate the
    // `lines` computed and force `timeline`/`decorated` to re-run over the full
    // array on every WS frame — the dominant cause of "10 s to first paint" on
    // long sessions. Doing one reassignment means timeline runs once.
    appendBatch(id: string, items: { index: number; raw: string }[]) {
      if (items.length === 0) return;
      const entry = this.ensure(id);
      let maxIdx = -1;
      let minIdx = Number.MAX_SAFE_INTEGER;
      for (const it of items) {
        if (it.index > maxIdx) maxIdx = it.index;
        if (it.index < minIdx) minIdx = it.index;
      }
      // Build a fresh array from current entry.lines + room for any new high
      // indices, then write the batch into it. Working on a plain Array avoids
      // triggering Vue array reactivity per-slot.
      const wasEmpty = entry.lines.every((line) => !line);
      const targetLen = Math.max(entry.lines.length, maxIdx + 1);
      const next = new Array<string>(targetLen);
      for (let i = 0; i < entry.lines.length; i++) next[i] = entry.lines[i] ?? "";
      for (let i = entry.lines.length; i < targetLen; i++) next[i] = "";
      for (const { index, raw } of items) {
        // Forward-stream wins over backfill: same rule as appendLine. If the
        // slot already had content, that came from a higher-priority source
        // (live WS, or a prior tail) — don't clobber.
        if (shouldReplaceCachedLine(next[index], raw)) next[index] = raw;
      }
      entry.lines = next;
      if (maxIdx + 1 > entry.nextLineIndex) entry.nextLineIndex = maxIdx + 1;
      if (entry.loadedFromIndex === null || wasEmpty || minIdx < entry.loadedFromIndex) entry.loadedFromIndex = minIdx;
      // firstLoadedIndex tracks lowest non-empty index for "Load earlier".
      if (entry.firstLoadedIndex === 0 && entry.lines[0] === "" && minIdx > 0) {
        entry.firstLoadedIndex = minIdx;
      } else if (minIdx < entry.firstLoadedIndex) {
        entry.firstLoadedIndex = minIdx;
      }
      entry.revision++;
      entry.dirty = true;
      this.scheduleSave(id);
    },
    // Authoritative replay after stream-reset. Replace the old snapshot and
    // apply the first replay batch in one reactive assignment so the message
    // pane never renders an empty intermediate frame.
    replaceBatch(id: string, items: { index: number; raw: string }[]) {
      if (items.length === 0) return;
      const entry = this.ensure(id);
      let maxIdx = -1;
      let minIdx = Number.MAX_SAFE_INTEGER;
      for (const item of items) {
        if (item.index > maxIdx) maxIdx = item.index;
        if (item.index < minIdx) minIdx = item.index;
      }
      const next = new Array<string>(maxIdx + 1).fill("");
      for (const { index, raw } of items) next[index] = raw;
      entry.lines = next;
      entry.nextLineIndex = maxIdx + 1;
      entry.firstLoadedIndex = minIdx;
      entry.loadedFromIndex = minIdx;
      entry.restoreEpoch++;
      entry.hydrated = true;
      entry.revision++;
      entry.dirty = true;
      this.scheduleSave(id);
    },
    appendLine(id: string, lineIndex: number, raw: string) {
      const entry = this.ensure(id);
      const wasEmpty = entry.lines.every((line) => !line);
      // Forward append (subscribe stream): grow nextLineIndex.
      if (lineIndex >= entry.nextLineIndex) {
        while (entry.lines.length < lineIndex) entry.lines.push("");
        entry.lines[lineIndex] = raw;
        entry.nextLineIndex = lineIndex + 1;
        // First time we see a real line, anchor firstLoadedIndex.
        if (entry.firstLoadedIndex === 0 && entry.lines[0] === "" && lineIndex > 0) {
          entry.firstLoadedIndex = lineIndex;
        } else if (lineIndex < entry.firstLoadedIndex) {
          entry.firstLoadedIndex = lineIndex;
        }
      } else {
        // Backfill (read-range "Load earlier"): fill in a slot below
        // firstLoadedIndex without touching nextLineIndex.
        if (shouldReplaceCachedLine(entry.lines[lineIndex], raw)) {
          entry.lines[lineIndex] = raw;
          if (lineIndex < entry.firstLoadedIndex) entry.firstLoadedIndex = lineIndex;
        }
      }
      if (entry.loadedFromIndex === null || wasEmpty || lineIndex < entry.loadedFromIndex) entry.loadedFromIndex = lineIndex;
      entry.revision++;
      entry.dirty = true;
      this.scheduleSave(id);
    },
    // Record physical range coverage even when every returned line was
    // filtered out and appendBatch therefore had no items to inspect.
    markLoadedFrom(id: string, fromIndex: number) {
      if (!Number.isFinite(fromIndex)) return;
      const normalized = Math.max(0, Math.floor(fromIndex));
      const entry = this.ensure(id);
      if (entry.loadedFromIndex !== null && normalized >= entry.loadedFromIndex) return;
      entry.loadedFromIndex = normalized;
      entry.revision++;
      entry.dirty = true;
      this.scheduleSave(id);
    },
    // Advance the physical JSONL/rollout high-water mark without allocating
    // sparse placeholder rows. The backend filters non-renderable Claude
    // bookkeeping records but preserves physical indexes; stream-cursor and
    // HTTP totalLines use this path so reconnect resumes after those hidden
    // records instead of replaying them forever.
    advanceCursor(id: string, nextIndex: number) {
      if (!Number.isFinite(nextIndex)) return;
      const normalized = Math.max(0, Math.floor(nextIndex));
      const entry = this.ensure(id);
      if (normalized <= entry.nextLineIndex) return;
      entry.nextLineIndex = normalized;
      entry.revision++;
      entry.dirty = true;
      this.scheduleSave(id);
    },
    scheduleSave(id: string) {
      const entry = this.ensure(id);
      if (entry.saveTimer) clearTimeout(entry.saveTimer);
      entry.saveTimer = setTimeout(() => { void this.flush(id); }, DEBOUNCE_MS);
    },
    async flush(id: string): Promise<void> {
      const existing = flushWork.get(id);
      if (existing) {
        await existing;
        // `clear()` may replace the entry while the old writer is active, or a
        // timer may join after a newer generation appears. The first waiter
        // starts exactly one successor; all others join it through this branch.
        if (this.bySession[id]?.dirty) await this.flush(id);
        return;
      }

      const work = (async () => {
        for (let pass = 0; pass < MAX_COALESCED_FLUSH_PASSES; pass++) {
          const entry = this.bySession[id];
          if (!entry || !entry.dirty) return;
          if (entry.saveTimer) { clearTimeout(entry.saveTimer); entry.saveTimer = null; }
          const revision = entry.revision;
          // structuredClone (used by IDB) can't serialize Vue's reactive
          // Proxy. Snapshot plain data before entering the serialized queue.
          await enqueueWrite({
            id,
            lines: [...entry.lines],
            nextLineIndex: entry.nextLineIndex,
            loadedFromIndex: entry.loadedFromIndex,
          });

          const current = this.bySession[id];
          // A clear/recreate owns a different entry and queues its own final
          // state after this write. Never mutate or resave the retired object.
          if (current !== entry) return;
          if (current.revision === revision) {
            current.dirty = false;
            return;
          }
          // A live append landed during the write. Keep dirty and use the next
          // bounded pass to persist the latest coalesced snapshot.
          current.dirty = true;
        }

        const current = this.bySession[id];
        if (current?.dirty) this.scheduleSave(id);
      })();

      let tracked!: Promise<void>;
      tracked = work.finally(() => {
        if (flushWork.get(id) === tracked) flushWork.delete(id);
      });
      flushWork.set(id, tracked);
      await tracked;
    },
    async flushAll() {
      const ids = Object.keys(this.bySession);
      await Promise.all(ids.map((id) => this.flush(id)));
    },
    async clear(id: string) {
      const entry = this.bySession[id];
      if (entry?.saveTimer) { clearTimeout(entry.saveTimer); entry.saveTimer = null; }
      delete this.bySession[id];
      // Share the same per-session queue as flush snapshots. If an older write
      // is already running, the empty state is guaranteed to land after it.
      try { await enqueueWrite({ id, lines: [], nextLineIndex: 0, loadedFromIndex: null }); } catch { /* noop */ }
    },
    // Smart truncation: keep the first `keepCount` lines, drop the rest.
    // Used by the stream-truncate handler so rewind doesn't have to re-stream
    // the whole conversation — the frontend already has those lines cached,
    // we just trim the tail.
    //
    // Flushes to IDB IMMEDIATELY (not debounced). restore()'s merge takes
    // max(WS, IDB) lengths, so a debounced save that hasn't landed yet leaves
    // the pre-rewind suffix in IDB; on the next reload restore would resurrect
    // those ghost lines because IDB length > WS length. Skipping the debounce
    // here closes that window — by the time this returns, the IDB-on-disk
    // state matches the in-memory truncation.
    truncateTo(id: string, keepCount: number) {
      const entry = this.bySession[id];
      if (!entry) return;
      if (entry.lines.length > keepCount) entry.lines = entry.lines.slice(0, keepCount);
      // stream-truncate is the server's exact physical line count. It must
      // move the cursor both backward (rewind) and forward (initial subscribe
      // where trailing records were filtered from the visible transcript).
      entry.nextLineIndex = Math.max(0, Math.floor(keepCount));
      if (entry.firstLoadedIndex >= keepCount) entry.firstLoadedIndex = Math.max(0, keepCount - 1);
      if (entry.loadedFromIndex === null || entry.loadedFromIndex > keepCount) {
        entry.loadedFromIndex = Math.max(0, Math.floor(keepCount));
      }
      entry.restoreEpoch++;
      entry.hydrated = true;
      entry.revision++;
      entry.dirty = true;
      // Cancel any pending debounced save so flush sees the latest state
      // exactly once instead of racing a stale schedule.
      if (entry.saveTimer) { clearTimeout(entry.saveTimer); entry.saveTimer = null; }
      void this.flush(id);
    },
  },
});
