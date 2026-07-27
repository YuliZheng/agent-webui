<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { TimelineNode, ToolPair } from "../../parser/group.js";
import { renderMarkdown } from "../../render/markdown.js";
import { observeCodeFences } from "../../render/code-fence-mounting.js";
import { useDark } from "../../util/theme.js";
import ToolCall from "./tool/ToolCall.vue";
import ContextFooter from "./ContextFooter.vue";
import {
  readFullCodexContextUsage,
  readSessionRange,
  rephrasePrompt,
} from "../../api/sessions.js";
import type { LineEntry } from "../../api/sessions.js";
import { useUiStore } from "../../stores/ui.js";
import { useDraftsStore } from "../../stores/drafts.js";
import { useNotificationsStore } from "../../stores/notifications.js";
import { useSessionsStore } from "../../stores/sessions.js";
import { useSessionCacheStore } from "../../stores/session-cache.js";
import { useSessionSettingsStore } from "../../stores/session-settings.js";
import { usePrefsStore } from "../../stores/prefs.js";
import { effectiveContextLimit } from "@claude-webui/shared/prefs";
import { latestCodexContextUsage } from "../../util/local-commands.js";
import type { ContextUsage } from "../../util/local-commands.js";
import {
  hasLoadedCodexUsageBoundary,
  mergeIndexedUsageLines,
  needsCodexUsageBackfill,
  USAGE_BACKFILL_MAX_LINES,
} from "../../util/context-usage-history.js";

const props = defineProps<{
  node: Extract<TimelineNode, { kind: "event" }>;
  sessionId?: string;
  isLatest?: boolean;
}>();
const ui = useUiStore();
const drafts = useDraftsStore();
const notifications = useNotificationsStore();
const sessions = useSessionsStore();
const sessionCache = useSessionCacheStore();
const sessionSettings = useSessionSettingsStore();
const prefs = usePrefsStore();

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

const isEndTurn = computed(() => message.value.stop_reason === "end_turn");

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

// Session id for the context footer's actions. Prefer the prop (passed by the
// timeline); fall back to the globally-selected session.
const footerSessionId = computed(() => props.sessionId || ui.selectedSessionId || "");

const isCodex = computed(() => sessions.byId[footerSessionId.value]?.agent === "codex");

const usageOlderLines = ref<LineEntry[]>([]);
const usageBackfillLoading = ref(false);
const usageBackfillAttempted = ref(false);
const usageBackfillError = ref("");
const usageBackfillFrom = ref<number | null>(null);
const usageBackfillTruncated = ref(false);
const fullCodexUsage = ref<ContextUsage | null>(null);
const usageFullScanRecords = ref<number | null>(null);
const usageUsingFallback = ref(false);
const codexUsageLines = computed(() => {
  const cached = sessionCache.bySession[footerSessionId.value]?.lines ?? [];
  return usageOlderLines.value.length
    ? mergeIndexedUsageLines(usageOlderLines.value, cached)
    : cached;
});
const usageBackfillLimited = computed(() =>
  !fullCodexUsage.value
  && usageBackfillAttempted.value
  && (
    usageBackfillTruncated.value
    || (
      (usageBackfillFrom.value ?? 0) > 0
      && !hasLoadedCodexUsageBoundary(codexUsageLines.value)
    )
  ),
);

watch(footerSessionId, () => {
  usageOlderLines.value = [];
  usageBackfillLoading.value = false;
  usageBackfillAttempted.value = false;
  usageBackfillError.value = "";
  usageBackfillFrom.value = null;
  usageBackfillTruncated.value = false;
  fullCodexUsage.value = null;
  usageFullScanRecords.value = null;
  usageUsingFallback.value = false;
});

// Codex carries no per-message usage (codex-adapt drops token_count), so its
// context occupancy is session-level: read the latest token_count from the
// rollout. Claude keeps the per-turn usage on the assistant message itself.
const codexUsage = computed(() =>
  isCodex.value && props.isLatest
    ? (
        fullCodexUsage.value
        ?? latestCodexContextUsage(
          codexUsageLines.value,
          prefs.codexAutoCompactWindow,
        )
      )
    : null,
);

