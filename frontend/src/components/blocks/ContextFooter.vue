<script setup lang="ts">
// Per-turn context readout shown under an end-turn assistant block:
//   context 92.3k · total 1.0M · usage 9%
// On the latest turn, once usage crosses ACTION_PCT, it grows inline
// "Compact here" / "New chat here" actions (same behaviour the old bottom
// "Long context" banner had — moved here so the prompt to act sits right next
// to the number that triggers it).
import { computed, getCurrentInstance, ref } from "vue";
import { effectiveContextLimit } from "@claude-webui/shared/prefs";
import { useSessionsStore } from "../../stores/sessions.js";
import { useSessionSettingsStore } from "../../stores/session-settings.js";
import { usePrefsStore } from "../../stores/prefs.js";
import { usePromptPendingStore } from "../../stores/prompt-pending.js";
import { useUiStore } from "../../stores/ui.js";
import { compactSession, newSession } from "../../api/sessions.js";
import { promotePendingDraft } from "../../stores/live.js";
import type { ContextContributor } from "../../util/local-commands.js";

// ctxLimit: explicit effective context limit. Passed for Codex (computed from
// the rollout window capped by the codex auto-compact setting). Omitted for
// Claude, where the footer derives it from the model + autoCompactWindow.
const props = defineProps<{
  sessionId: string;
  ctxTokens: number;
  isLatest?: boolean;
  ctxLimit?: number | null;
  ctxReportedTokens?: number | undefined;
  ctxEstimatedTokens?: number | undefined;
  ctxContributors?: readonly ContextContributor[] | undefined;
  ctxBreakdownLoading?: boolean;
  ctxBreakdownLimited?: boolean;
  ctxBreakdownError?: string;
  ctxBreakdownFullScanRecords?: number | null;
  ctxBreakdownFallback?: boolean;
}>();
const emit = defineEmits<{
  "open-usage": [];
}>();

const sessions = useSessionsStore();
const sessionSettings = useSessionSettingsStore();
const prefs = usePrefsStore();
const promptPending = usePromptPendingStore();
const ui = useUiStore();

// Show the action buttons once context occupancy crosses this fraction.
const ACTION_PCT = 0.7;

const isCodex = computed(() => sessions.byId[props.sessionId]?.agent === "codex");
const model = computed(() =>
  isCodex.value
    ? (sessionSettings.bySession[props.sessionId]?.model ?? "")
    : sessionSettings.effective(props.sessionId).model,
);
const limit = computed(() =>
  props.ctxLimit !== undefined
    ? props.ctxLimit
    : effectiveContextLimit(model.value, isCodex.value, prefs.autoCompactWindow),
);
const pct = computed(() => (limit.value ? Math.round((props.ctxTokens / limit.value) * 100) : null));
// Pre-compact overflow turns can read 200%+ ("usage 215%"), which looks like a
// bug rather than the expected "context is full, it'll auto-compact" state.
// Clamp the display to "100%+ · over limit" and surface the real number in the
// tooltip; the raw pct still drives showActions below.
const over = computed(() => pct.value !== null && pct.value > 100);
const usageText = computed(() => (over.value ? "100%+ · over limit" : `${pct.value}%`));
const contextTitle = computed(() => {
  if (!isCodex.value || !props.ctxEstimatedTokens) return over.value ? `usage ${pct.value}%` : undefined;
  return [
    `Codex compaction estimate: ~${fmt(props.ctxTokens)} tokens`,
    `API reported: ${fmt(props.ctxReportedTokens ?? Math.max(0, props.ctxTokens - props.ctxEstimatedTokens))}`,
    `Local history estimate: ~${fmt(props.ctxEstimatedTokens)}`,
    `Auto-compact threshold: ${limit.value ? fmt(limit.value) : "unknown"}`,
  ].join(" · ");
});
const contributorText = computed(() =>
  props.ctxContributors?.map((item) => `${item.label} ${item.percent}%`).join(" · ") ?? "",
);
const contributorTitle = computed(() =>
  contributorText.value
    ? `Estimated source attribution reconciled to Codex's reported total: ${contributorText.value}`
    : undefined,
);
const usageOpen = ref(false);
function toggleUsage(): void {
  usageOpen.value = !usageOpen.value;
  if (usageOpen.value) emit("open-usage");
}
const componentUid = getCurrentInstance()?.uid ?? 0;
const usagePanelId = computed(
  () => `context-usage-${props.sessionId.replace(/[^a-zA-Z0-9_-]/g, "-")}-${componentUid}`,
);
const contributors = computed(() =>
  (props.ctxContributors ?? []).filter((item) => Number.isFinite(item.tokens) && item.tokens > 0),
);
const contributorTotal = computed(() =>
  contributors.value.reduce((sum, item) => sum + item.tokens, 0),
);
const usageGradient = computed(() => {
  if (contributorTotal.value > 0) {
    let cursor = 0;
    const stops = contributors.value.map((item) => {
      const start = cursor;
      cursor += (item.tokens / contributorTotal.value) * 100;
      return `${sourceColor(item.source)} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`;
    });
    return `conic-gradient(from -90deg, ${stops.join(", ")})`;
  }
  const used = limit.value
    ? Math.max(0, Math.min(100, (props.ctxTokens / limit.value) * 100))
    : 100;
  return `conic-gradient(from -90deg, var(--cw-context-used) 0% ${used.toFixed(2)}%, var(--cw-context-track) ${used.toFixed(2)}% 100%)`;
});
const reportedTokens = computed(() =>
  props.ctxReportedTokens
  ?? Math.max(0, props.ctxTokens - (props.ctxEstimatedTokens ?? 0)),
);
const remainingTokens = computed(() => Math.max(0, (limit.value ?? 0) - props.ctxTokens));
const running = computed(() => sessions.statusBySession[props.sessionId] === "running");

