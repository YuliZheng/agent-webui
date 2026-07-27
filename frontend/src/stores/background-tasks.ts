import { defineStore } from "pinia";
import type { BackgroundTask } from "@claude-webui/shared/api";
import { request } from "../api/ws.js";

// Per-session background-work list (subagents, workflows, background shells)
// pushed by the backend over the global WS channel (`background-tasks`) and
// fetched once per session view via `get-background-tasks`. The pill in
// MainPane flashes green briefly when a task completes (justCompleted).
interface State {
  bySession: Record<string, BackgroundTask[]>;
  // Session ids whose task list just gained a completion — drives the brief
  // green flash on the pill. Cleared by a timer.
  justCompleted: Record<string, boolean>;
}

const flashTimers = new Map<string, ReturnType<typeof setTimeout>>();
const FLASH_MS = 2500;

export const useBackgroundTasksStore = defineStore("background-tasks", {
  state: (): State => ({ bySession: {}, justCompleted: {} }),
  getters: {
    tasks: (s) => (id: string): BackgroundTask[] => s.bySession[id] ?? [],
    running: (s) => (id: string): BackgroundTask[] =>
      (s.bySession[id] ?? []).filter((t) => t.status === "running"),
  },
  actions: {
    apply(sessionId: string, tasks: BackgroundTask[]) {
      const prev = this.bySession[sessionId] ?? [];
      const prevDone = prev.filter((t) => t.status !== "running").length;
      const nowDone = tasks.filter((t) => t.status !== "running").length;
      this.bySession[sessionId] = tasks;
      if (nowDone > prevDone && prev.length > 0) this.flash(sessionId);
    },
    flash(sessionId: string) {
      this.justCompleted[sessionId] = true;
      const old = flashTimers.get(sessionId);
      if (old) clearTimeout(old);
      flashTimers.set(sessionId, setTimeout(() => {
        delete this.justCompleted[sessionId];
        flashTimers.delete(sessionId);
      }, FLASH_MS));
    },
    async fetch(sessionId: string) {
      try {
        const r = await request<{ tasks: BackgroundTask[] }>("get-background-tasks", { sessionId });
        if (r && Array.isArray(r.tasks)) this.apply(sessionId, r.tasks);
      } catch (err) {
        console.warn(`[background-tasks] fetch failed for ${sessionId}: ${(err as Error).message}`);
      }
    },
  },
});
