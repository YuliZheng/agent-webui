<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import {
  inspectLocalPath,
  listLocalDirectory,
  localFileContentUrl,
  readLocalFile,
  revealLocalPath,
  type LocalDirectoryResponse,
  type LocalFileResponse,
  type LocalPathInfo,
} from "../api/local-files.js";
import { highlightToHtml } from "../render/shiki.js";
import { renderMarkdown } from "../render/markdown.js";
import { useLocalFileViewerStore } from "../stores/local-file-viewer.js";
import { useNotificationsStore } from "../stores/notifications.js";
import { useUiStore } from "../stores/ui.js";
import { APP_BACK_PRIORITY, registerAppBackHandler } from "../util/app-back.js";
import {
  localDirectoryBehavior,
  setLocalDirectoryBehavior,
  supportsHostDirectoryBehavior,
  type LocalDirectoryBehavior,
} from "../util/local-file-device.js";
import { setPwaLayerActive } from "../util/pwa-history.js";
import { basenameFromPath, codexImageUrl, localFilePreviewKind, type LocalFilePreviewKind } from "../util/local-file-links.js";
import { useDark } from "../util/theme.js";

const viewer = useLocalFileViewerStore();
const ui = useUiStore();
const notifications = useNotificationsStore();
const scroller = ref<HTMLDivElement | null>(null);
const loading = ref(false);
const error = ref("");
const file = ref<LocalFileResponse | null>(null);
const pathInfo = ref<LocalPathInfo | null>(null);
const directory = ref<LocalDirectoryResponse | null>(null);
const currentPath = ref("");
const navigation = ref<string[]>([]);
const displayLine = ref<number | null>(null);
const highlightedLines = ref<string[]>([]);
const openingOnHost = ref(false);
const hostBehavior = ref<LocalDirectoryBehavior>(localDirectoryBehavior());
const canChooseHostBehavior = ref(supportsHostDirectoryBehavior());
const dark = useDark();
let loadToken = 0;
let unregisterAppBack: (() => void) | undefined;

const active = computed(() => viewer.open && viewer.sessionId === ui.selectedSessionId);
const previewKind = computed<LocalFilePreviewKind>(() => localFilePreviewKind(currentPath.value));
const contentUrl = computed(() => localFileContentUrl(currentPath.value));
const downloadUrl = computed(() => localFileContentUrl(currentPath.value, true));
const imageUrl = computed(() => codexImageUrl(currentPath.value));
const markdownHtml = computed(() => renderMarkdown(file.value?.content ?? ""));
const title = computed(() => pathInfo.value?.name || basenameFromPath(currentPath.value));
const lines = computed(() => (file.value?.content ?? "").split(/\r?\n/));
const targetLine = computed(() => currentPath.value === viewer.path ? viewer.line : null);
const canNavigateBack = computed(() => navigation.value.length > 0 || Boolean(directory.value?.parent));
const isOutsideAllowedRoots = computed(() => /outside allowed roots/i.test(error.value));