const showActions = computed(
  () => !!props.isLatest && !running.value && limit.value !== null && pct.value !== null && pct.value >= ACTION_PCT * 100,
);

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function sourceColor(source: ContextContributor["source"]): string {
  return `var(--cw-context-${source})`;
}

const compactStarting = ref(false);
const compactError = ref("");
const continuationStarting = ref(false);
const continuationError = ref("");
let continuationClientUuid = "";
let continuationFingerprint = "";

async function startCompactSession() {
  if (compactStarting.value) return;
  compactStarting.value = true;
  compactError.value = "";
  continuationError.value = "";
  try {
    await compactSession(props.sessionId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    compactError.value = msg.includes("timed out")
      ? "Backend did not answer compact. Restart the webui backend so it loads the compact RPC, then try again."
      : msg;
  } finally {
    compactStarting.value = false;
  }
}

function continuationPrompt(): string {
  const s = sessions.byId[props.sessionId];
  const agentName = isCodex.value ? "Codex" : "Claude";
  return [
    `这个新对话是从 claude-webui ${agentName} session 继续来的。`,
    "",
    `上一条对话 UUID: ${props.sessionId}`,
    `上一条对话 cwd: ${s?.cwd ?? ""}`,
    "",
    "请先在本机历史记录里找到并阅读这个 UUID 对应的对话内容，然后继续和我协作。",
    "重点保留最近任务、已做改动、验证结果、未完成事项；不要重新问我这些背景。",
    "如果需要具体细节，直接读取对应 transcript/rollout。",
    "",
    "我们继续。",
  ].join("\n");
}

async function startContinuationSession() {
  if (continuationStarting.value) return;
  const current = sessions.byId[props.sessionId];
  const cwd = current?.cwd ?? "";
  if (!cwd) {
    continuationError.value = "Current session has no cwd.";
    return;
  }
  const nextAgent = isCodex.value ? "codex" : "claude";
  const prompt = continuationPrompt();
  const fingerprint = JSON.stringify([props.sessionId, cwd, nextAgent, prompt]);
  if (!continuationClientUuid || continuationFingerprint !== fingerprint) {
    continuationFingerprint = fingerprint;
    continuationClientUuid = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  const oldSessionId = props.sessionId;
  const draftId = sessions.createPending(cwd, nextAgent);
  continuationError.value = "";
  continuationStarting.value = true;
  const pendingId = promptPending.add(draftId, { text: prompt, imageCount: 0, startedAtLineCount: 0, agent: nextAgent });
  ui.select(draftId);
  try {
    const created = await newSession(
      { cwd, prompt, agent: nextAgent, clientUuid: continuationClientUuid },
      () => promptPending.markDispatched(draftId, pendingId),
    );
    promotePendingDraft(draftId, created.sessionId);
    promptPending.markAccepted(created.sessionId, pendingId);
    continuationClientUuid = "";
    continuationFingerprint = "";
  } catch (e) {
    promptPending.clear(draftId);
    sessions.dropPending(draftId);
    ui.select(oldSessionId);
    continuationError.value = e instanceof Error ? e.message : String(e);
  } finally {
    continuationStarting.value = false;
  }
}
</script>

<template>
  <div
    v-if="ctxTokens"
    class="cw-context-footer px-4 py-1 text-xs flex flex-wrap items-center gap-x-2 gap-y-1"
    @keydown.escape="usageOpen = false"
  >
    <span :class="over ? 'cw-context-over' : 'opacity-50'" :title="contextTitle">
      context {{ ctxEstimatedTokens ? "~" : "" }}{{ fmt(ctxTokens) }}<template v-if="limit"> · {{ isCodex ? "compact at" : "total" }} {{ fmt(limit) }}</template>
    </span>
    <button
      v-if="limit"
      type="button"
      class="cw-context-usage-trigger"
      :class="{ 'cw-context-over': over }"
      :aria-expanded="usageOpen"
      :aria-controls="usagePanelId"
      :title="contributorTitle ?? contextTitle"
      @click="toggleUsage"
    >
      usage {{ usageText }}
      <span class="cw-context-usage-chevron" aria-hidden="true">{{ usageOpen ? "▴" : "▾" }}</span>
    </button>
    <span v-if="showActions" class="cw-context-actions">
      <button
        type="button"
        class="cw-context-action cw-context-action-primary"
        :disabled="compactStarting || continuationStarting"
        @click="startCompactSession"
      >{{ compactStarting ? "Compacting..." : "Compact here" }}</button>
      <button
        type="button"
        class="cw-context-action"
        :disabled="continuationStarting || compactStarting"
        @click="startContinuationSession"
      >{{ continuationStarting ? "Opening..." : "New chat here" }}</button>
    </span>
    <span v-if="showActions && (compactError || continuationError)" class="cw-context-notice-error">
      {{ compactError || continuationError }}
    </span>
    <div
      v-if="usageOpen && limit"
      :id="usagePanelId"
      class="cw-context-usage-detail"
      role="region"
      aria-label="Context usage details"
    >
      <div
        class="cw-context-usage-chart"
        :style="{ background: usageGradient }"
        role="img"
        :aria-label="contributors.length ? `Estimated context source mix: ${contributorText}` : `Context usage ${usageText}`"
      >
        <div class="cw-context-usage-chart-center">
          <strong>{{ usageText }}</strong>
          <span>used</span>
        </div>
      </div>
      <div class="cw-context-usage-breakdown">
        <div class="cw-context-usage-heading">
          <strong>{{ contributors.length ? "Context sources" : "Context usage" }}</strong>
          <span>{{ ctxEstimatedTokens ? "~" : "" }}{{ fmt(ctxTokens) }} / {{ fmt(limit) }}</span>
        </div>
        <template v-if="contributors.length">
          <div v-if="ctxBreakdownLoading" class="cw-context-usage-meta" role="status">
            Scanning the full rollout for source attribution…
          </div>
          <div v-else-if="ctxBreakdownError" class="cw-context-usage-meta cw-context-usage-error">
            Could not load older context; showing the current tail only.
          </div>
          <div v-else-if="ctxBreakdownFullScanRecords !== null && ctxBreakdownFullScanRecords !== undefined" class="cw-context-usage-meta">
            Full rollout scan complete · {{ ctxBreakdownFullScanRecords }} records checked
          </div>
          <div v-else-if="ctxBreakdownFallback" class="cw-context-usage-meta">
            Full scan needs the new backend build; showing the bounded compatibility fallback until restart.
          </div>
          <div v-else-if="ctxBreakdownLimited" class="cw-context-usage-meta">
            The bounded history scan did not reach the last compaction; older context remains unattributed.
          </div>
          <div
            v-for="item in contributors"
            :key="item.source"
            class="cw-context-usage-row"
          >
            <span class="cw-context-usage-dot" :style="{ background: sourceColor(item.source) }" />
            <span>{{ item.label }}</span>
            <span class="cw-context-usage-value">~{{ fmt(item.tokens) }} · {{ item.percent }}%</span>
          </div>
          <div v-if="ctxReportedTokens !== undefined || ctxEstimatedTokens" class="cw-context-usage-meta">
            Codex reported {{ fmt(reportedTokens) }}
            <template v-if="ctxEstimatedTokens"> · local estimate ~{{ fmt(ctxEstimatedTokens) }}</template>
            <template v-else> · rows sum to this total</template>
          </div>
          <div class="cw-context-usage-note">
            <template v-if="ctxBreakdownFullScanRecords !== null && ctxBreakdownFullScanRecords !== undefined">
              Every physical rollout record was scanned. Context that Codex does not represent as rollout rows—such as hidden base instructions and tool schemas—stays under “unattributed context”; known rows are never inflated to fill it.
            </template>
            <template v-else>
              Source attribution is approximate because Codex reports only the total. Missing or unloaded context stays under “unattributed context”; known rows are never inflated to fill it.
            </template>
            Image inputs use Codex's ~1.8k default visual estimate, while hosted image-generation cost is separate from context tokens. Tool results are capped at ~2k each.
          </div>
        </template>
        <template v-else>
          <div class="cw-context-usage-row">
            <span class="cw-context-usage-dot cw-context-usage-dot-used" />
            <span>Used</span>
            <span class="cw-context-usage-value">{{ fmt(ctxTokens) }}</span>
          </div>
          <div class="cw-context-usage-row">
            <span class="cw-context-usage-dot cw-context-usage-dot-free" />
            <span>Available</span>
            <span class="cw-context-usage-value">{{ fmt(remainingTokens) }}</span>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
