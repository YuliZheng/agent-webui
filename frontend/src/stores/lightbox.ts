import { defineStore } from "pinia";

interface State {
  url: string | null;
  alt: string;
}

// Single shared lightbox: any thumbnail anywhere in the app calls open(url),
// the singleton modal mounted in App.vue listens to this store.
export const useLightboxStore = defineStore("lightbox", {
  state: (): State => ({ url: null, alt: "" }),
  actions: {
    open(url: string, alt: string = "") {
      this.url = url;
      this.alt = alt;
    },
    close() {
      this.url = null;
      this.alt = "";
    },
  },
});
