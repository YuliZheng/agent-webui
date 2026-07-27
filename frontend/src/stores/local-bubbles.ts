import { defineStore } from "pinia";

// Client-side "system bubble" for webui-local slash commands (/help, /mcp,
// /status, …). One bubble per session — a new command replaces the previous
// one. Nothing here touches the jsonl transcript or gets re-fed to the model;
// it's a pure UI overlay rendered above the composer (LocalInfoBubble.vue).
export interface LocalBubble {
  title: string;
  markdown: string;
  pending: boolean;
  error: boolean;
}

interface State {
  bySession: Record<string, LocalBubble>;
}

export const useLocalBubblesStore = defineStore("local-bubbles", {
  state: (): State => ({ bySession: {} }),
  actions: {
    // Show a pending bubble immediately (cli-info calls can take ~10s).
    begin(sessionId: string, title: string) {
      this.bySession[sessionId] = { title, markdown: "", pending: true, error: false };
    },
    show(sessionId: string, title: string, markdown: string) {
      this.bySession[sessionId] = { title, markdown, pending: false, error: false };
    },
    fail(sessionId: string, title: string, message: string) {
      this.bySession[sessionId] = { title, markdown: message, pending: false, error: true };
    },
    clear(sessionId: string) {
      delete this.bySession[sessionId];
    },
  },
});
