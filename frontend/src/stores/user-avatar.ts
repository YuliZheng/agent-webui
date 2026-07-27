import { defineStore } from "pinia";

interface State {
  revision: number;
  editorOpen: boolean;
}

export const useUserAvatarStore = defineStore("user-avatar", {
  state: (): State => ({
    revision: Date.now(),
    editorOpen: false,
  }),
  getters: {
    src: state => `/api/me/avatar?v=${state.revision}`,
  },
  actions: {
    edit() {
      this.editorOpen = true;
    },
    closeEditor() {
      this.editorOpen = false;
    },
    refresh() {
      this.revision = Math.max(Date.now(), this.revision + 1);
    },
  },
});
