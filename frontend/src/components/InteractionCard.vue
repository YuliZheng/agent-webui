<script setup lang="ts">
import { computed } from "vue";
import { usePendingInteractionsStore, type PendingInteraction } from "../stores/pending-interactions.js";
import { useNotificationsStore } from "../stores/notifications.js";
import { renderMarkdown } from "../render/markdown.js";

// Generic tool permission row — rendered inline by ToolCall.vue next to the
// matching ▶ tool_use, or by MainPane's bottom strip as fallback during the
// brief window before the assistant message lands. Visual rhythm mirrors
// UserPromptBlock / AssistantBlock (px-4 py-2 + border-l-4 + tinted bg) so it
// reads as part of the conversation, not a popup. Amber stripe = "you need
// to do something here". In prod (with the --dangerously-skip-permissions
// wrapper) regular tools bypass can_use_tool, so this is mostly exercised by
// AskUserQuestion (which has its own renderer) and by dev / opt-in sessions.

const props = defineProps<{
  sessionId: string;
  interaction: PendingInteraction;
}>();

const store = usePendingInteractionsStore();
const notifications = useNotificationsStore();
const inflight = computed(() => store.isInflight(props.sessionId, props.interaction.requestId));

async function allow() {
  try {
    await store.respond(props.sessionId, props.interaction.requestId, { kind: "allow" });
  } catch (e) {
    notifications.pushError(e instanceof Error ? e.message : String(e), { title: "Allow failed" });
  }
}
async function deny() {
  try {
    await store.respond(props.sessionId, props.interaction.requestId, { kind: "deny", message: "User denied this tool call." });
  } catch (e) {
    notifications.pushError(e instanceof Error ? e.message : String(e), { title: "Deny failed" });
  }
}

// Plan-mode tools: ExitPlanMode carries the full plan as markdown in
// input.plan — render it properly (scrollable, untruncated) instead of the
// generic 600-char JSON dump. EnterPlanMode(-style) inputs have no plan body;
// for those the title row alone is enough. Only EnterPlanMode suppresses the
// JSON preview — if ExitPlanMode's input.plan is ever missing/non-string
// (SDK shape drift), fall through to the JSON dump rather than asking the
// user to approve a plan they can't see.
const suppressJson = computed(() => props.interaction.toolName === "EnterPlanMode");
const planHtml = computed(() => {
  if (props.interaction.toolName !== "ExitPlanMode") return "";
  const plan = props.interaction.input?.plan;
  return typeof plan === "string" && plan.trim() ? renderMarkdown(plan) : "";
});

const previewJson = computed(() => {
  try { return JSON.stringify(props.interaction.input ?? {}, null, 2).slice(0, 600); }
  catch { return ""; }
});
</script>

<template>
  <div class="px-4 py-2 border-l-4 border-[var(--cw-warning)] bg-[color-mix(in_srgb,var(--cw-warning)_10%,transparent)] text-sm">
    <div class="flex items-center gap-2 mb-1.5">
      <span class="text-[10px] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded bg-[color-mix(in_srgb,var(--cw-warning)_18%,transparent)] text-[var(--cw-warning)]">Permission</span>
      <span class="text-[13px] font-medium">{{ interaction.toolName ?? interaction.subtype }}</span>
      <span class="text-[11px] opacity-70 font-mono ml-auto">{{ interaction.requestId.slice(0,8) }}</span>
    </div>
    <div
      v-if="planHtml"
      class="max-h-[60vh] overflow-y-auto bg-white/70 dark:bg-black/30 rounded p-3 mb-2 prose prose-sm dark:prose-invert max-w-none break-words"
      v-html="planHtml"
    />
    <pre v-else-if="!suppressJson" class="text-[11px] bg-white/70 dark:bg-black/30 rounded p-2 overflow-x-auto mb-2">{{ previewJson }}</pre>
    <div class="flex gap-2 justify-end">
      <button
        type="button"
        class="px-3 py-1 text-xs rounded border border-[var(--cw-border)]  disabled:opacity-50"
        :disabled="inflight"
        @click="deny"
      >Deny</button>
      <button
        type="button"
        class="px-3 py-1 text-xs rounded bg-[var(--cw-warning)] text-[var(--cw-accent-text)] hover:brightness-95 disabled:opacity-50"
        :disabled="inflight"
        @click="allow"
      >Allow</button>
    </div>
  </div>
</template>
