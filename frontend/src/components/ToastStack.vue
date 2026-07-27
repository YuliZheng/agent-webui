<script setup lang="ts">
import { useNotificationsStore, type Toast } from "../stores/notifications.js";
import { usePendingInteractionsStore } from "../stores/pending-interactions.js";
import { useUiStore } from "../stores/ui.js";

const notifications = useNotificationsStore();
const pendingInteractions = usePendingInteractionsStore();
const ui = useUiStore();

function open(t: Toast) {
  if ((t.kind === "session" || t.kind === "permission" || t.kind === "question") && t.sessionId) {
    ui.select(t.sessionId);
  }
  // Permission / question toasts: clicking the body jumps to the session but
  // DOESN'T dismiss — the user still needs to answer in the inline form (or
  // via the toast's Allow/Deny buttons for permission). The
  // interaction-removed broadcast clears it via dismissByRequestId.
  // Session / others: dismiss on click since the message is consumed.
  if (t.kind !== "permission" && t.kind !== "question") notifications.dismiss(t.key);
}

function classFor(t: Toast): string {
  switch (t.kind) {
    case "error":
      return "cw-toast-error";
    case "info":
      return "cw-toast-info";
    case "permission":
      return "cw-toast-permission";
    case "question":
      return "cw-toast-question";
    default:
      return "bg-[var(--cw-panel-bg)] border-[var(--cw-border)] ";
  }
}

function clickable(t: Toast): boolean {
  return (t.kind === "session" || t.kind === "permission" || t.kind === "question") && !!t.sessionId;
}

// Neutral toasts (session / generic) use the plain gray/white surface, which
// looked out-of-place against the warm/dark display skins. Tag them so the
// <style> block below can repaint them with the active skin's --cw-* vars.
// Semantic kinds (error/info/permission/question) keep their own colors in
// every skin so they stay recognizable.
function isNeutral(t: Toast): boolean {
  return t.kind !== "error" && t.kind !== "info" && t.kind !== "permission" && t.kind !== "question";
}

async function allowFromToast(t: Toast) {
  if (t.kind !== "permission" || !t.sessionId || !t.requestId) return;
  try {
    await pendingInteractions.respond(t.sessionId, t.requestId, { kind: "allow" });
  } catch (e) {
    notifications.pushError(e instanceof Error ? e.message : String(e), { title: "Allow failed" });
  }
  // Backend will broadcast interaction-removed → dismissByRequestId clears
  // the toast. Optimistic clear here keeps the UI snappy on slow links.
  notifications.dismiss(t.key);
}

async function denyFromToast(t: Toast) {
  if (t.kind !== "permission" || !t.sessionId || !t.requestId) return;
  try {
    await pendingInteractions.respond(t.sessionId, t.requestId, { kind: "deny", message: "User denied this tool call." });
  } catch (e) {
    notifications.pushError(e instanceof Error ? e.message : String(e), { title: "Deny failed" });
  }
  notifications.dismiss(t.key);
}
</script>

