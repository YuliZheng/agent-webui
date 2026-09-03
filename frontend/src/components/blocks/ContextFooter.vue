<script setup lang="ts">
// Context readout used in the session-details page. The source chart stays
// expanded so context information has one stable home outside the transcript.
import { computed, ref, watch } from "vue";
import type {
  CodexAccountUsageDailyBucket,
  CodexRateLimitWindow,
  CodexThreadUsage,
} from "@claude-webui/shared/api";
import { effectiveContextLimit } from "@claude-webui/shared/prefs";
import { useSessionsStore } from "../../stores/sessions.js";
import { useSessionSettingsStore } from "../../stores/session-settings.js";
import { usePrefsStore } from "../../stores/prefs.js";
import { usePromptPendingStore } from "../../stores/prompt-pending.js";
import { useDraftsStore } from "../../stores/drafts.js";
import { useUiStore } from "../../stores/ui.js";
import { compactSession, newSession } from "../../api/sessions.js";
import { promotePendingDraft } from "../../stores/live.js";
import type { ContextContributor } from "../../util/local-commands.js";
import { estimateConversationWeeklyUsage } from "../../util/codex-weekly-usage.js";

// ctxLimit: explicit effective context limit. Passed for Codex (computed from
// the rollout window capped by the codex auto-compact setting). Omitted for
// Claude, where the footer derives it from the model + autoCompactWindow.
const props = defineProps<{
  sessionId: string;
  ctxTokens: number;
  isLatest?: boolean;
  ctxLimit?: number | null;
  cumulativeTokens?: number | null;
  ctxCumulativeContributors?: readonly ContextContributor[] | undefined;
  weeklyUsagePercent?: number | null;
  weeklyUsageWindow?: CodexRateLimitWindow | null;
  dailyUsageBuckets?: readonly CodexAccountUsageDailyBucket[];
  planType?: string | null;
  threadUsage?: CodexThreadUsage | null;
  ctxReportedTokens?: number | undefined;
  ctxEstimatedTokens?: number | undefined;
  ctxContributors?: readonly ContextContributor[] | undefined;
  ctxBreakdownLoading?: boolean;
  ctxBreakdownLimited?: boolean;
  ctxBreakdownError?: string;
  ctxBreakdownFullScanRecords?: number | null;
  ctxBreakdownFallback?: boolean;
}>();
const sessions = useSessionsStore();
const sessionSettings = useSessionSettingsStore();
const prefs = usePrefsStore();
const promptPending = usePromptPendingStore();
const drafts = useDraftsStore();
const ui = useUiStore();

// Show the action buttons once context occupancy crosses this fraction.
const ACTION_PCT = 0.7;

const isCodex = computed(() => sessions.byId[props.sessionId]?.agent === "codex");
type UsageScope = "all" | "current";
const usageScope = ref<UsageScope>("all");
watch(() => props.sessionId, () => { usageScope.value = "all"; });
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
  props.ctxContributors?.map((item) => `${sourceLabel(item.source)} ${item.percent}%`).join(" · ") ?? "",
);
const contributorTitle = computed(() =>
  contributorText.value
    ? `Estimated source attribution reconciled to Codex's reported total: ${contributorText.value}`
    : undefined,
);
const contributors = computed(() =>
  (props.ctxContributors ?? []).filter((item) => Number.isFinite(item.tokens) && item.tokens > 0),
);
const contributorTotal = computed(() =>
  contributors.value.reduce((sum, item) => sum + item.tokens, 0),
);
const cumulativeContributors = computed(() =>
  (props.ctxCumulativeContributors ?? []).filter((item) => Number.isFinite(item.tokens) && item.tokens > 0),
);
const cumulativeContributorTotal = computed(() =>
  cumulativeContributors.value.reduce((sum, item) => sum + item.tokens, 0),
);
const cumulativeContributorText = computed(() => cumulativeContributors.value
  .map((item) => `${sourceLabel(item.source)} ${item.percent}%`)
  .join(" · "));
