import { defineStore } from "pinia";
import { useSessionsStore } from "./sessions.js";
import { useNotificationsStore } from "./notifications.js";

export type ThemeMode = "auto" | "dark" | "light";
export type EnterBehavior = "send" | "newline";

const ENTER_BEHAVIOR_KEY = "cw:enterBehavior";

function loadEnterBehavior(): EnterBehavior {
  if (typeof localStorage === "undefined") return "send";
  try {
    const v = localStorage.getItem(ENTER_BEHAVIOR_KEY);
    if (v === "newline" || v === "send") return v;
  } catch { /* ignore */ }
  return "send";
}

function pushHistoryFor(id: string | null): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("session", id);
  else url.searchParams.delete("session");
  window.history.pushState({ sessionId: id }, "", url.toString());
}

// Drafts are deliberately NOT dropped on switch-away anymore (WeChat-style:
// a parked draft stays in the sidebar until the first send promotes it or
// the user deletes the row). The old dropIfEmptyDraft behavior silently ate
// drafts the user intended to come back to.

export const useUiStore = defineStore("ui", {
  state: () => ({
    selectedSessionId: null as string | null,
    sidebarOpen: false,
    theme: "auto" as ThemeMode,
    enterBehavior: loadEnterBehavior(),
    home: "" as string,
  }),
  actions: {
    // Intentional selection: push a browser-history entry. All user-initiated
    // session changes (sidebar click, fork, new-session created, +Here, etc.)
    // go through here. Browser back / Mouse4 / iOS edge-swipe-back fire
    // popstate, which the app routes to selectFromHistory.
    select(id: string | null) {
      if (id === this.selectedSessionId) return;
      this.selectedSessionId = id;
      if (id) {
        useSessionsStore().markRead(id);
        useNotificationsStore().dismissForSession(id);
      }
      // Auto-dismiss the mobile slide-in when the user picks a session.
      this.sidebarOpen = false;
      pushHistoryFor(id);
    },

    // Apply a selection coming from popstate (browser back/forward, mouse
    // back/forward, mobile edge-swipe). Don't pushState — popstate is
    // already a history transition.
    selectFromHistory(id: string | null) {
      if (id === this.selectedSessionId) return;
      this.selectedSessionId = id;
      if (id) {
        useSessionsStore().markRead(id);
        useNotificationsStore().dismissForSession(id);
      }
      this.sidebarOpen = false;
    },

    toggleSidebar() { this.sidebarOpen = !this.sidebarOpen; },
    setTheme(t: ThemeMode) { this.theme = t; },
    setEnterBehavior(v: EnterBehavior) {
      this.enterBehavior = v;
      if (typeof localStorage !== "undefined") {
        try { localStorage.setItem(ENTER_BEHAVIOR_KEY, v); } catch { /* ignore */ }
      }
    },
    setHome(h: string) { this.home = h; },
  },
});
