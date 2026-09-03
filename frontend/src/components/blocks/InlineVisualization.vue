<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";

const props = defineProps<{ sessionId: string; file: string }>();

const src = computed(() =>
  `/api/sessions/${encodeURIComponent(props.sessionId)}/visualization/${encodeURIComponent(props.file)}`,
);
const status = ref<"loading" | "ready" | "error">("loading");
const error = ref("");
let controller: AbortController | undefined;
let requestId = 0;

function responseError(statusCode: number): string {
  if (statusCode === 404) return "The visualization file is missing or belongs to a different conversation.";
  if (statusCode === 401) return "Your session authorization expired. Reload the page and try again.";
  if (statusCode === 403) return "This conversation is not allowed to open that visualization file.";
  return `The visualization could not be loaded (HTTP ${statusCode}).`;
}

async function load() {
  controller?.abort();
  controller = new AbortController();
  const currentRequest = ++requestId;
  status.value = "loading";
  error.value = "";
  try {
    const response = await fetch(src.value, {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(responseError(response.status));
    if (currentRequest === requestId) status.value = "ready";
  } catch (reason) {
    if (controller.signal.aborted || currentRequest !== requestId) return;
    error.value = reason instanceof Error && reason.message
      ? reason.message
      : "The visualization could not be loaded. Check your connection and try again.";
    status.value = "error";
  }
}

watch(src, () => { void load(); }, { immediate: true });
onBeforeUnmount(() => controller?.abort());

function open() {
  if (status.value !== "ready") return;
  window.open(window.location.origin + src.value, "_blank", "noopener");
}
</script>

<template>
  <section class="mx-4 my-2 overflow-hidden rounded-lg border border-[var(--cw-border)] bg-[var(--cw-panel-bg)]">
    <header class="flex items-center gap-2 border-b border-[var(--cw-border)] px-3 py-2 text-xs">
      <span class="font-semibold">▦ Interactive visualization</span>
      <span class="min-w-0 flex-1 truncate opacity-60" :title="file">{{ file }}</span>
      <button
        type="button"
        class="shrink-0 underline underline-offset-2 opacity-75 enabled:hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-35"
        :disabled="status !== 'ready'"
        @click="open"
      >
        Open
      </button>
    </header>
    <div
      v-if="status === 'loading'"
      class="flex min-h-44 items-center justify-center px-5 text-center text-xs text-[var(--cw-muted)]"
      aria-live="polite"
    >
      Loading visualization…
    </div>
    <div
      v-else-if="status === 'error'"
      class="flex min-h-44 flex-col items-center justify-center gap-2.5 px-6 py-8 text-center"
      role="alert"
    >
      <p class="text-sm font-semibold text-[var(--cw-danger)]">Visualization unavailable</p>
      <p class="max-w-md text-xs leading-relaxed text-[var(--cw-muted)]">{{ error }}</p>
      <button
        type="button"
        class="mt-1 rounded-md border border-[var(--cw-border)] bg-[var(--cw-panel-2)] px-3 py-1.5 text-xs font-medium hover:brightness-95"
        @click="load"
      >
        Retry
      </button>
    </div>
    <iframe
      v-else
      :src="src"
      :title="file"
      sandbox="allow-scripts"
      loading="lazy"
      class="block h-[420px] w-full border-0 bg-white"
    />
  </section>
</template>
