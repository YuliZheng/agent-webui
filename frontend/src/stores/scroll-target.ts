import { defineStore } from "pinia";

// One-shot per-session scroll target consumed by MessageList on next mount.
// Set by the sidebar when a content-search match is clicked, so the
// MessageList can land on the matching record instead of bottom-pinning.
//
// Lives in-memory only (transient by design — we don't want a stale target
// to fire on every page refresh).
interface State {
  bySession: Record<string, { uuid: string; query: string; lineIndex: number | null }>;
}

export const useScrollTargetStore = defineStore("scroll-target", {
  state: (): State => ({ bySession: {} }),
  actions: {
    set(sessionId: string, uuid: string, query: string, lineIndex: number | null = null) {
      if (!sessionId || !uuid) return;
      this.bySession[sessionId] = { uuid, query, lineIndex };
    },
    consume(sessionId: string): { uuid: string; query: string; lineIndex: number | null } | null {
      const v = this.bySession[sessionId];
      if (v) delete this.bySession[sessionId];
      return v ?? null;
    },
  },
});
