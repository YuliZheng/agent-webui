import { defineStore } from "pinia";
import type { SkillEntry } from "@claude-webui/shared/api";
import { getSessionSkills } from "../api/skills.js";

interface State {
  bySession: Record<string, SkillEntry[]>;
  fetchedAt: Record<string, number>;
  loading: Record<string, boolean>;
}

// Mirror the backend skills-scanner TTL. Without a client-side expiry the
// store cached the FIRST fetch forever: opening the picker on a not-yet-
// spawned session returns the disk-scan fallback, and once the session
// actually spawns (CLI now reports its real, often richer slash_commands
// list via system/init) the popup kept showing the stale fallback until a
// full page reload. A short TTL makes the next open after expiry re-fetch
// and self-correct, matching the backend's own 30s cache window.
const TTL_MS = 30_000;

export const useSessionSkillsStore = defineStore("session-skills", {
  state: (): State => ({ bySession: {}, fetchedAt: {}, loading: {} }),
  getters: {
    list: (state) => (id: string): SkillEntry[] => state.bySession[id] ?? [],
  },
  actions: {
    // Fetch the merged skill list for a session and cache it for TTL_MS.
    // Concurrent callers during the in-flight fetch are coalesced via the
    // loading flag; a still-fresh cached entry short-circuits the RPC.
    async ensureLoaded(id: string, opts: { cwd?: string; agent?: "claude" | "codex" } = {}): Promise<void> {
      if (!id) return;
      if (this.loading[id]) return;
      const at = this.fetchedAt[id];
      if (this.bySession[id] && at !== undefined && Date.now() - at < TTL_MS) return;
      this.loading[id] = true;
      try {
        this.bySession[id] = await getSessionSkills(id, opts);
        this.fetchedAt[id] = Date.now();
      } catch {
        // Keep any prior list on transient failure rather than blanking the
        // picker; only seed an empty list if we never had one.
        if (!this.bySession[id]) this.bySession[id] = [];
      } finally {
        delete this.loading[id];
      }
    },
  },
});