async function loadCodexUsageBreakdown(): Promise<void> {
  if (!isCodex.value || usageBackfillLoading.value) return;
  if (usageBackfillAttempted.value && !usageBackfillError.value) return;
  const id = footerSessionId.value;
  const entry = sessionCache.bySession[id];
  if (!id || !entry) return;

  usageBackfillLoading.value = true;
  usageBackfillError.value = "";
  usageUsingFallback.value = false;
  try {
    try {
      const full = await readFullCodexContextUsage(id, prefs.codexAutoCompactWindow);
      fullCodexUsage.value = full;
      usageFullScanRecords.value = full.recordsScanned;
      usageBackfillAttempted.value = true;
      return;
    } catch {
      // The currently running backend may predate the full-scan endpoint.
      // Preserve the bounded range path until the user restarts into the build
      // that contains it.
      usageUsingFallback.value = true;
    }

    if (!needsCodexUsageBackfill(entry.firstLoadedIndex, codexUsageLines.value)) {
      usageBackfillAttempted.value = true;
      return;
    }

    const to = entry.firstLoadedIndex;
    const from = Math.max(0, to - USAGE_BACKFILL_MAX_LINES);
    usageBackfillFrom.value = from;
    const response = await readSessionRange(id, from, to);
    usageOlderLines.value = response.lines.filter(
      (line): line is LineEntry => Number.isSafeInteger(line.index) && typeof line.raw === "string" && !!line.raw,
    );
    const lastReturnedIndex = usageOlderLines.value.reduce(
      (last, line) => Math.max(last, line.index),
      from - 1,
    );
    usageBackfillTruncated.value = to > from && lastReturnedIndex < to - 1;
    usageBackfillAttempted.value = true;
  } catch (error) {
    usageBackfillAttempted.value = true;
    usageBackfillError.value = error instanceof Error ? error.message : String(error);
  } finally {
    usageBackfillLoading.value = false;
  }
}

// Context-window usage = everything fed to the model on this call.
const ctxTokens = computed(() => {
  if (isCodex.value) return codexUsage.value?.tokens ?? 0;
  const u = message.value.usage;
  if (!u) return 0;
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
});

// Effective limit handed to the footer (always concrete number|null — never
// undefined, which exactOptionalPropertyTypes would reject). The rollout parser
// resolves Codex's real auto-compact boundary. Claude uses its model window
// capped by autoCompactWindow.
const footerCtxLimit = computed<number | null>(() =>
  isCodex.value
    ? (codexUsage.value?.limit ?? null)
    : effectiveContextLimit(sessionSettings.effective(footerSessionId.value).model, false, prefs.autoCompactWindow),
);

// When to show the footer: Claude on each end-turn block; Codex on the latest
// assistant block of the session (no per-turn end_turn signal there).
const showFooter = computed(
  () => (isCodex.value ? !!props.isLatest : isEndTurn.value) && !!ctxTokens.value && !!footerSessionId.value,
);

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
    <ContextFooter
      v-if="showFooter"
      :session-id="footerSessionId"
      :ctx-tokens="ctxTokens"
      :is-latest="!!isLatest"
      :ctx-limit="footerCtxLimit"
      :ctx-reported-tokens="codexUsage?.reportedTokens"
      :ctx-estimated-tokens="codexUsage?.estimatedTokens"
      :ctx-contributors="codexUsage?.contributors"
      :ctx-breakdown-loading="usageBackfillLoading"
      :ctx-breakdown-limited="usageBackfillLimited"
      :ctx-breakdown-error="usageBackfillError"
      :ctx-breakdown-full-scan-records="usageFullScanRecords"
      :ctx-breakdown-fallback="usageUsingFallback"
      @open-usage="loadCodexUsageBreakdown"
    />
  </div>
</template>
