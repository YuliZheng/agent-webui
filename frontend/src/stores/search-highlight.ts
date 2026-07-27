import { defineStore } from "pinia";

// Single source of truth for "what query should MessageList visually
// highlight". Set by Sidebar whenever the search box has tokens, cleared
// when empty. MessageList watches this + content changes and uses the CSS
// Custom Highlight API to paint matches yellow without mutating the DOM.
interface State {
  query: string;
}

export const useSearchHighlightStore = defineStore("search-highlight", {
  state: (): State => ({ query: "" }),
  actions: {
    set(q: string) {
      this.query = q;
    },
    clear() {
      this.query = "";
    },
  },
});