<template>
  <div class="fixed top-4 right-4 z-50 flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)] pointer-events-none">
    <div
      v-for="t in notifications.items"
      :key="t.key"
      :class="['cw-toast pointer-events-auto rounded-lg shadow-lg border p-3 transition-colors', classFor(t), isNeutral(t) ? 'cw-toast-neutral' : '', clickable(t) ? 'cursor-pointer hover:bg-[var(--cw-panel-2)]' : '']"
      @click="clickable(t) && open(t)"
    >
      <div class="flex items-start gap-2">
        <div class="min-w-0 flex-1">
          <div
            v-if="t.title"
            :class="['cw-toast-title font-semibold text-sm truncate', t.kind === 'error' ? 'text-[var(--cw-danger)]' : t.kind === 'permission' ? 'text-[var(--cw-warning)]' : t.kind === 'question' ? 'text-[var(--cw-question-accent)]' : t.kind === 'info' ? 'text-[var(--cw-info)]' : 'text-[var(--cw-text)] ']"
          >
            {{ t.title }}
          </div>
          <div
            v-if="t.body"
            :class="['cw-toast-body text-xs line-clamp-3 break-words', t.title ? 'mt-1' : '', t.kind === 'error' ? 'text-[var(--cw-danger)]' : t.kind === 'permission' ? 'text-[var(--cw-warning)]' : t.kind === 'question' ? 'text-[var(--cw-question-accent)]' : t.kind === 'info' ? 'text-[var(--cw-info)]' : 'text-[var(--cw-text)] ']"
          >
            {{ t.body }}
          </div>
          <div v-else-if="t.kind === 'session'" class="cw-toast-sub mt-1 text-xs text-[var(--cw-text)]  italic">Session finished</div>
          <div v-if="t.kind === 'permission'" class="mt-2 flex gap-2 justify-end" @click.stop>
            <button
              type="button"
              class="px-2.5 py-1 text-xs rounded border border-[var(--cw-border)] bg-[var(--cw-panel-bg)] hover:bg-[var(--cw-panel-2)]"
              @click.stop="denyFromToast(t)"
            >Deny</button>
            <button
              type="button"
              class="cw-toast-allow px-2.5 py-1 text-xs rounded text-[var(--cw-accent-text)] hover:brightness-95"
              @click.stop="allowFromToast(t)"
            >Allow</button>
          </div>
        </div>
        <button
          class="text-[var(--cw-muted)] hover:text-[var(--cw-text)] text-lg leading-none"
          @click.stop="notifications.dismiss(t.key)"
          aria-label="Dismiss"
        >×</button>
      </div>
    </div>
  </div>
</template>

<style>
/* Semantic toast cards. Background = status colour at a low alpha over the
   skin's panel surface (opaque card), border/text = the status colour itself.
   One token per kind covers light and dark across every skin. */
.cw-toast-error {
  background-color: color-mix(in srgb, var(--cw-danger) 12%, var(--cw-panel-bg));
  border-color: color-mix(in srgb, var(--cw-danger) 45%, var(--cw-border));
}
.cw-toast-info {
  background-color: color-mix(in srgb, var(--cw-info) 12%, var(--cw-panel-bg));
  border-color: color-mix(in srgb, var(--cw-info) 45%, var(--cw-border));
}
.cw-toast-permission {
  background-color: color-mix(in srgb, var(--cw-warning) 14%, var(--cw-panel-bg));
  border-color: color-mix(in srgb, var(--cw-warning) 45%, var(--cw-border));
}
.cw-toast-question {
  background-color: color-mix(in srgb, var(--cw-question-accent) 12%, var(--cw-panel-bg));
  border-color: color-mix(in srgb, var(--cw-question-accent) 45%, var(--cw-border));
}
.cw-toast-allow {
  background-color: var(--cw-success);
}

/* Neutral toasts follow the active display skin instead of the fixed gray/white
   card. Driven by the same --cw-* vars every skin defines on <html> (see
   tailwind.css `html.cw-style-*`). `current` defines no vars, so it's excluded
   and falls through to the Tailwind utility classes untouched. Semantic toast
   kinds keep their own colors and are never tagged .cw-toast-neutral. */
html[class*="cw-style-"]:not(.cw-style-current) .cw-toast-neutral {
  background-color: var(--cw-panel-bg) !important;
  border-color: var(--cw-border) !important;
  color: var(--cw-text) !important;
}
html[class*="cw-style-"]:not(.cw-style-current) .cw-toast-neutral .cw-toast-title {
  color: var(--cw-text) !important;
}
html[class*="cw-style-"]:not(.cw-style-current) .cw-toast-neutral .cw-toast-body,
html[class*="cw-style-"]:not(.cw-style-current) .cw-toast-neutral .cw-toast-sub {
  color: var(--cw-muted) !important;
}
</style>
