import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import "./styles/index.css";
import "katex/dist/katex.min.css";
import { observeCodeFences, stopObservingCodeFences } from "./render/code-fence-mounting";

const app = createApp(App);
app.directive("code-fences", {
  mounted(element: HTMLElement) {
    observeCodeFences(element);
  },
  updated(element: HTMLElement) {
    observeCodeFences(element);
  },
  beforeUnmount(element: HTMLElement) {
    stopObservingCodeFences(element);
  }
});
app.use(createPinia()).mount("#app");
