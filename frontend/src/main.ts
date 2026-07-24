import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import "./styles/index.css";
import { warmMarkdownHighlighter } from "./render/markdown";

createApp(App).use(createPinia()).mount("#app");
void warmMarkdownHighlighter();
