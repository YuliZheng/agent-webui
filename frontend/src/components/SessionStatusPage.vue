<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type {
  CodexAccountUsageDailyBucket,
  CodexRateLimitWindow,
  CodexThreadUsage,
  CodexUsageOverview,
} from "@claude-webui/shared/api";
import type { ContextUsage, SessionStatusRow } from "../util/local-commands.js";
import { buildSessionStatusSummary, latestContextUsage } from "../util/local-commands.js";
import type { LineEntry } from "../api/sessions.js";
import {
  getCodexThreadUsage,
  getCodexUsageOverview,
  killSession,
  readFullCodexContextUsage,
  readSessionRange,
} from "../api/sessions.js";
import { useNotificationsStore } from "../stores/notifications.js";
import { usePrefsStore } from "../stores/prefs.js";
import { useSessionCacheStore } from "../stores/session-cache.js";
import { useSessionSettingsStore } from "../stores/session-settings.js";
import { useSessionsStore } from "../stores/sessions.js";
import {
  hasLoadedCodexUsageBoundary,
  mergeIndexedUsageLines,
  needsCodexUsageBackfill,
  USAGE_BACKFILL_MAX_LINES,
} from "../util/context-usage-history.js";
import ContextFooter from "./blocks/ContextFooter.vue";
import { APP_BACK_PRIORITY, registerAppBackHandler } from "../util/app-back.js";
import { setPwaLayerActive } from "../util/pwa-history.js";

