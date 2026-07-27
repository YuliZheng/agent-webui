import { defineStore } from "pinia";
import { insertAtCursor } from "../util/textarea.js";

const STORAGE_KEY = "cw:drafts:v1";
const FLUSH_DEBOUNCE_MS = 200;

interface State {
  bySession: Record<string, string>;
  // Per-session in-flight request count (regular Send).
  // Not persisted: page reload kills the requests too.
  inflightBySession: Record<string, number>;
  // Last time the user touched the draft for a session (Date.now()). Used by
  // the sidebar to bubble actively-edited sessions to the top, and to cover
  // the small lag between Send-click and claude actually writing the user
  // record into the jsonl. Not persisted across page reloads — re-typing
  // refreshes it and a stale draft naturally sinks back as new sessions
  // get touched on disk.
  editedAtBySession: Record<string, number>;
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let pending: Record<string, string> | null = null;

function loadFromStorage(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
  } catch {
    // corrupt — start fresh
  }
  return {};
}

function scheduleFlush(snapshot: Record<string, string>) {
  pending = snapshot;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!pending) return;
    try {
      // Drop empty entries to keep storage small.
      const compact: Record<string, string> = {};
      for (const [k, v] of Object.entries(pending)) {
        if (v && v.length > 0) compact[k] = v;
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(compact));
    } catch {
      // quota or unavailable — best effort
    }
    pending = null;
  }, FLUSH_DEBOUNCE_MS);
}

if (typeof window !== "undefined") {
  const flushNow = () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (pending) {
      try {
        const compact: Record<string, string> = {};
        for (const [k, v] of Object.entries(pending)) {
          if (v && v.length > 0) compact[k] = v;
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(compact));
      } catch { /* noop */ }
      pending = null;
    }
  };
  window.addEventListener("pagehide", flushNow);
  window.addEventListener("beforeunload", flushNow);
}

export const useDraftsStore = defineStore("drafts", {
  state: (): State => ({ bySession: loadFromStorage(), inflightBySession: {}, editedAtBySession: {} }),
  getters: {
    text: (state) => (id: string): string => state.bySession[id] ?? "",
    inflight: (state) => (id: string): number => state.inflightBySession[id] ?? 0,
    isInflight: (state) => (id: string): boolean => (state.inflightBySession[id] ?? 0) > 0,
    editedAt: (state) => (id: string): number => state.editedAtBySession[id] ?? 0,
  },
  actions: {
    set(id: string, text: string) {
      if (!id) return;
      if (text === "" && !(id in this.bySession)) return;
      this.bySession[id] = text;
      this.editedAtBySession[id] = Date.now();
      scheduleFlush({ ...this.bySession });
    },
    clear(id: string) {
      if (!(id in this.bySession)) return;
      delete this.bySession[id];
      scheduleFlush({ ...this.bySession });
    },
    // Clear only if the current draft still equals `expected`. Used by Send so
    // a successful in-flight request doesn't wipe new edits made during the
    // request. Returns true if it cleared.
    clearIfMatches(id: string, expected: string): boolean {
      if (!id) return false;
      const cur = this.bySession[id] ?? "";
      if (cur !== expected) return false;
      this.clear(id);
      return true;
    },
    // Restore a prompt that was cleared when its WebSocket frame dispatched
    // but whose RPC later failed. If something else has populated the
    // composer in the meantime, keep both texts instead of overwriting the
    // newer draft.
    restoreBefore(id: string, restored: string) {
      if (!id || !restored) return;
      const current = this.bySession[id] ?? "";
      if (!current) {
        this.set(id, restored);
        return;
      }
      if (current === restored) return;
      this.set(id, `${restored}\n\n${current}`);
    },
    // Move composer state when a frontend-only draft becomes a real session.
    // Keep the in-flight count so the promoted composer cannot submit a
    // second prompt while the first new-session RPC is still settling.
    moveSession(fromId: string, toId: string) {
      if (!fromId || !toId || fromId === toId) return;
      const fromText = this.bySession[fromId] ?? "";
      const toText = this.bySession[toId] ?? "";
      if (fromText) {
        this.bySession[toId] = toText && toText !== fromText
          ? `${fromText}\n\n${toText}`
          : fromText;
      }
      delete this.bySession[fromId];

      const inflight = this.inflightBySession[fromId] ?? 0;
      if (inflight > 0) {
        this.inflightBySession[toId] = (this.inflightBySession[toId] ?? 0) + inflight;
      }
      delete this.inflightBySession[fromId];

      const editedAt = this.editedAtBySession[fromId] ?? 0;
      if (editedAt > 0) {
        this.editedAtBySession[toId] = Math.max(this.editedAtBySession[toId] ?? 0, editedAt);
      }
      delete this.editedAtBySession[fromId];
      scheduleFlush({ ...this.bySession });
    },
    // Append text to draft, with a leading space if current text is non-empty
    // and doesn't already end with whitespace, and insertion doesn't start with whitespace.
    append(id: string, insertion: string) {
      if (!id || !insertion) return;
      const current = this.bySession[id] ?? "";
      const len = current.length;
      const result = insertAtCursor(current, len, len, insertion);
      this.set(id, result.text);
    },
    beginInflight(id: string) {
      if (!id) return;
      this.inflightBySession[id] = (this.inflightBySession[id] ?? 0) + 1;
    },
    endInflight(id: string) {
      if (!id) return;
      const next = (this.inflightBySession[id] ?? 0) - 1;
      if (next <= 0) delete this.inflightBySession[id];
      else this.inflightBySession[id] = next;
    },
  },
});