function languageFromPath(path: string): string {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    c: "c", cc: "cpp", cpp: "cpp", cs: "csharp", css: "css", go: "go", h: "c", hpp: "cpp",
    html: "html", java: "java", js: "js", jsx: "jsx", json: "json", jsonl: "json", kt: "kotlin",
    md: "md", mjs: "js", py: "py", rb: "ruby", rs: "rust", sh: "sh", sql: "sql", svelte: "svelte",
    toml: "toml", ts: "ts", tsx: "tsx", txt: "text", vue: "vue", xml: "xml", yaml: "yaml", yml: "yaml",
  };
  return map[ext] ?? "text";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function linesFromShiki(html: string, fallback: string[]): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const code = doc.querySelector("pre code");
  if (!code) return fallback.map(escapeHtml);
  const out = code.innerHTML.split("\n");
  return out.length ? out : fallback.map(escapeHtml);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (let i = 1; i < units.length && value >= 1024; i++) {
    value /= 1024;
    unit = units[i]!;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

function formatModified(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function kindLabel(path: string): string {
  const labels: Record<LocalFilePreviewKind, string> = {
    image: "Image",
    markdown: "Markdown",
    html: "HTML",
    pdf: "PDF",
    text: "Text",
    audio: "Audio",
    video: "Video",
    binary: "File",
  };
  return labels[localFilePreviewKind(path)];
}

function entryMeta(entry: LocalPathInfo): string {
  if (entry.kind === "directory") return "Folder";
  return [kindLabel(entry.path), formatBytes(entry.size)].filter(Boolean).join(" · ");
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
  if (!active.value || !currentPath.value) return;
  const token = ++loadToken;
  loading.value = true;
  error.value = "";
  file.value = null;
  pathInfo.value = null;
  directory.value = null;
  displayLine.value = targetLine.value;
  highlightedLines.value = [];
  try {
    const info = await inspectLocalPath(currentPath.value);
    if (token !== loadToken) return;
    pathInfo.value = info;
    currentPath.value = info.path;
    if (info.kind === "directory") {
      const result = await listLocalDirectory(info.path);
      if (token !== loadToken) return;
      directory.value = result;
      pathInfo.value = result;
      return;
    }
    const kind = localFilePreviewKind(info.path);
    if (["image", "html", "pdf", "audio", "video", "binary"].includes(kind)) return;
    const result = await readLocalFile(info.path, displayLine.value);
    if (token !== loadToken) return;
    file.value = result;
    if (kind === "text") await applyHighlight(token, result);
    await nextTick();
    if (displayLine.value) {
      scroller.value?.querySelector(`#L${displayLine.value}`)?.scrollIntoView({ block: "center" });
    }
  } catch (cause) {
    if (token !== loadToken) return;
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (token === loadToken) loading.value = false;
  }
}

function navigate(path: string) {
  if (!path || path === currentPath.value) return;
  navigation.value.push(currentPath.value);
  currentPath.value = path;
  void load();
}

function navigateBack() {
  const previous = navigation.value.pop();
  if (previous) {
    currentPath.value = previous;
    void load();
    return;
  }
  if (directory.value?.parent) navigate(directory.value.parent);
}

function openEntry(entry: LocalPathInfo) {
  navigate(entry.path);
}

async function openOnHost() {
  const path = pathInfo.value?.path || currentPath.value;
  if (!path || openingOnHost.value) return;
  openingOnHost.value = true;
  try {
    const result = await revealLocalPath(path);
    notifications.pushInfo("Opened on the host computer", { title: basenameFromPath(result.path) });
  } catch (cause) {
    notifications.pushError(cause instanceof Error ? cause.message : String(cause), { title: "Could not open on the host" });
  } finally {
    openingOnHost.value = false;
  }
}

function toggleHostBehavior() {
  hostBehavior.value = hostBehavior.value === "open-on-host" ? "browse" : "open-on-host";
  setLocalDirectoryBehavior(hostBehavior.value);
}

function close() {
  viewer.close();
}

function onKey(event: KeyboardEvent) {
  if (event.key !== "Escape" || !active.value) return;
  event.preventDefault();
  if (navigation.value.length) navigateBack();
  else close();
}

watch(() => [active.value, viewer.path, viewer.line] as const, () => {
  navigation.value = [];
  currentPath.value = viewer.path;
  void load();
}, { immediate: true });
watch(active, open => setPwaLayerActive("local-file-viewer", open, ui.selectedSessionId));
watch(dark, async () => {
  if (!active.value || !file.value || previewKind.value !== "text") return;
  const token = ++loadToken;
  await applyHighlight(token, file.value);
});

onMounted(() => {
  window.addEventListener("keydown", onKey);
  unregisterAppBack = registerAppBackHandler(() => {
    if (!active.value) return false;
    if (navigation.value.length) navigateBack();
    else close();
    return true;
  }, APP_BACK_PRIORITY.surface);
});
onUnmounted(() => {
  unregisterAppBack?.();
  window.removeEventListener("keydown", onKey);
});
</script>

<template>
  <div v-if="active" class="cw-local-file-viewer absolute inset-0 z-40 flex min-h-0 flex-col">
    <header class="cw-local-file-header shrink-0 border-b">
      <div class="flex min-h-16 items-center gap-2 px-3 py-2 md:px-4">
        <button
          v-if="canNavigateBack"
          type="button"
          class="cw-file-action flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
          title="Back"
          aria-label="Back"
          @click="navigateBack"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="h-5 w-5">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <div class="min-w-0 flex-1">
          <div class="truncate text-[15px] font-semibold" :title="title">{{ title || "File" }}</div>
          <div class="truncate font-mono text-[11px] opacity-55" :title="currentPath">{{ currentPath }}</div>
        </div>
        <button
          v-if="pathInfo"
          type="button"
          class="cw-file-action flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
          :disabled="openingOnHost"
          title="Open on host computer"
          aria-label="Open on host computer"
          @click="openOnHost"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-5 w-5">
            <path d="M3 7.5h6l2 2h10v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
            <path d="M12 16V9" />
            <path d="m9 12 3-3 3 3" />
          </svg>
        </button>
        <a
          v-if="pathInfo?.kind === 'file'"
          :href="downloadUrl"
          download
          class="cw-file-action flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
          title="Download file"
          aria-label="Download file"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="h-5 w-5">
            <path d="M12 3v12" />
            <path d="m7 10 5 5 5-5" />
            <path d="M5 21h14" />
          </svg>
        </a>
        <button
          type="button"
          class="cw-file-action flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
          title="Close file browser"
          aria-label="Close file browser"
          @click="close"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="h-5 w-5">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div v-if="directory" class="cw-directory-toolbar flex min-h-11 items-center gap-3 border-t px-4 text-xs">
        <span class="min-w-0 flex-1 truncate opacity-65">
          {{ directory.entries.length }} item{{ directory.entries.length === 1 ? '' : 's' }}{{ directory.truncated ? ' shown' : '' }}
        </span>
        <button
          v-if="canChooseHostBehavior"
          type="button"
          role="switch"
          :aria-checked="hostBehavior === 'open-on-host'"
          class="cw-host-behavior flex min-h-9 items-center gap-2 rounded-lg px-2.5 text-left"
          @click="toggleHostBehavior"
        >
          <span class="cw-switch-track" :class="hostBehavior === 'open-on-host' ? 'cw-switch-track-on' : ''">
            <span class="cw-switch-thumb" />
          </span>
          <span class="hidden sm:inline">Open folder links on PC</span>
          <span class="sm:hidden">Open on PC</span>
        </button>
      </div>
    </header>

    <div v-if="loading" class="flex flex-1 items-center justify-center text-sm opacity-60" aria-live="polite">
      Loading…
    </div>
    <div v-else-if="error" class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-sm" aria-live="polite">
      <template v-if="isOutsideAllowedRoots">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" class="h-10 w-10 opacity-40" aria-hidden="true">
          <path d="M3 7.5h6l2 2h10v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
          <path d="M12 13v3m0 3h.01" />
        </svg>
        <div class="text-base font-semibold">This path isn’t available inside WebUI</div>
        <p class="max-w-[34rem] text-sm opacity-65">
          For safety, WebUI can browse only folders used by your sessions. You can still reveal this path on the host computer.
        </p>
        <button
          v-if="canChooseHostBehavior"
          type="button"
          class="rounded-md bg-[var(--cw-accent)] px-3.5 py-2.5 text-sm font-semibold text-[var(--cw-accent-text)] disabled:opacity-50"
          :disabled="openingOnHost"
          @click="openOnHost"
        >
          {{ openingOnHost ? 'Opening…' : 'Open on host computer' }}
        </button>
      </template>
      <div v-else class="text-[var(--cw-danger)]">{{ error }}</div>
      <button type="button" class="cw-file-action rounded-md px-3 py-2 text-xs font-semibold" @click="load">
        Try again
      </button>
    </div>

    <div v-else-if="directory" class="cw-directory-list flex-1 min-h-0 overflow-auto overscroll-contain">
      <div v-if="!directory.entries.length" class="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" class="h-10 w-10 opacity-35">
          <path d="M3 7.5h6l2 2h10v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
        </svg>
        <div class="text-sm font-medium">This folder is empty</div>
      </div>
      <template v-else>
        <button
          v-for="entry in directory.entries"
          :key="`${entry.name}\u0000${entry.path}`"
          type="button"
          class="cw-directory-entry flex w-full items-center gap-3 border-b px-4 py-2.5 text-left"
          @click="openEntry(entry)"
        >
        <span class="cw-entry-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" aria-hidden="true">
          <svg v-if="entry.kind === 'directory'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="h-5 w-5">
            <path d="M3 7.5h6l2 2h10v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
          </svg>
          <svg v-else-if="localFilePreviewKind(entry.path) === 'image'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="h-5 w-5">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <circle cx="8.5" cy="9" r="1.5" />
            <path d="m4 17 4.5-4 3.5 3 3-2.5 5 4.5" />
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="h-5 w-5">
            <path d="M6 2h8l4 4v16H6z" />
            <path d="M14 2v5h5" />
          </svg>
        </span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm font-medium">{{ entry.name }}</span>
          <span class="mt-0.5 block truncate text-[11px] opacity-55">{{ entryMeta(entry) }}<template v-if="entry.mtimeMs"> · {{ formatModified(entry.mtimeMs) }}</template></span>
        </span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4 shrink-0 opacity-35" aria-hidden="true">
          <path d="m9 18 6-6-6-6" />
        </svg>
        </button>
      </template>
      <div v-if="directory.truncated" class="px-4 py-3 text-center text-xs opacity-55">
        Showing the first 500 items. Open a smaller folder to narrow the list.
      </div>
    </div>

    <div v-else-if="previewKind === 'image'" class="flex flex-1 min-h-0 items-center justify-center overflow-auto p-4">
      <img :src="imageUrl" :alt="title" class="max-h-full max-w-full object-contain" />
    </div>
    <iframe v-else-if="previewKind === 'pdf'" :src="contentUrl" :title="title" class="flex-1 min-h-0 w-full border-0 bg-white" />
    <iframe
      v-else-if="previewKind === 'html'"
      :src="contentUrl"
      :title="title"
      sandbox="allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads"
      referrerpolicy="no-referrer"
      class="flex-1 min-h-0 w-full border-0 bg-white"
    />
    <article v-else-if="previewKind === 'markdown'" class="prose prose-sm dark:prose-invert max-w-none flex-1 min-h-0 overflow-auto break-words px-5 py-4" v-html="markdownHtml" />

    <div v-else-if="previewKind === 'audio' || previewKind === 'video' || previewKind === 'binary'" class="flex flex-1 items-center justify-center p-6">
      <div class="cw-download-state w-full max-w-md text-center">
        <span class="cw-entry-icon mx-auto flex h-14 w-14 items-center justify-center rounded-xl" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" class="h-7 w-7">
            <path d="M6 2h8l4 4v16H6z" />
            <path d="M14 2v5h5" />
          </svg>
        </span>
        <h2 class="mt-4 text-base font-semibold">{{ previewKind === 'audio' || previewKind === 'video' ? 'Download media file' : 'Preview unavailable' }}</h2>
        <p class="mx-auto mt-1.5 max-w-[36ch] text-sm opacity-60">
          {{ previewKind === 'audio' || previewKind === 'video' ? 'Media stays download-only to keep remote browsing fast and reliable.' : 'This file type is available as a download.' }}
        </p>
        <p v-if="pathInfo" class="mt-3 text-xs opacity-50">{{ kindLabel(pathInfo.path) }} · {{ formatBytes(pathInfo.size) }}</p>
        <a :href="downloadUrl" download class="mt-5 inline-flex min-h-11 items-center justify-center rounded-lg bg-[var(--cw-accent)] px-5 text-sm font-semibold text-[var(--cw-accent-text)]">
          Download file
        </a>
      </div>
    </div>

    <div v-else ref="scroller" class="cw-local-file-scroller flex-1 min-h-0 overflow-auto font-mono text-[12px] leading-5">
      <div class="min-w-max py-2">
        <div
          v-for="(line, index) in lines"
          :id="`L${index + 1}`"
          :key="index"
          class="cw-file-line flex min-h-5"
          :class="displayLine === index + 1 ? 'cw-file-line-target' : ''"
        >
          <a class="cw-local-file-line-no w-16 shrink-0 select-none border-r pr-3 text-right no-underline" :href="`#L${index + 1}`">{{ index + 1 }}</a>
          <span class="cw-local-file-code whitespace-pre px-3" v-html="highlightedLines[index] || ' '" />
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
.cw-directory-toolbar {
  background: color-mix(in srgb, var(--cw-header-bg, rgb(255 255 255)) 94%, var(--cw-text, rgb(17 24 39)) 6%);
  border-color: var(--cw-border, rgb(229 231 235));
}
.cw-file-action {
  color: inherit;
  opacity: 0.7;
  transition: background-color 140ms ease-out, opacity 140ms ease-out;
}
.cw-file-action:hover,
.cw-file-action:focus-visible,
.cw-host-behavior:hover,
.cw-host-behavior:focus-visible {
  background: var(--cw-control-hover, rgb(243 244 246));
  opacity: 1;
  outline: none;
}
.cw-file-action:disabled { opacity: 0.35; }
.cw-host-behavior { transition: background-color 140ms ease-out; }
.cw-switch-track {
  position: relative;
  width: 30px;
  height: 18px;
  flex: none;
  border-radius: 999px;
  background: color-mix(in srgb, var(--cw-muted, rgb(156 163 175)) 55%, transparent);
  transition: background-color 160ms ease-out;
}
.cw-switch-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: white;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.28);
  transition: transform 160ms ease-out;
}
.cw-switch-track-on { background: var(--cw-accent, #2563eb); }
.cw-switch-track-on .cw-switch-thumb { transform: translateX(12px); }
.cw-directory-list { padding-bottom: max(8px, env(safe-area-inset-bottom)); }
.cw-directory-entry { border-color: var(--cw-border, rgb(229 231 235)); }
.cw-directory-entry:hover,
.cw-directory-entry:focus-visible {
  background: var(--cw-control-hover, rgb(243 244 246));
  outline: none;
}
.cw-entry-icon {
  background: color-mix(in srgb, var(--cw-accent, #2563eb) 10%, transparent);
  color: var(--cw-accent, #2563eb);
}
.cw-local-file-scroller { background: var(--cw-code-block-bg, var(--cw-shell-bg, rgb(255 255 255))); }
.cw-file-line:hover { background: var(--cw-control-hover, rgb(243 244 246)); }
.cw-file-line-target { background: color-mix(in srgb, var(--cw-accent, #2563eb) 18%, transparent); }
.cw-local-file-line-no {
  color: var(--cw-muted, rgb(156 163 175));
  border-color: var(--cw-border, rgb(229 231 235));
}
.cw-local-file-code :deep(.line) { display: inline; }
@media (pointer: coarse) {
  .cw-directory-entry { min-height: 58px; }
  .cw-file-action { width: 44px; height: 44px; }
}
</style>
