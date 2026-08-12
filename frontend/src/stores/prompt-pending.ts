import { defineStore } from "pinia";

// Per-session optimistic "I just hit Send" bubbles, shown immediately in the
// timeline instead of waiting for the backend round-trip + the real record to
// land on disk. Mid-turn Codex steers are anchored at their send boundary;
// ordinary pending/queued prompts remain at the live tail.
//
// Persisted to localStorage so a page refresh in the window between Send and
// the real record landing doesn't drop the message. This matters most for
// codex sessions: claude's CLI writes a durable `queue-operation` record to the
// jsonl ~140ms after Send (covers refresh on its own), but codex has NO durable
// record until it actually starts the turn and writes the user_message to the
// rollout — and a mid-turn `steer` is never written to the rollout at all.
// Persisting here means the message is never lost on refresh, and a steered
// message (which codex never echoes) stays visible permanently.
//
// A session holds a LIST (not one slot) so queueing several messages mid-turn
// keeps all of them instead of the last overwriting the earlier ones.
//
// Entries clear differently per agent (reconciled in MessageList):
//   - claude: once the session grew past the send-time line count (the real
//     user line / queue chip has landed and taken over).
//   - codex: only when a matching real user_message appears in the rollout; a
//     steered message with no echo persists indefinitely (it IS the record).
export interface PendingPrompt {
  id: string;
  text: string;
  imageCount: number;
  startedAt: number;
  // Physical source-line high-water mark at send time. Used by reconciliation
  // so historical identical prompts cannot clear a newly-created bubble.
  startedAtLineCount: number;
  // Backend session-file size at send time. Lets the sidebar detect when a
  // durable record has overtaken this optimistic entry without opening it.
  startedAtSessionSize?: number;
  agent: "claude" | "codex";
  // codex only: the session was mid-turn at send time, so the backend routed
  // this through turn/steer (injected into the live turn) rather than
  // turn/start. Drives the optimistic bubble status: "steered" vs "sending".
  steered?: boolean;
  // `sending` means the request is still waiting for an open WebSocket.
  // `dispatched` means the browser handed the frame to WebSocket and may
  // optimistically show agent activity while the backend resumes the thread.
  // `accepted` means the RPC completed; the entry remains only until the
  // source-of-truth rollout/jsonl record reconciles it.
  phase: "sending" | "dispatched" | "accepted";
}

interface State {
  bySession: Record<string, PendingPrompt[]>;
}

const LS_KEY = "cw:promptPending:v1";

function loadAll(): Record<string, PendingPrompt[]> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw) as unknown;
    if (!o || typeof o !== "object") return {};
    const out: Record<string, PendingPrompt[]> = {};
    for (const [sessionId, value] of Object.entries(o as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      out[sessionId] = value
        .filter((entry): entry is Omit<PendingPrompt, "phase"> & { phase?: unknown } =>
          !!entry && typeof entry === "object")
        .map(entry => ({
          ...entry,
          // Entries persisted by the previous version have already left the
          // browser. Treat them as accepted so refresh cannot resurrect a
          // misleading, permanent "sending…" label.
          phase: entry.phase === "sending" || entry.phase === "dispatched" || entry.phase === "accepted"
            ? entry.phase
            : "accepted",
        }));
    }
    return out;
  } catch {
    return {};
  }
}

export const usePromptPendingStore = defineStore("promptPending", {
  state: (): State => ({ bySession: loadAll() }),
  getters: {
    pending: (s) => (id: string): PendingPrompt[] => s.bySession[id] ?? [],
    latestStartedAt: (s) => (id: string): number => {
      let latest = 0;
      for (const entry of s.bySession[id] ?? []) {
        if (
          typeof entry.startedAt === "number"
          && Number.isFinite(entry.startedAt)
          && entry.startedAt > latest
        ) {
          latest = entry.startedAt;
        }
      }
      return latest;
    },
  },
  actions: {
    persist() {
      if (typeof localStorage === "undefined") return;
      try { localStorage.setItem(LS_KEY, JSON.stringify(this.bySession)); } catch { /* quota / disabled */ }
    },
    // Append a pending entry; returns its id so the caller can remove exactly
    // this one on send-failure (without clobbering other queued entries).
    add(
      sessionId: string,
      entry: {
        text: string;
        imageCount: number;
        startedAtLineCount: number;
        startedAtSessionSize?: number;
        agent: "claude" | "codex";
        steered?: boolean;
        phase?: PendingPrompt["phase"];
      },
    ): string {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      // Read through the reactive proxy on every access (don't cache the array
      // returned by the assignment — that's the raw target and pushing to it
      // skips Vue reactivity; see the Pinia gotcha in CLAUDE.md).
      if (!this.bySession[sessionId]) this.bySession[sessionId] = [];
      this.bySession[sessionId]!.push({
        id,
        text: entry.text,
        imageCount: entry.imageCount,
        startedAt: Date.now(),
        startedAtLineCount: entry.startedAtLineCount,
        ...(typeof entry.startedAtSessionSize === "number"
          ? { startedAtSessionSize: entry.startedAtSessionSize }
          : {}),
        agent: entry.agent,
        phase: entry.phase ?? "sending",
        ...(entry.steered ? { steered: true } : {}),
      });
      this.persist();
      return id;
    },
    markDispatched(sessionId: string, id: string) {
      const entry = this.bySession[sessionId]?.find(item => item.id === id);
      if (!entry || entry.phase !== "sending") return;
      entry.phase = "dispatched";
      this.persist();
    },
    markAccepted(sessionId: string, id: string) {
      const entry = this.bySession[sessionId]?.find(item => item.id === id);
      if (!entry) return;
      entry.phase = "accepted";
      this.persist();
    },
    remove(sessionId: string, id: string) {
      const list = this.bySession[sessionId];
      if (!list) return;
      const i = list.findIndex((e) => e.id === id);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) delete this.bySession[sessionId];
      this.persist();
    },
    // Preserve entry ids while a pending draft row is promoted. The async
    // send closure still holds the original id and must be able to mark or
    // remove that exact optimistic bubble after the RPC settles.
    moveSession(fromId: string, toId: string) {
      if (!fromId || !toId || fromId === toId) return;
      const moved = this.bySession[fromId] ?? [];
      const current = this.bySession[toId] ?? [];
      if (moved.length) {
        const movedIds = new Set(moved.map((entry) => entry.id));
        this.bySession[toId] = [...moved, ...current.filter((entry) => !movedIds.has(entry.id))];
      }
      delete this.bySession[fromId];
      this.persist();
    },
    clear(sessionId: string) {
      if (sessionId in this.bySession) {
        delete this.bySession[sessionId];
        this.persist();
      }
    },
  },
});
