<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { TimelineNode, ToolPair } from "../../parser/group.js";
import { renderMarkdown } from "../../render/markdown.js";
import { observeCodeFences } from "../../render/code-fence-mounting.js";
import { useDark } from "../../util/theme.js";
import ToolCall from "./tool/ToolCall.vue";
import { rephrasePrompt } from "../../api/sessions.js";
import { useUiStore } from "../../stores/ui.js";
import { useDraftsStore } from "../../stores/drafts.js";
import { useNotificationsStore } from "../../stores/notifications.js";

const props = defineProps<{
  node: Extract<TimelineNode, { kind: "event" }>;
}>();
const ui = useUiStore();
const drafts = useDraftsStore();
const notifications = useNotificationsStore();

interface Item { kind: "text" | "tool" | "thinking"; text?: string; pair?: ToolPair }

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

const message = computed(() =>
  (props.node.record.message as { content?: unknown; stop_reason?: unknown; usage?: Usage } | undefined) ?? {},
);

const items = computed<Item[]>(() => {
  const m = message.value.content;
  const out: Item[] = [];
  if (!Array.isArray(m)) return out;
  let useIdx = 0;
  for (const b of m) {
    const o = b as any;
    if (o?.type === "text") out.push({ kind: "text", text: o.text ?? "" });
    else if (o?.type === "tool_use") {
      const pair = props.node.toolPairs?.[useIdx++];
      if (pair) out.push({ kind: "tool", pair });
    }
    // Skip signature-only thinking blocks (thinking:"") — they'd render a
    // pointless "Thinking… (0 chars)" row.
    else if (o?.type === "thinking" && typeof o.thinking === "string" && o.thinking.trim()) {
      out.push({ kind: "thinking", text: o.thinking });
    }
  }
  return out;
});

// Thinking is folded away by default: a single muted "✻ N" toggle in the
// block corner (below), never per-thought rows. Content items render normally.
const thinkingItems = computed(() => items.value.filter((it) => it.kind === "thinking"));
const contentItems = computed(() => items.value.filter((it) => it.kind !== "thinking"));
const showThinking = ref(false);

// Anthropic Usage Policy refusal. Claude Code emits this as a normal assistant
// text record (not isApiErrorMessage), so AssistantApiErrorBlock doesn't catch
// it — we discriminate here by either:
//   (a) stop_reason === "refusal" (the structural signal — empty content)
//   (b) text content marker "Claude Code is unable to respond to this request"
//       (the human-readable placeholder Claude Code writes on the follow-up
//       stop_sequence record, which is the one the user actually sees)
const REFUSAL_MARKER = "Claude Code is unable to respond to this request";
const isRefusal = computed(() => {
  if (message.value.stop_reason === "refusal") return true;
  const content = message.value.content;
  if (!Array.isArray(content)) return false;
  for (const b of content) {
    const o = b as { type?: string; text?: string };
    // The real refusal placeholder is a SHORT text block that STARTS with the
    // marker. Requiring "starts with" (not merely "contains") avoids a
    // false-positive when a normal reply quotes the marker text — e.g. a
    // conversation that's literally discussing this AUP error would otherwise
    // flag its own assistant replies as refusals.
    if (o.type === "text" && typeof o.text === "string" && o.text.trimStart().startsWith(REFUSAL_MARKER)) return true;
  }
  return false;
});

type RephraseState = "idle" | "loading" | "done" | "error";
const rephraseState = ref<RephraseState>("idle");
const rephraseErr = ref<string>("");
async function onRephrase() {
  const sid = ui.selectedSessionId;
  if (!sid || rephraseState.value === "loading") return;
  rephraseState.value = "loading";
  rephraseErr.value = "";
  try {
    const r = await rephrasePrompt(sid);
    drafts.set(sid, r.rephrasedText);
    rephraseState.value = "done";
    notifications.pushInfo(`Rephrased via ${r.model} — review the draft and hit Send.`, { title: "Rephrase" });
  } catch (e) {
    rephraseState.value = "error";
    rephraseErr.value = (e as Error).message || "rephrase failed";
  }
}

