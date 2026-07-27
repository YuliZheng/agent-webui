import { defineStore } from "pinia";
import type {
  InteractionAdded,
  InteractionAnswer,
  InteractionRemoved,
  InteractionToolInput,
} from "@claude-webui/shared/api";
import { request } from "../api/ws.js";

// Pending interactions (control_request items the CLI fired and the user
// hasn't answered yet). Keyed by sessionId → requestId.
//
// Backend pushes interaction-added / interaction-removed over the per-session
// WS channel — live.ts:onSessionMsg routes them here. On WS reconnect /
// session re-engage, the backend replays the current snapshot, so this store
// does NOT need to persist to IndexedDB.
//
// First-tab-wins: when a peer tab answers, backend broadcasts
// interaction-removed{reason:"answered"} to all tabs and the others drop
// their cards. The respond() RPC may itself 404 if a peer beat us — we just
// remove locally and move on without showing an error toast.

export interface PendingInteraction {
  requestId: string;
  subtype: string; // "can_use_tool" today
  toolName?: string;
  input?: InteractionToolInput;
  // Lets the timeline inline the permission card next to its matching
  // tool_use row instead of stacking in MainPane's bottom strip.
  toolUseId?: string;
  receivedAt: string;
}

interface State {
  // sessionId → requestId → entry
  bySession: Record<string, Record<string, PendingInteraction>>;
  // Per-(session,request) "responding" flag — set true while interaction-respond
  // is in-flight, so the UI can disable the Allow/Deny buttons to prevent
  // double-clicks while we await the backend ack.
  inflight: Record<string, true>;
}

function key(sessionId: string, requestId: string): string {
  return `${sessionId}::${requestId}`;
}

export const usePendingInteractionsStore = defineStore("pending-interactions", {
  state: (): State => ({
    bySession: {},
    inflight: {},
  }),

  getters: {
    list: (state) => (sessionId: string): PendingInteraction[] => {
      const inner = state.bySession[sessionId];
      return inner ? Object.values(inner) : [];
    },
    count: (state) => (sessionId: string): number => {
      const inner = state.bySession[sessionId];
      return inner ? Object.keys(inner).length : 0;
    },
    isInflight: (state) => (sessionId: string, requestId: string): boolean => {
      return !!state.inflight[key(sessionId, requestId)];
    },
  },

  actions: {
    onAdded(evt: InteractionAdded) {
      let inner = this.bySession[evt.sessionId];
      if (!inner) { inner = {}; this.bySession[evt.sessionId] = inner; }
      inner[evt.requestId] = {
        requestId: evt.requestId,
        subtype: evt.subtype,
        ...(evt.toolName !== undefined ? { toolName: evt.toolName } : {}),
        ...(evt.input !== undefined ? { input: evt.input } : {}),
        ...(evt.toolUseId !== undefined ? { toolUseId: evt.toolUseId } : {}),
        receivedAt: evt.receivedAt,
      };
    },
    onRemoved(evt: InteractionRemoved) {
      const inner = this.bySession[evt.sessionId];
      if (!inner) return;
      delete inner[evt.requestId];
      if (Object.keys(inner).length === 0) delete this.bySession[evt.sessionId];
      delete this.inflight[key(evt.sessionId, evt.requestId)];
    },
    async respond(sessionId: string, requestId: string, answer: InteractionAnswer): Promise<void> {
      const k = key(sessionId, requestId);
      if (this.inflight[k]) return;
      this.inflight[k] = true;
      try {
        await request("interaction-respond", { sessionId, requestId, answer });
        // Backend pushes interaction-removed after success; clean local
        // optimistically too so the card disappears even if the push is
        // delayed.
        this.onRemoved({ type: "interaction-removed", sessionId, requestId, reason: "answered" });
      } catch (e) {
        // 404 means a peer tab already answered — silently drop. Other
        // errors should surface so the user knows their answer didn't land.
        const code = (e as { code?: number }).code;
        if (code === 404 || code === 410) {
          this.onRemoved({ type: "interaction-removed", sessionId, requestId, reason: "superseded" });
        } else {
          delete this.inflight[k];
          throw e;
        }
      }
    },
    /** Drop all pending for a session — used on session switch or clean-out. */
    clear(sessionId: string) {
      delete this.bySession[sessionId];
      // Best-effort: clear any inflight entries for this session.
      for (const k of Object.keys(this.inflight)) {
        if (k.startsWith(`${sessionId}::`)) delete this.inflight[k];
      }
    },
  },
});