const props = defineProps<{ sessionId: string; open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const sessions = useSessionsStore();
const prefs = usePrefsStore();
const sessionCache = useSessionCacheStore();
const sessionSettings = useSessionSettingsStore();
const notifications = useNotificationsStore();

const item = computed(() => sessions.byId[props.sessionId]);
const isCodex = computed(() => item.value?.agent === "codex");
const canKillClaude = computed(() => (
  item.value?.agent === "claude" && !!sessions.webuiAliveBySession[props.sessionId]
));
const canKillAgent = computed(() => isCodex.value || canKillClaude.value);
const killLabel = computed(() => (
  isCodex.value ? "强制终止 Codex 后台" : "终止 Claude 进程"
));
const effectiveModel = computed(() => (
  isCodex.value
    ? sessionSettings.effectiveCodex(props.sessionId).model
    : sessionSettings.effective(props.sessionId).model
));

const rows = ref<SessionStatusRow[]>([]);
const statusRows = computed(() => rows.value.filter(row => row.label !== "Context"));
const loading = ref(false);
const confirmingKill = ref(false);
const usageOlderLines = ref<LineEntry[]>([]);
const usageBackfillLoading = ref(false);
const usageBackfillAttempted = ref(false);
const usageBackfillError = ref("");
const usageBackfillFrom = ref<number | null>(null);
const usageBackfillTruncated = ref(false);
const fullCodexUsage = ref<ContextUsage | null>(null);
const usageFullScanRecords = ref<number | null>(null);
const fullCompactionCount = ref<number | null>(null);
const usageUsingFallback = ref(false);
const weeklyUsagePercent = ref<number | null>(null);
const weeklyUsageWindow = ref<CodexRateLimitWindow | null>(null);
const planType = ref<string | null>(null);
const threadUsage = ref<CodexThreadUsage | null>(null);
const dailyUsageBuckets = ref<CodexAccountUsageDailyBucket[]>([]);
let loadSeq = 0;
let usageLoadSeq = 0;
let confirmTimer: ReturnType<typeof setTimeout> | undefined;
let unregisterAppBack: (() => void) | undefined;

const codexUsageLines = computed(() => {
  const cached = sessionCache.bySession[props.sessionId]?.lines ?? [];
  return usageOlderLines.value.length
    ? mergeIndexedUsageLines(usageOlderLines.value, cached)
    : cached;
});
const localContextUsage = computed(() => latestContextUsage(
  codexUsageLines.value,
  isCodex.value,
  effectiveModel.value,
  prefs.autoCompactWindow,
  prefs.codexAutoCompactWindow,
));
const contextUsage = computed<ContextUsage>(() => {
  const full = fullCodexUsage.value;
  const local = localContextUsage.value;
  if (!full) return local;
  // Older backends do not return the new cumulative field yet. The latest
  // token_count in the live tail still carries the authoritative thread total.
  // Prefer the larger snapshot so a newly completed turn can advance the value
  // while this page remains open after the full scan finished.
  const cumulative = [full.cumulativeTokens, local.cumulativeTokens]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .reduce<number | undefined>((largest, value) => largest === undefined ? value : Math.max(largest, value), undefined);
  return {
    ...full,
    ...(cumulative !== undefined ? { cumulativeTokens: cumulative } : {}),
  };
});
const cumulativeTokens = computed(() => contextUsage.value.cumulativeTokens ?? null);
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

function resetKillConfirmation() {
  confirmingKill.value = false;
  if (confirmTimer) clearTimeout(confirmTimer);
  confirmTimer = undefined;
}

function closePage() {
  resetKillConfirmation();
  emit("close");
}

function resetUsageBreakdown() {
  // Invalidate any full-scan/range request that belongs to the previously
  // selected session. The status sheet is reused as sessionId changes.
  usageLoadSeq++;
  usageOlderLines.value = [];
  usageBackfillLoading.value = false;
  usageBackfillAttempted.value = false;
  usageBackfillError.value = "";
  usageBackfillFrom.value = null;
  usageBackfillTruncated.value = false;
  fullCodexUsage.value = null;
  usageFullScanRecords.value = null;
  fullCompactionCount.value = null;
  usageUsingFallback.value = false;
  weeklyUsagePercent.value = null;
  weeklyUsageWindow.value = null;
  planType.value = null;
  threadUsage.value = null;
  dailyUsageBuckets.value = [];
}

function usageRequestCurrent(seq: number, id: string): boolean {
  return seq === usageLoadSeq && props.open && props.sessionId === id;
}

async function loadUsageOverview(id: string): Promise<CodexUsageOverview | null> {
  try {
    return await getCodexUsageOverview(id);
  } catch {
    // Compatibility with a frontend updated before the backend is restarted.
    const fallback = await getCodexThreadUsage(id).catch(() => null);
    return fallback
      ? { threadUsage: fallback, dailyUsageBuckets: [], accountLifetimeTokens: null }
      : null;
  }
}

async function loadStatus() {
  const seq = ++loadSeq;
  const id = props.sessionId;
  const codex = isCodex.value;
  const model = effectiveModel.value;
  const lines = sessionCache.bySession[id]?.lines ?? [];
  const usage = contextUsage.value;
  loading.value = true;
  try {
    const [summary, usageOverview] = await Promise.all([
      buildSessionStatusSummary({
        sessionId: id,
        isCodex: codex,
        model,
        ctxTokens: usage.tokens,
        ctxLimit: usage.limit,
        ctxReportedTokens: usage.reportedTokens,
        ctxEstimatedTokens: usage.estimatedTokens,
        ctxContributors: usage.contributors,
        lines,
      }),
      codex ? loadUsageOverview(id) : Promise.resolve(null),
    ]);
    if (seq === loadSeq && props.open && props.sessionId === id) {
      rows.value = summary.rows;
      weeklyUsagePercent.value = summary.weeklyUsagePercent;
      weeklyUsageWindow.value = summary.weeklyUsageWindow;
      planType.value = summary.planType;
      threadUsage.value = usageOverview?.threadUsage ?? null;
      dailyUsageBuckets.value = usageOverview?.dailyUsageBuckets ?? [];
    }
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

async function loadCodexUsageBreakdown(): Promise<void> {
  if (!isCodex.value || usageBackfillLoading.value) return;
  if (usageBackfillAttempted.value && !usageBackfillError.value) return;
  const seq = ++usageLoadSeq;
  const id = props.sessionId;
  const entry = sessionCache.bySession[id];
  if (!id || !entry) return;

  usageBackfillLoading.value = true;
  usageBackfillError.value = "";
  usageUsingFallback.value = false;
  try {
    try {
      const full = await readFullCodexContextUsage(id, prefs.codexAutoCompactWindow);
      if (!usageRequestCurrent(seq, id)) return;
      fullCodexUsage.value = full;
      usageFullScanRecords.value = full.recordsScanned;
      fullCompactionCount.value = full.compactionCount;
      usageBackfillAttempted.value = true;
      return;
    } catch {
      if (!usageRequestCurrent(seq, id)) return;
      // Keep the bounded range fallback until the user restarts the currently
      // running backend into the build that provides the full-scan endpoint.
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
    if (!usageRequestCurrent(seq, id)) return;
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
    if (!usageRequestCurrent(seq, id)) return;
    usageBackfillAttempted.value = true;
    usageBackfillError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (usageRequestCurrent(seq, id)) usageBackfillLoading.value = false;
  }
}

async function killAgentProcess() {
  if (!canKillAgent.value) return;
  if (!confirmingKill.value) {
    confirmingKill.value = true;
    confirmTimer = setTimeout(resetKillConfirmation, 4_000);
    return;
  }
  resetKillConfirmation();
  try {
    await killSession(props.sessionId);
    notifications.pushInfo(
      isCodex.value
        ? "Codex 后台已终止；下次发送时会自动重新启动。"
        : "Claude 进程已终止；下次发送时会重新启动。",
      { title: "进程已终止" },
    );
    closePage();
  } catch (err) {
    notifications.pushError(err instanceof Error ? err.message : String(err), { title: "终止失败" });
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") closePage();
}

watch(
  [() => props.open, () => props.sessionId],
  ([open]) => {
    setPwaLayerActive("session-status", open, props.sessionId);
    resetKillConfirmation();
    if (open) {
      resetUsageBreakdown();
      window.addEventListener("keydown", onKeydown);
      void loadStatus();
      void loadCodexUsageBreakdown();
    } else {
      loadSeq++;
      usageLoadSeq++;
      window.removeEventListener("keydown", onKeydown);
    }
  },
  { immediate: true },
);

watch(
  () => sessions.statusBySession[props.sessionId],
  (status, previous) => {
    if (props.open && previous === "running" && status !== "running") void loadStatus();
  },
);

onBeforeUnmount(() => {
  usageLoadSeq++;
  unregisterAppBack?.();
  resetKillConfirmation();
  window.removeEventListener("keydown", onKeydown);
});

onMounted(() => {
  unregisterAppBack = registerAppBackHandler(() => {
    if (!props.open) return false;
    closePage();
    return true;
  }, APP_BACK_PRIORITY.sheet);
});
</script>

<template>
  <Teleport to="body">
    <Transition name="cw-status-page">
      <div
        v-if="open"
        class="fixed inset-0 z-[90] flex flex-col bg-[var(--cw-panel-2)] text-[var(--cw-text)] md:items-center md:justify-center md:bg-black/40 md:p-6"
        @click.self="closePage"
      >
        <div
          class="flex min-h-0 w-full flex-1 flex-col bg-[var(--cw-panel-2)] md:max-h-[min(820px,calc(100vh-3rem))] md:max-w-2xl md:flex-none md:overflow-hidden md:rounded-2xl md:border md:border-[var(--cw-border)] md:shadow-2xl"
          role="dialog"
          aria-modal="true"
          aria-label="会话状态与操作"
        >
          <header
            class="grid shrink-0 grid-cols-[44px_1fr_44px] items-center border-b border-[var(--cw-border)] bg-[var(--cw-panel-bg)] px-1 pb-2 md:px-2 md:pt-2"
            style="padding-top:max(0.5rem, env(safe-area-inset-top))"
          >
            <button
              type="button"
              class="flex h-10 w-10 items-center justify-center rounded-full [@media(hover:hover)]:hover:bg-[var(--cw-panel-2)] active:bg-[var(--cw-panel-2)]"
              aria-label="返回会话"
              @click="closePage"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="h-5 w-5 md:hidden" aria-hidden="true">
                <line x1="20" y1="12" x2="4" y2="12" />
                <polyline points="11 5 4 12 11 19" />
              </svg>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="hidden h-5 w-5 md:block" aria-hidden="true">
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="18" y1="6" x2="6" y2="18" />
              </svg>
            </button>
            <h1 class="truncate text-center text-base font-semibold">会话信息</h1>
            <span aria-hidden="true" />
          </header>

          <main class="min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-6">
          <section class="overflow-hidden rounded-xl bg-[var(--cw-panel-bg)]">
            <div class="border-b border-[var(--cw-border)] px-4 py-3">
              <h2 class="text-sm font-medium">会话状态</h2>
            </div>
            <div v-if="loading && rows.length === 0" class="py-10 text-center text-sm text-[var(--cw-muted)]">
              正在读取状态…
            </div>
            <dl v-else class="divide-y divide-[var(--cw-border)] px-4">
              <div
                v-for="row in statusRows"
                :key="row.label"
                class="grid grid-cols-[minmax(104px,0.42fr)_minmax(0,1fr)] gap-3 py-3.5"
              >
                <dt class="text-xs text-[var(--cw-muted)]">{{ row.label }}</dt>
                <dd
                  class="break-words text-right font-mono text-xs leading-5"
                  :class="{ 'text-[var(--cw-success)]': row.label === 'State' && row.value === 'running' }"
                >{{ row.value }}</dd>
              </div>
            </dl>
          </section>

          <section
            v-if="contextUsage.tokens || cumulativeTokens || threadUsage"
            class="mt-5 overflow-hidden rounded-xl bg-[var(--cw-panel-bg)]"
          >
            <div class="flex items-center justify-between gap-3 border-b border-[var(--cw-border)] px-4 py-3">
              <h2 class="text-sm font-medium">Token 用量</h2>
              <span v-if="isCodex" class="text-xs text-[var(--cw-muted)]">
                <template v-if="fullCompactionCount !== null">已压缩 {{ fullCompactionCount }} 次</template>
                <template v-else-if="usageBackfillLoading">正在统计压缩次数…</template>
                <template v-else>压缩次数待全量扫描</template>
              </span>
            </div>
            <div class="py-2">
              <ContextFooter
                :session-id="sessionId"
                :ctx-tokens="contextUsage.tokens"
                :ctx-limit="contextUsage.limit"
                :cumulative-tokens="cumulativeTokens"
                :ctx-cumulative-contributors="contextUsage.cumulativeContributors"
                :weekly-usage-percent="weeklyUsagePercent"
                :weekly-usage-window="weeklyUsageWindow"
                :daily-usage-buckets="dailyUsageBuckets"
                :plan-type="planType"
                :thread-usage="threadUsage"
                :ctx-reported-tokens="contextUsage.reportedTokens"
                :ctx-estimated-tokens="contextUsage.estimatedTokens"
                :ctx-contributors="contextUsage.contributors"
                :ctx-breakdown-loading="usageBackfillLoading"
                :ctx-breakdown-limited="usageBackfillLimited"
                :ctx-breakdown-error="usageBackfillError"
                :ctx-breakdown-full-scan-records="usageFullScanRecords"
                :ctx-breakdown-fallback="usageUsingFallback"
              />
            </div>
          </section>

          <section class="mt-5 overflow-hidden rounded-xl bg-[var(--cw-panel-bg)]">
            <button
              v-if="canKillAgent"
              type="button"
              class="w-full px-4 py-3.5 text-center text-sm font-medium text-[var(--cw-danger)] active:bg-[var(--cw-panel-2)]"
              @click="killAgentProcess"
            >{{ confirmingKill ? "再次点击确认终止" : killLabel }}</button>
            <p v-else class="px-4 py-3.5 text-center text-sm text-[var(--cw-muted)]">
              当前没有可终止的 Claude 进程
            </p>
          </section>
          <p class="px-2 pt-2 text-[11px] leading-5 text-[var(--cw-muted)]">
            <template v-if="isCodex">
              Codex 使用共享后台。强制终止会中断所有正在运行的 Codex 对话，下次发送消息时会自动重启。
            </template>
            <template v-else>
              这会终止 WebUI 管理的 Claude 进程；普通停止回复请使用输入框旁的停止键。
            </template>
          </p>
          </main>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.cw-status-page-enter-active,
.cw-status-page-leave-active {
  transition: transform 0.2s ease, opacity 0.16s ease;
}
.cw-status-page-enter-from,
.cw-status-page-leave-to {
  opacity: 0;
  transform: translateX(18px);
}
@media (min-width: 768px) {
  .cw-status-page-enter-from,
  .cw-status-page-leave-to {
    transform: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .cw-status-page-enter-active,
  .cw-status-page-leave-active {
    transition: none;
  }
}

</style>