const allTimeTokens = computed(() => {
  const reported = props.cumulativeTokens;
  const reportedTokens = typeof reported === "number" && Number.isFinite(reported) && reported > 0
    ? reported
    : 0;
  return Math.max(reportedTokens, cumulativeContributorTotal.value);
});
const hasAllUsage = computed(() => isCodex.value && allTimeTokens.value > 0);
const showAll = computed(() => hasAllUsage.value && usageScope.value === "all");
const weeklyUsageLabel = computed(() => {
  const value = props.weeklyUsagePercent;
  return typeof value === "number" && Number.isFinite(value)
    ? `${Math.round(value * 10) / 10}% 已用`
    : "暂不可用";
});
const planLabel = computed(() => formatPlanType(props.planType));
const weeklyEquivalent = computed(() => estimateConversationWeeklyUsage({
  cumulativeTokens: allTimeTokens.value,
  weeklyUsagePercent: props.weeklyUsagePercent,
  weeklyWindow: props.weeklyUsageWindow,
  dailyUsageBuckets: props.dailyUsageBuckets ?? [],
}));
const weeklyEquivalentLabel = computed(() => weeklyEquivalent.value
  ? `≈ ${formatPercent(weeklyEquivalent.value.conversationPercent)} 一周额度`
  : "暂无足够数据");
