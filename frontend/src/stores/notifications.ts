import { defineStore } from "pinia";

export type ToastKind = "session" | "error" | "info" | "permission" | "question";

export interface Toast {
  key: number;
  kind: ToastKind;
  // session-only fields (kind === "session")
  uuid?: string;
  sessionId?: string;
  cwd?: string;
  // permission / question fields
  requestId?: string;
  toolName?: string;
  // generic
  title: string;
  body: string;
  createdAt: number;
}

const MAX_VISIBLE = 5;
// Session-finish/copy toasts are backed by sidebar unread badges, so they only
// need a short visibility window. Permission toasts MUST stay until the user
// actually allows or denies — auto-dismissing would leave the model wedged
// waiting on a response nobody answers.
// 0 means "never auto-dismiss".
const AUTO_DISMISS_MS: Record<ToastKind, number> = {
  session: 7000,
  info: 15000,
  error: 20000,
  permission: 0,
  question: 0,
};

interface State {
  items: Toast[];
  seen: string[];
  seenSet: Set<string>;
}

let nextKey = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export const useNotificationsStore = defineStore("notifications", {
  state: (): State => ({
    items: [],
    seen: [],
    seenSet: new Set(),
  }),
  actions: {
    push(input: { uuid: string; sessionId: string; cwd: string; title: string; body: string }) {
      if (this.seenSet.has(input.uuid)) return;
      this.seenSet.add(input.uuid);
      this.seen.push(input.uuid);
      while (this.seen.length > 256) {
        const evicted = this.seen.shift();
        if (evicted) this.seenSet.delete(evicted);
      }
      this.append({ kind: "session", ...input });
    },
    pushError(message: string, opts: { title?: string } = {}) {
      this.append({ kind: "error", title: opts.title ?? "Error", body: message });
    },
    pushInfo(message: string, opts: { title?: string } = {}) {
      this.append({ kind: "info", title: opts.title ?? "", body: message });
    },
    // Permission toasts are deduped by requestId so the same can_use_tool
    // doesn't stack up (the backend fans interaction-added on both global +
    // per-session channels; the FE may receive it twice). Returning early
    // on an existing requestId means a re-fire just no-ops.
    pushPermission(input: { sessionId: string; cwd: string; requestId: string; toolName: string; body: string }) {
      for (const t of this.items) {
        if (t.kind === "permission" && t.requestId === input.requestId) return;
      }
      this.append({
        kind: "permission",
        sessionId: input.sessionId,
        cwd: input.cwd,
        requestId: input.requestId,
        toolName: input.toolName,
        title: `Permission: ${input.toolName}`,
        body: input.body,
      });
    },
    // AskUserQuestion toast: no Allow/Deny buttons — clicking jumps to the
    // session where the inline question form lives. Deduped by requestId
    // (backend fans interaction-added on global + per-session, FE may see it
    // twice).
    pushQuestion(input: { sessionId: string; cwd: string; requestId: string; body: string }) {
      for (const t of this.items) {
        if (t.kind === "question" && t.requestId === input.requestId) return;
      }
      this.append({
        kind: "question",
        sessionId: input.sessionId,
        cwd: input.cwd,
        requestId: input.requestId,
        title: "Question",
        body: input.body,
      });
    },
    // Dismiss the permission / question toast (if any) for this requestId.
    // Called when the backend says the pending is gone (answered by us or by
    // a peer tab, process died, etc.) — keeps the toast strip honest.
    dismissByRequestId(requestId: string) {
      const t = this.items.find(
        (x) => (x.kind === "permission" || x.kind === "question") && x.requestId === requestId,
      );
      if (t) this.dismiss(t.key);
    },
    append(input: Omit<Toast, "key" | "createdAt">) {
      const toast: Toast = { key: nextKey++, createdAt: Date.now(), ...input };
      this.items.push(toast);
      while (this.items.length > MAX_VISIBLE) {
        const dropped = this.items.shift();
        if (dropped) this.clearTimer(dropped.key);
      }
      const ttl = AUTO_DISMISS_MS[toast.kind];
      if (ttl > 0) {
        const t = setTimeout(() => { this.dismiss(toast.key); }, ttl);
        timers.set(toast.key, t);
      }
    },
    dismiss(key: number) {
      this.clearTimer(key);
      this.items = this.items.filter((t) => t.key !== key);
    },
    // Dismiss every toast tied to a particular session. Called when the user
    // opens that session: the toast about it is no longer informative because
    // the inline reply is right there.
    dismissForSession(sessionId: string) {
      const survivors: Toast[] = [];
      for (const t of this.items) {
        if (t.sessionId === sessionId) {
          this.clearTimer(t.key);
        } else {
          survivors.push(t);
        }
      }
      this.items = survivors;
    },
    clearTimer(key: number) {
      const t = timers.get(key);
      if (t) {
        clearTimeout(t);
        timers.delete(key);
      }
    },
  },
});