const root = ref<HTMLDivElement | null>(null);
const dark = useDark();
function rehighlight() {
  if (root.value) observeCodeFences(root.value, { dark: dark.value });
}
onMounted(rehighlight);
watch(items, () => rehighlight(), { flush: "post" });
watch(dark, () => rehighlight(), { flush: "post" });
</script>

<template>
  <div ref="root" class="cw-block cw-assistant-block">
    <!-- Refusal banner: shown when Anthropic's Usage Policy classifier blocks
         the turn. Pre-empts the normal text rendering below so the user can't
         miss it among regular replies. The Auto-rephrase button calls Haiku
         server-side to rewrite the last user prompt; result lands in the
         drafts store so PromptInput shows it pre-filled — user reviews and
         hits Send. -->
    <div
      v-if="isRefusal"
      class="px-4 py-2 border-l-4 border-[var(--cw-warning)] bg-[color-mix(in_srgb,var(--cw-warning)_12%,transparent)]"
    >
      <div class="flex items-center justify-between gap-3 mb-1">
        <div class="text-xs uppercase tracking-wider text-[var(--cw-warning)] font-semibold">
          🚫 Anthropic safety refusal
        </div>
        <button
          class="text-xs px-2.5 py-1 rounded-md font-medium transition disabled:opacity-50 disabled:cursor-not-allowed"
          :class="rephraseState === 'error'
            ? 'bg-[var(--cw-danger)] text-[var(--cw-accent-text)] hover:brightness-95'
            : 'bg-[var(--cw-accent)] text-[var(--cw-accent-text)] hover:brightness-95'"
          :disabled="rephraseState === 'loading'"
          @click="onRephrase"
          :title="rephraseState === 'error' ? rephraseErr : 'Rewrite the last user prompt via Haiku, then drop it in the input box for you to review'"
        >
          <span v-if="rephraseState === 'loading'">Rewriting…</span>
          <span v-else-if="rephraseState === 'done'">✓ Drafted — review &amp; Send</span>
          <span v-else-if="rephraseState === 'error'">Retry rephrase</span>
          <span v-else>Auto-rephrase &amp; retry</span>
        </button>
      </div>
      <div class="text-xs opacity-80 leading-snug">
        Usage Policy false-positive — request itself is fine, but the
        classifier flagged something in the prompt or context. Auto-rephrase
        rewrites it via Haiku (neutralizes real names/emails, softens
        action verbs) and fills the input box so you can review before sending.
      </div>
      <div v-if="rephraseState === 'error'" class="mt-1 text-xs text-[var(--cw-danger)]">
        {{ rephraseErr }}
      </div>
    </div>
    <!-- Thinking fold: hidden by default; one tiny muted "✻ N" counter in the
         block corner toggles the full raw text. A <button> on purpose — the
         display-skin bubble rules target `.cw-assistant-block > div`, so this
         never renders as its own bubble. -->
    <button
      v-if="thinkingItems.length"
      type="button"
      class="cw-thinking-fold"
      :aria-expanded="showThinking"
      :title="showThinking ? 'Hide thinking' : `Show thinking (${thinkingItems.reduce((n, t) => n + (t.text || '').length, 0)} chars)`"
      @click="showThinking = !showThinking"
    >✻ {{ thinkingItems.length }}</button>
    <div v-if="showThinking && thinkingItems.length" class="cw-thinking px-4 py-2">
      <pre
        v-for="(t, i) in thinkingItems"
        :key="i"
        class="text-xs whitespace-pre-wrap break-words font-sans opacity-60"
      >{{ t.text }}</pre>
    </div>
    <template v-for="(it, i) in contentItems" :key="i">
      <div
        v-if="it.kind === 'text'"
        class="px-4 py-2 border-l-4 prose prose-sm dark:prose-invert max-w-none break-words"
        :class="isRefusal
          ? 'border-[var(--cw-warning)] bg-[color-mix(in_srgb,var(--cw-warning)_8%,transparent)] opacity-80'
          : 'border-[var(--cw-success)] bg-[color-mix(in_srgb,var(--cw-success)_8%,transparent)]'"
        v-html="renderMarkdown(it.text || '')"
      />
      <ToolCall v-else-if="it.kind === 'tool' && it.pair" :pair="it.pair" />
    </template>
  </div>
</template>
