import { defineStore } from "pinia";
import { loadSessionCache, saveSessionCache } from "../persist/idb.js";

interface PerSession {
  lines: string[];
  nextLineIndex: number;
  // Smallest absolute index for which we hold real content (not a sparse
  // empty pad). Used by "Load earlier" to fetch [firstLoadedIndex - N,
  // firstLoadedIndex) from the backend on demand. Defaults to nextLineIndex
  // when no real lines are present.
  firstLoadedIndex: number;
  dirty: boolean;
  saveTimer: ReturnType<typeof setTimeout> | null;
}

interface State { bySession: Record<string, PerSession> }

const DEBOUNCE_MS = 200;

export const useSessionCacheStore = defineStore("session-cache", {
  state: (): State => ({ bySession: {} }),
  actions: {
    ensure(id: string): PerSession {
      if (!this.bySession[id]) {
        this.bySession[id] = { lines: [], nextLineIndex: 0, firstLoadedIndex: 0, dirty: false, saveTimer: null };
      }
      // Re-read so the returned reference is the reactive Proxy (not the raw object
      // we just assigned). Mutating through the raw reference would bypass Vue's
      // reactivity tracking and the UI would never re-render.
      return this.bySession[id]!;
    },
    async restore(id: string) {
      const entry = this.ensure(id);
      const cached = await loadSessionCache(id);
      if (!cached || cached.lines.length === 0) return;
      // MERGE rather than overwrite. live.engage() subscribes to the WS
      // BEFORE awaiting restore, so by the time we land here entry.lines may
      // already contain WS-streamed tail lines (the freshest content from
      // disk). Overwriting would clobber them.
      //
      // Critical perf detail: do the merge on a plain Array first, THEN do a
      // single `entry.lines = next` reactive assignment. Touching entry.lines
      // per-slot would trigger Vue array reactivity 3000+ times on a long
      // session restore (~hundreds of ms even before computeds re-run). One
      // reassignment = one invalidation = one render pass.
      //
      // Rules:
      //   1. Only fill a slot from cache if entry.lines[i] is empty/missing.
      //      WS is source of truth — backend just read this from disk.
      //   2. nextLineIndex = max(WS-known, cached) — WS may have observed a
      //      growth past what cache last saw.
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
      const targetLen = Math.max(entry.lines.length, maxIdx + 1);
      const next = new Array<string>(targetLen);
      for (let i = 0; i < entry.lines.length; i++) next[i] = entry.lines[i] ?? "";
      for (let i = entry.lines.length; i < targetLen; i++) next[i] = "";
      for (const { index, raw } of items) {
        // Forward-stream wins over backfill: same rule as appendLine. If the
        // slot already had content, that came from a higher-priority source
        // (live WS, or a prior tail) — don't clobber.
        if (!next[index]) next[index] = raw;
      }
      entry.lines = next;
      if (maxIdx + 1 > entry.nextLineIndex) entry.nextLineIndex = maxIdx + 1;
      // firstLoadedIndex tracks lowest non-empty index for "Load earlier".
      if (entry.firstLoadedIndex === 0 && entry.lines[0] === "" && minIdx > 0) {
        entry.firstLoadedIndex = minIdx;
      } else if (minIdx < entry.firstLoadedIndex) {
        entry.firstLoadedIndex = minIdx;
      }
      entry.dirty = true;
      this.scheduleSave(id);
    },
    appendLine(id: string, lineIndex: number, raw: string) {
      const entry = this.ensure(id);
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
        if (entry.lines[lineIndex] === "" || entry.lines[lineIndex] === undefined) {
          entry.lines[lineIndex] = raw;
          if (lineIndex < entry.firstLoadedIndex) entry.firstLoadedIndex = lineIndex;
        }
      }
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
      entry.dirty = true;
      this.scheduleSave(id);
    },
    scheduleSave(id: string) {
      const entry = this.ensure(id);
      if (entry.saveTimer) clearTimeout(entry.saveTimer);
      entry.saveTimer = setTimeout(() => { void this.flush(id); }, DEBOUNCE_MS);
    },
    async flush(id: string) {
      const entry = this.bySession[id];
      if (!entry || !entry.dirty) return;
      if (entry.saveTimer) { clearTimeout(entry.saveTimer); entry.saveTimer = null; }
      // structuredClone (used by IDB) can't serialize Vue's reactive Proxy.
      // Spread into a plain array of plain strings.
      await saveSessionCache({
        id,
        lines: [...entry.lines],
        nextLineIndex: entry.nextLineIndex,
      });
      entry.dirty = false;
    },
    async flushAll() {
      const ids = Object.keys(this.bySession);
      await Promise.all(ids.map((id) => this.flush(id)));
    },
    async clear(id: string) {
      const entry = this.bySession[id];
      if (entry?.saveTimer) { clearTimeout(entry.saveTimer); entry.saveTimer = null; }
      delete this.bySession[id];
      try { await saveSessionCache({ id, lines: [], nextLineIndex: 0 }); } catch { /* noop */ }
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
      entry.dirty = true;
      // Cancel any pending debounced save so flush sees the latest state
      // exactly once instead of racing a stale schedule.
      if (entry.saveTimer) { clearTimeout(entry.saveTimer); entry.saveTimer = null; }
      void this.flush(id);
    },
  },
});
