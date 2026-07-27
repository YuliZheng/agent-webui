import { defineStore } from "pinia";
import type { MessageDisplayStyle, PermissionMode, PrefsBlob, ThinkingTrigger } from "@claude-webui/shared/prefs";
import { EMPTY_PREFS, normalizeMessageDisplayStyle } from "@claude-webui/shared/prefs";
import { getPrefs, putPrefs } from "../api/prefs.js";

let writeTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 500;

interface State extends PrefsBlob {
  loaded: boolean;
  saveError: string | null;
}

export const usePrefsStore = defineStore("prefs", {
  state: (): State => ({ ...EMPTY_PREFS, loaded: false, saveError: null }),
  getters: {
    isPinnedSession: (state) => (id: string): boolean =>
      state.pinned.some((p) => p.kind === "session" && p.id === id),
    groupOf: (state) => (id: string): string | null => {
      for (const [name, g] of Object.entries(state.groups)) {
        if (g.sessions.includes(id)) return name;
      }
      return null;
    },
    groupNames: (state) => (): string[] => Object.keys(state.groups),
  },
  actions: {
    // Hydrate from a pre-fetched blob (e.g. window.__BOOT__.prefs baked
    // into the HTML by the backend). Skips the RPC roundtrip on first load.
    hydrate(blob: PrefsBlob) {
      this.hidden = blob.hidden;
      this.groups = blob.groups;
      this.pinned = blob.pinned;
      this.thinkingTrigger = blob.thinkingTrigger ?? "";
      this.autoRetitleEnabled = blob.autoRetitleEnabled ?? false;
      this.autoRetitleEvery = blob.autoRetitleEvery ?? 10;
      this.titleLanguage = blob.titleLanguage ?? "English";
      this.scratchEnabled = blob.scratchEnabled ?? true;
      this.scratchDir = blob.scratchDir ?? null;
      this.defaultModel = blob.defaultModel ?? "";
      this.defaultPermissionMode = blob.defaultPermissionMode ?? "";
      this.defaultCodexModel = blob.defaultCodexModel ?? "";
      this.defaultCodexEffort = blob.defaultCodexEffort ?? "";
      this.defaultCodexServiceTier = blob.defaultCodexServiceTier === "priority" ? "priority" : "";
      this.defaultCodexApproval = blob.defaultCodexApproval ?? "";
      this.showActiveSection = blob.showActiveSection ?? true;
      this.showPeerSessions = blob.showPeerSessions ?? false;
      this.showSubagentSessions = blob.showSubagentSessions ?? false;
      this.messageDisplayStyle = normalizeMessageDisplayStyle(blob.messageDisplayStyle);
      this.autoCompactWindow = blob.autoCompactWindow ?? null;
      this.codexAutoCompactWindow = blob.codexAutoCompactWindow ?? null;
      this.loaded = true;
    },
    async load() {
      this.hydrate(await getPrefs());
    },
    schedulePut() {
      if (writeTimer) clearTimeout(writeTimer);
      writeTimer = setTimeout(() => { void this.flush(); }, DEBOUNCE_MS);
    },
    async flush() {
      try {
        await putPrefs({
          hidden: this.hidden,
          groups: this.groups,
          pinned: this.pinned,
          thinkingTrigger: this.thinkingTrigger,
          autoRetitleEnabled: this.autoRetitleEnabled,
          autoRetitleEvery: this.autoRetitleEvery,
          titleLanguage: this.titleLanguage,
          scratchEnabled: this.scratchEnabled,
          scratchDir: this.scratchDir,
          defaultModel: this.defaultModel,
          defaultPermissionMode: this.defaultPermissionMode,
          defaultCodexModel: this.defaultCodexModel,
          defaultCodexEffort: this.defaultCodexEffort,
          defaultCodexServiceTier: this.defaultCodexServiceTier,
          defaultCodexApproval: this.defaultCodexApproval,
          showActiveSection: this.showActiveSection,
          showPeerSessions: this.showPeerSessions,
          showSubagentSessions: this.showSubagentSessions,
          messageDisplayStyle: this.messageDisplayStyle,
          // Derived/read-only mirrors of the CLI settings; backend strips them
          // before persisting, so these never land in prefs.json.
          autoCompactWindow: this.autoCompactWindow,
          codexAutoCompactWindow: this.codexAutoCompactWindow,
        });
        this.saveError = null;
      } catch (err) {
        this.saveError = (err as Error).message;
      }
    },
    setThinkingTrigger(t: ThinkingTrigger) {
      this.thinkingTrigger = t;
      this.schedulePut();
    },
    setAutoRetitleEnabled(v: boolean) {
      this.autoRetitleEnabled = v;
      this.schedulePut();
    },
    setAutoRetitleEvery(n: number) {
      this.autoRetitleEvery = n;
      this.schedulePut();
    },
    setTitleLanguage(v: string) {
      this.titleLanguage = v;
      this.schedulePut();
    },
    setScratchEnabled(v: boolean) {
      this.scratchEnabled = v;
      this.schedulePut();
    },
    setScratchDir(d: string | null) {
      this.scratchDir = d;
      this.schedulePut();
    },
    setDefaultModel(m: string) {
      this.defaultModel = m;
      this.schedulePut();
    },
    setDefaultPermissionMode(m: PermissionMode | "") {
      this.defaultPermissionMode = m;
      this.schedulePut();
    },
    setDefaultCodexModel(m: string) {
      this.defaultCodexModel = m;
      this.schedulePut();
    },
    setDefaultCodexEffort(m: string) {
      this.defaultCodexEffort = m;
      this.schedulePut();
    },
    setDefaultCodexFast(enabled: boolean) {
      this.defaultCodexServiceTier = enabled ? "priority" : "";
      this.schedulePut();
    },
    setDefaultCodexApproval(m: string) {
      this.defaultCodexApproval = m;
      this.schedulePut();
    },
    setShowActiveSection(v: boolean) {
      this.showActiveSection = v;
      this.schedulePut();
    },
    setShowPeerSessions(v: boolean) {
      this.showPeerSessions = v;
      this.schedulePut();
    },
    setShowSubagentSessions(v: boolean) {
      this.showSubagentSessions = v;
      this.schedulePut();
    },
    setMessageDisplayStyle(v: MessageDisplayStyle) {
      this.messageDisplayStyle = normalizeMessageDisplayStyle(v);
      this.schedulePut();
    },
    hide(id: string) {
      if (!this.hidden.includes(id)) this.hidden.push(id);
      this.schedulePut();
    },
    unhide(id: string) {
      this.hidden = this.hidden.filter((x) => x !== id);
      this.schedulePut();
    },
    pin(item: PrefsBlob["pinned"][number]) {
      const exists = this.pinned.some((p) =>
        p.kind === item.kind &&
        ((p.kind === "session" && (item as { kind: "session"; id: string }).id === (p as { kind: "session"; id: string }).id) ||
         (p.kind === "group" && (item as { kind: "group"; name: string }).name === (p as { kind: "group"; name: string }).name)));
      if (!exists) this.pinned.push(item);
      this.schedulePut();
    },
    unpin(item: PrefsBlob["pinned"][number]) {
      this.pinned = this.pinned.filter((p) => !(
        p.kind === item.kind &&
        ((p.kind === "session" && (item as { kind: "session"; id: string }).id === (p as { kind: "session"; id: string }).id) ||
         (p.kind === "group" && (item as { kind: "group"; name: string }).name === (p as { kind: "group"; name: string }).name))
      ));
      this.schedulePut();
    },
    addGroup(name: string) {
      if (!this.groups[name]) this.groups[name] = { sessions: [] };
      this.schedulePut();
    },
    moveToGroup(id: string, groupName: string | null) {
      for (const g of Object.values(this.groups)) {
        g.sessions = g.sessions.filter((x) => x !== id);
      }
      if (groupName) {
        if (!this.groups[groupName]) this.groups[groupName] = { sessions: [] };
        this.groups[groupName]!.sessions.push(id);
      }
      this.schedulePut();
    },
  },
});
