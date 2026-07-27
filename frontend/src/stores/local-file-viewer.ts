import { defineStore } from "pinia";

interface State {
  open: boolean;
  sessionId: string | null;
  path: string;
  line: number | null;
}

export const useLocalFileViewerStore = defineStore("local-file-viewer", {
  state: (): State => ({ open: false, sessionId: null, path: "", line: null }),
  actions: {
    show(sessionId: string | null, path: string, line: number | null = null) {
      this.sessionId = sessionId;
      this.path = path;
      this.line = line;
      this.open = true;
    },
    close() {
      this.open = false;
    },
  },
});