const usageGradient = computed(() => {
  if (showAll.value) {
    if (cumulativeContributorTotal.value > 0) {
      let cursor = 0;
      const stops = cumulativeContributors.value.map((item) => {
        const start = cursor;
        cursor += (item.tokens / cumulativeContributorTotal.value) * 100;
        return `${sourceColor(item.source)} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`;
      });
      return `conic-gradient(from -90deg, ${stops.join(", ")})`;
    }
    return "conic-gradient(from -90deg, var(--cw-context-track) 0% 100%)";
  }
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
  () => !showAll.value
    && !!props.isLatest
    && !running.value
    && limit.value !== null
    && pct.value !== null
    && pct.value >= ACTION_PCT * 100,
);

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function sourceColor(source: ContextContributor["source"]): string {
  return `var(--cw-context-${source})`;
}

function sourceLabel(source: ContextContributor["source"]): string {
  const labels: Record<ContextContributor["source"], string> = {
    user: "用户消息",
    assistant: "助手回复",
    agents: "AGENTS.md",
    skills: "Skills",
    instructions: "系统上下文",
    base: "基础上下文",
    compaction: "压缩摘要",
    images: "图片",
    shell: "Shell",
    browser: "浏览器",
    patches: "补丁",
    tools: "其他工具",
    reasoning: "推理",
    messages: "其他消息",
    other: "未归因部分",
  };
  return labels[source];
}

function formatPlanType(planType: string | null | undefined): string {
  if (!planType) return "未报告";
  const known: Record<string, string> = {
    free: "Free",
    go: "Go",
    plus: "Plus",
    pro: "Pro 20x（用户确认）",
    prolite: "Pro Lite",
    team: "Team",
    business: "Business",
    enterprise: "Enterprise",
    edu: "Edu",
    edu_plus: "Edu Plus",
    edu_pro: "Edu Pro",
  };
  return known[planType] ?? planType
    .split("_")
    .filter(Boolean)
    .map(part => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function formatPercent(value: number): string {
  if (value > 0 && value < 0.01) return "<0.01%";
  const digits = value < 10 ? 2 : value < 100 ? 1 : 0;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: digits })}%`;
}

function formatCredits(micros: number): string {
  const credits = micros / 1_000_000;
  if (credits > 0 && credits < 0.01) return "<0.01";
  return credits.toLocaleString(undefined, { maximumFractionDigits: 2 });
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
  const pendingId = promptPending.add(draftId, {
    text: prompt,
    imageCount: 0,
    startedAtLineCount: 0,
    startedAtSessionSize: 0,
    agent: nextAgent,
  });
  // The continuation RPC may spend a long time booting Codex/Claude. Lock the
  // newly selected draft before exposing its composer so a second Send cannot
  // race this newSession and promote the same draft into two real sessions.
  drafts.beginInflight(draftId);
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
    // The user may have navigated elsewhere while the provider was starting.
    // Only undo our own navigation if this draft still owns the selection.
    if (ui.selectedSessionId === draftId) ui.select(oldSessionId);
    continuationError.value = e instanceof Error ? e.message : String(e);
  } finally {
    drafts.endInflight(sessions.resolvePromoted(draftId));
    continuationStarting.value = false;
  }
}
</script>

<template>
  <div
    v-if="ctxTokens || allTimeTokens"
    class="cw-context-footer px-4 py-1 text-xs flex flex-wrap items-center gap-x-2 gap-y-1"
  >
    <div v-if="hasAllUsage" class="cw-context-scope-bar">
      <div class="cw-context-scope-switch" role="group" aria-label="Token 用量范围">
        <button
          type="button"
          :class="{ 'is-active': usageScope === 'all' }"
          :aria-pressed="usageScope === 'all'"
          @click="usageScope = 'all'"
        >全部</button>
        <button
          type="button"
          :class="{ 'is-active': usageScope === 'current' }"
          :aria-pressed="usageScope === 'current'"
          @click="usageScope = 'current'"
        >当前</button>
      </div>
      <span
        class="cw-context-scope-summary"
        :class="{ 'cw-context-over': !showAll && over }"
        :title="showAll ? `${allTimeTokens.toLocaleString()} tokens` : (contributorTitle ?? contextTitle)"
        aria-live="polite"
      >
        <template v-if="showAll">
          会话累计 <strong>{{ fmt(allTimeTokens) }}</strong> tokens
          <span v-if="weeklyEquivalent" class="cw-context-scope-equivalent">
            · {{ weeklyEquivalentLabel }}
          </span>
        </template>
        <template v-else>
          当前上下文 <strong>{{ ctxEstimatedTokens ? "~" : "" }}{{ fmt(ctxTokens) }}</strong>
          <template v-if="limit"> / {{ fmt(limit) }} · {{ usageText }} 已用 · 剩余 {{ fmt(remainingTokens) }}</template>
        </template>
      </span>
    </div>
    <template v-else>
      <span :class="over ? 'cw-context-over' : 'opacity-50'" :title="contextTitle">
        current context {{ ctxEstimatedTokens ? "~" : "" }}{{ fmt(ctxTokens) }}<template v-if="limit"> · {{ isCodex ? "compact at" : "total" }} {{ fmt(limit) }}</template>
      </span>
      <span
        v-if="limit"
        class="cw-context-usage-label"
        :class="{ 'cw-context-over': over }"
        :title="contributorTitle ?? contextTitle"
      >
        {{ usageText }} used
      </span>
    </template>
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
      v-if="showAll || limit"
      class="cw-context-usage-detail"
      role="region"
      :aria-label="showAll ? '会话全部 Token 用量' : '当前上下文 Token 用量'"
    >
      <div
        class="cw-context-usage-chart"
        :style="{ background: usageGradient }"
        role="img"
        :aria-label="showAll
          ? (cumulativeContributors.length
            ? `会话累计 ${fmt(allTimeTokens)} tokens，来源分布：${cumulativeContributorText}`
            : `会话累计 ${fmt(allTimeTokens)} tokens，来源统计中`)
          : (contributors.length
            ? `Estimated current context source mix: ${contributorText}`
            : `Current context usage ${usageText}`)"
      >
        <div class="cw-context-usage-chart-center">
          <strong>{{ showAll ? fmt(allTimeTokens) : usageText }}</strong>
          <span>{{ showAll ? "累计" : "已用" }}</span>
        </div>
      </div>
      <div class="cw-context-usage-breakdown">
        <template v-if="showAll">
          <div class="cw-context-usage-heading">
            <strong>全部历史用量</strong>
            <span>{{ fmt(allTimeTokens) }} tokens</span>
          </div>
          <div
            v-for="item in cumulativeContributors"
            :key="item.source"
            class="cw-context-usage-row"
          >
            <span class="cw-context-usage-dot" :style="{ background: sourceColor(item.source) }" />
            <span>{{ sourceLabel(item.source) }}</span>
            <span class="cw-context-usage-value">~{{ fmt(item.tokens) }} · {{ item.percent }}%</span>
          </div>
          <div v-if="!cumulativeContributors.length" class="cw-context-usage-meta" role="status">
            <template v-if="ctxBreakdownLoading">正在统计全部历史来源；首次会扫描完整记录，之后命中缓存。</template>
            <template v-else-if="ctxBreakdownError">全部来源暂时无法加载；累计总数仍采用 Codex 官方值。</template>
            <template v-else>累计总数已读取，来源分布等待完整历史扫描。</template>
          </div>
          <div
            v-else-if="ctxBreakdownFullScanRecords !== null && ctxBreakdownFullScanRecords !== undefined"
            class="cw-context-usage-meta"
          >
            已扫描 {{ ctxBreakdownFullScanRecords }} 条历史记录；文件未变化时直接使用缓存
          </div>
          <div class="cw-context-usage-meta cw-context-usage-account">
            <div class="cw-context-usage-row">
              <span class="cw-context-usage-dot cw-context-usage-dot-plan" />
              <span>套餐</span>
              <span class="cw-context-usage-value">{{ planLabel }}</span>
            </div>
            <div class="cw-context-usage-row">
              <span class="cw-context-usage-dot cw-context-usage-dot-week" />
              <span>账户周额度</span>
              <span class="cw-context-usage-value">{{ weeklyUsageLabel }}</span>
            </div>
            <div class="cw-context-usage-row">
              <span class="cw-context-usage-dot cw-context-usage-dot-conversation" />
              <span>本会话累计相当于</span>
              <span class="cw-context-usage-value">{{ weeklyEquivalentLabel }}</span>
            </div>
          </div>
          <div
            v-if="threadUsage && threadUsage.estimatedUsageCreditsMicros > 0"
            class="cw-context-usage-meta"
          >
            此会话估算消耗 {{ formatCredits(threadUsage.estimatedUsageCreditsMicros) }} credits
          </div>
          <div class="cw-context-usage-note">
            圆环把 Codex 报告的会话累计 Token 按每次调用当时的来源比例归因；各项严格合计为上方总数，但来源本身是估算。
            <template v-if="weeklyEquivalent">
              “一周额度”按账户本周约 {{ fmt(weeklyEquivalent.accountTokensInWindow) }} Token 对应 {{ weeklyUsageLabel }} 外推；模型、推理、工具、检索、缓存与速度会让实际额度消耗偏离 Token 比例。
            </template>
            <template v-else>
              Codex 没有公开固定的周 Token 总额；拿到完整的本周每日用量和周进度后，这里才会给出明确标注的外推估算。
            </template>
          </div>
        </template>
        <template v-else>
          <div class="cw-context-usage-heading">
            <strong>{{ contributors.length ? "Current context sources" : "Current context usage" }}</strong>
            <span>{{ ctxEstimatedTokens ? "~" : "" }}{{ fmt(ctxTokens) }} / {{ fmt(limit ?? 0) }}</span>
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
              <span>{{ sourceLabel(item.source) }}</span>
              <span class="cw-context-usage-value">~{{ fmt(item.tokens) }} · {{ item.percent }}%</span>
            </div>
            <div v-if="ctxReportedTokens !== undefined || ctxEstimatedTokens" class="cw-context-usage-meta">
              Codex reported current context {{ fmt(reportedTokens) }}
              <template v-if="ctxEstimatedTokens"> · local estimate ~{{ fmt(ctxEstimatedTokens) }}</template>
              <template v-else> · rows sum to this total</template>
            </div>
            <div class="cw-context-usage-note">
              <template v-if="ctxBreakdownFullScanRecords !== null && ctxBreakdownFullScanRecords !== undefined">
                Every physical rollout record was scanned. After compaction, the persisted replacement history is reconstructed and encrypted carry-over is shown as “compaction summary”. The first complete usage sample calibrates “Codex base context” because Codex counts hidden base instructions and tool schemas without writing them as rollout rows; later estimate noise cannot shrink that stable floor. Only the remaining changing estimate gap stays under “unattributed context”; known rows are never inflated to fill it.
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
        </template>
      </div>
    </div>
  </div>
</template>
