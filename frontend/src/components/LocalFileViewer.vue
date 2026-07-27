<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { readLocalFile, type LocalFileResponse } from "../api/local-files.js";
import { highlightToHtml } from "../render/shiki.js";
import { useLocalFileViewerStore } from "../stores/local-file-viewer.js";
import { useUiStore } from "../stores/ui.js";
import { APP_BACK_PRIORITY, registerAppBackHandler } from "../util/app-back.js";
import { setPwaLayerActive } from "../util/pwa-history.js";
import { useDark } from "../util/theme.js";

const viewer = useLocalFileViewerStore();
const ui = useUiStore();
const scroller = ref<HTMLDivElement | null>(null);
const loading = ref(false);
const error = ref("");
const file = ref<LocalFileResponse | null>(null);
const highlightedLines = ref<string[]>([]);
const dark = useDark();
let loadToken = 0;
let unregisterAppBack: (() => void) | undefined;

const active = computed(() => viewer.open && viewer.sessionId === ui.selectedSessionId);
const title = computed(() => {
  const path = viewer.path;
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const base = trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
  return `${base}${viewer.line ? `:${viewer.line}` : ""}`;
});
const lines = computed(() => (file.value?.content ?? "").split(/\r?\n/));

function languageFromPath(path: string): string {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    c: "c",
    cc: "cpp",
    cpp: "cpp",
    cs: "csharp",
    css: "css",
    go: "go",
    h: "c",
    hpp: "cpp",
    html: "html",
    java: "java",
    js: "js",
    jsx: "jsx",
    json: "json",
    jsonl: "json",
    kt: "kotlin",
    md: "md",
    mjs: "js",
    py: "py",
    rb: "ruby",
    rs: "rust",
    sh: "sh",
    sql: "sql",
    svelte: "svelte",
    toml: "toml",
    ts: "ts",
    tsx: "tsx",
    txt: "text",
    vue: "vue",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
  };
  return map[ext] ?? "text";
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function linesFromShiki(html: string, fallback: string[]): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const code = doc.querySelector("pre code");
  if (!code) return fallback.map(escapeHtml);
  const raw = code.innerHTML;
  // Shiki emits newline-separated spans inside one code element. Splitting the
  // highlighted HTML preserves token spans per source line.
  const out = raw.split("\n");
  return out.length ? out : fallback.map(escapeHtml);
}

async function applyHighlight(token: number, result: LocalFileResponse) {
  const rawLines = result.content.split(/\r?\n/);
  try {
    const html = await highlightToHtml(result.content, languageFromPath(result.path), dark.value);
    if (token !== loadToken) return;
    highlightedLines.value = linesFromShiki(html, rawLines);
  } catch {
    if (token !== loadToken) return;
    highlightedLines.value = rawLines.map(escapeHtml);
  }
}

async function load() {
  if (!active.value || !viewer.path) return;
  const token = ++loadToken;
  loading.value = true;
  error.value = "";
  file.value = null;
  highlightedLines.value = [];
  try {
    const result = await readLocalFile(viewer.path, viewer.line);
    if (token !== loadToken) return;
    file.value = result;
    await applyHighlight(token, result);
    await nextTick();
    if (viewer.line) {
      scroller.value?.querySelector(`#L${viewer.line}`)?.scrollIntoView({ block: "center" });
    }
  } catch (e) {
    if (token !== loadToken) return;
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (token === loadToken) loading.value = false;
  }
}

watch(() => [active.value, viewer.path, viewer.line] as const, () => { void load(); }, { immediate: true });
watch(active, open => {
  setPwaLayerActive("local-file-viewer", open, ui.selectedSessionId);
});
watch(dark, async () => {
  if (!active.value || !file.value) return;
  const token = ++loadToken;
  await applyHighlight(token, file.value);
});

function close() {
  viewer.close();
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape" && active.value) {
    e.preventDefault();
    close();
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKey);
  unregisterAppBack = registerAppBackHandler(() => {
    if (!active.value) return false;
    close();
    return true;
  }, APP_BACK_PRIORITY.surface);
});
onUnmounted(() => {
  unregisterAppBack?.();
  window.removeEventListener("keydown", onKey);
});
</script>

<template>
  <div
    v-if="active"
    class="cw-local-file-viewer absolute inset-0 z-40 flex flex-col min-h-0"
  >
    <header class="cw-local-file-header shrink-0 flex items-center gap-3 px-4 py-3 border-b">
      <div class="min-w-0 flex-1">
        <div class="text-base font-semibold truncate" :title="title">{{ title }}</div>
        <div class="text-[11px] opacity-60 truncate font-mono" :title="viewer.path">{{ viewer.path }}</div>
      </div>
      <button
        type="button"
        class="cw-local-file-close w-9 h-9 rounded-full flex items-center justify-center opacity-70 hover:opacity-100 transition"
        title="Close file"
        aria-label="Close file"
        @click="close"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </header>

    <div v-if="loading" class="flex-1 flex items-center justify-center text-sm opacity-60">
      Loading file…
    </div>
    <div v-else-if="error" class="flex-1 flex flex-col items-center justify-center gap-3 text-sm text-[var(--cw-danger)] px-6 text-center">
      <div>{{ error }}</div>
      <button
        type="button"
        class="px-3 py-1.5 rounded-md bg-[var(--cw-accent)] text-[var(--cw-accent-text)] text-xs font-semibold hover:brightness-95 active:scale-95 transition"
        @click="load"
      >
        Retry
      </button>
    </div>
    <div
      v-else
      ref="scroller"
      class="cw-local-file-scroller flex-1 min-h-0 overflow-auto text-[12px] leading-5 font-mono"
    >
      <div class="min-w-max py-2">
        <div
          v-for="(line, i) in lines"
          :id="`L${i + 1}`"
          :key="i"
          class="cw-file-line flex min-h-5"
          :class="viewer.line === i + 1 ? 'cw-file-line-target' : ''"
        >
          <a
            class="cw-local-file-line-no shrink-0 w-16 pr-3 text-right select-none border-r no-underline"
            :href="`#L${i + 1}`"
          >{{ i + 1 }}</a>
          <span class="cw-local-file-code px-3 whitespace-pre" v-html="highlightedLines[i] || ' '" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cw-local-file-viewer {
  background: var(--cw-shell-bg, rgb(255 255 255));
  color: var(--cw-text, rgb(17 24 39));
}
.cw-local-file-header {
  background: var(--cw-header-bg, rgb(255 255 255));
  border-color: var(--cw-border, rgb(229 231 235));
}
.cw-local-file-close:hover {
  background: var(--cw-control-hover, rgb(243 244 246));
}
.cw-local-file-scroller {
  background: var(--cw-code-block-bg, var(--cw-shell-bg, rgb(255 255 255)));
}
.cw-file-line:hover {
  background: var(--cw-control-hover, rgb(243 244 246));
}
.cw-file-line-target {
  background: color-mix(in srgb, var(--cw-accent, #2563eb) 18%, transparent);
}
.cw-local-file-line-no {
  color: var(--cw-muted, rgb(156 163 175));
  border-color: var(--cw-border, rgb(229 231 235));
}
.cw-local-file-code :deep(.line) {
  display: inline;
}
</style>
