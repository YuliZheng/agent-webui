import { defineStore } from "pinia";

interface State {
  open: boolean;
  // The session the preview was opened from. The overlay only renders when
  // this matches the currently-selected session, so switching sessions
  // hides the preview without losing it — switching back restores it.
  sessionId: string | null;
  summary: string;
  path: string;
}

export const usePreviewModalStore = defineStore("preview-modal", {
  state: (): State => ({ open: false, sessionId: null, summary: "", path: "" }),
  actions: {
    show(sessionId: string | null, summary: string, path: string) {
      this.sessionId = sessionId;
      this.summary = summary;
      this.path = path;
      this.open = true;
    },
    close() {
      this.open = false;
    },
  },
});
