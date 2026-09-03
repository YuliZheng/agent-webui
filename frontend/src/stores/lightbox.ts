import { defineStore } from "pinia";
import {
  conversationImageGallery,
  type LightboxItem,
} from "../util/image-gallery.js";

interface State {
  url: string | null;
  alt: string;
  items: LightboxItem[];
  index: number;
}

// Single shared lightbox: any thumbnail anywhere in the app calls open(url),
// the singleton modal mounted in App.vue listens to this store.
export const useLightboxStore = defineStore("lightbox", {
  state: (): State => ({ url: null, alt: "", items: [], index: -1 }),
  actions: {
    open(url: string, alt: string = "", source?: Element | null) {
      const gallery = conversationImageGallery(source);
      if (gallery) {
        this.openGallery(gallery.items, gallery.index);
        return;
      }
      this.openGallery([{ url, alt }], 0);
    },
    openGallery(items: LightboxItem[], index = 0) {
      const validItems = items.filter((item) => !!item.url);
      if (!validItems.length) {
        this.close();
        return;
      }
      const nextIndex = Math.min(validItems.length - 1, Math.max(0, index));
      const current = validItems[nextIndex];
      if (!current) return;
      this.items = validItems;
      this.index = nextIndex;
      this.url = current.url;
      this.alt = current.alt;
    },
    select(index: number): boolean {
      const item = this.items[index];
      if (!item) return false;
      this.index = index;
      this.url = item.url;
      this.alt = item.alt;
      return true;
    },
    next(): boolean {
      return this.select(this.index + 1);
    },
    previous(): boolean {
      return this.select(this.index - 1);
    },
    close() {
      this.url = null;
      this.alt = "";
      this.items = [];
      this.index = -1;
    },
  },
});
