<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { AgentKind, Interaction, MessageDisplayStyle, NormalizedBlock, PendingPromptChip } from "@/types";
import TranscriptEntry from "./TranscriptEntry.vue";
import UserPromptBlock from "./blocks/UserPromptBlock.vue";
import { mainSocket } from "@/api/ws";
import { useInteractionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { useLiveStore } from "@/stores/live";
import { contextUsageSnapshot } from "@/parser";

const props = defineProps<{
  sessionId: string;
  agent: AgentKind;
  blocks: NormalizedBlock[];
  chips: PendingPromptChip[];
  style: MessageDisplayStyle;
  loading?: boolean;
  loadingEarlier?: boolean;
  firstSourceIndex?: number;
  scrollTargetUuid?: string;
  scrollTargetIndex?: number;
}>();
const emit = defineEmits<{
  prefill: [text: string];
  forked: [data: { newSessionId: string; prefillText: string }];
  retryChip: [chip: PendingPromptChip];
  dismissChip: [chipId: string];
  loadEarlier: [];
  compact: [];
  newChat: [];
}>();
const interactions = useInteractionsStore();
const ui = useUiStore();
const live = useLiveStore();
const messageDisplayStyle = computed(() => props.style);
const messageDisplayClass = computed(() => `cw-display-${messageDisplayStyle.value}`);
const scroller = ref<HTMLElement | null>(null);
const contextUsage = computed(() => contextUsageSnapshot(props.blocks));
const showContextNotice = computed(() =>
  !!contextUsage.value && (contextUsage.value.percent > 70 || contextUsage.value.overLimit)
);

function formatTokenCount(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

const INITIAL_RENDER_FAST = 30;
const INITIAL_RENDER_FULL = 200;
const RENDER_BATCH = 200;
const AUTO_LOAD_THRESHOLD_PX = 200;
const NEAR_BOTTOM_PX = 24;
const renderLimit = ref(INITIAL_RENDER_FAST);
const renderedSlice = computed(() => {
  const start = Math.max(0, props.blocks.length - renderLimit.value);
  return { start, items: props.blocks.slice(start) };
});

let initialScrollDone = false;
const stickToBottom = ref(true);
const loadingLocalEarlier = ref(false);
let beforeEarlierHeight = 0;
let preserveEarlierScroll = false;
let overlayRaf = 0;
let expandTimer: number | undefined;
let idleHandle: number | undefined;

async function rewind(block: NormalizedBlock) {
  if (!block.uuid) return;
  const detail = props.agent === "codex"
    ? "Later Codex turns will be removed from thread history. Files changed by those turns are not reverted."
    : "Later transcript records will be removed.";
  if (!confirm(`Rewind this session to before this prompt?\n\n${detail}`)) return;
  try {
    const data = await mainSocket.request<{ prefillText: string }>("rewind", { sessionId: props.sessionId, messageUuid: block.uuid }, 30_000);
    await live.reload(props.sessionId);
    emit("prefill", data.prefillText ?? block.text ?? "");
  } catch (error) {
    ui.toast(error instanceof Error ? error.message : "Could not rewind the session", "error");
  }
}
async function fork(block: NormalizedBlock) {
  if (!block.uuid) return;
  try {
    const data = await mainSocket.request<{ newSessionId: string; prefillText: string }>("fork", { sessionId: props.sessionId, messageUuid: block.uuid }, 30_000);
    emit("forked", { newSessionId: data.newSessionId, prefillText: data.prefillText ?? block.text ?? "" });
  } catch (error) {
    ui.toast(error instanceof Error ? error.message : "Could not fork the session", "error");
  }
}
function blockInteractions(block: NormalizedBlock): Interaction[] {
  const toolIds = block.kind === "tool-run"
    ? (block.children ?? []).map((child) => child.toolUseId).filter((id): id is string => !!id)
    : block.toolUseId ? [block.toolUseId] : [];
  return toolIds.length
    ? interactions.items.filter((item) => item.sessionId === props.sessionId && !!item.toolUseId && toolIds.includes(item.toolUseId))
    : [];
}
function visualUuid(block: NormalizedBlock): string {
  return block.uuid || block.toolUseId || block.key;
}
function roleFor(block: NormalizedBlock): "user" | "assistant" | "system" {
  return block.kind === "user" ? "user" :
    ["assistant", "thinking", "tool", "tool-run"].includes(block.kind) ? "assistant" : "system";
}
function blockName(block: NormalizedBlock): string {
  if (block.kind === "user") return "UserPromptBlock";
  if (block.kind === "assistant" || block.kind === "thinking") return "AssistantBlock";
  if (block.kind === "tool-run") return "ToolRunBlock";
  if (block.kind === "tool") return "ToolCall";
  return "SystemBlock";
}

async function loadEarlier() {
  if (props.loadingEarlier || loadingLocalEarlier.value) return;
  const element = scroller.value;
  beforeEarlierHeight = element?.scrollHeight ?? 0;
  preserveEarlierScroll = true;
  if (props.blocks.length > renderedSlice.value.items.length) {
    loadingLocalEarlier.value = true;
    renderLimit.value = Math.min(props.blocks.length, renderLimit.value + RENDER_BATCH);
    await nextTick();
    if (element) element.scrollTop += element.scrollHeight - beforeEarlierHeight;
    preserveEarlierScroll = false;
    loadingLocalEarlier.value = false;
    recomputeStickyPrompt();
    return;
  }
  if ((props.firstSourceIndex ?? 0) > 0) emit("loadEarlier");
  else preserveEarlierScroll = false;
}
function atBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= NEAR_BOTTOM_PX;
}
function onScroll() {
  const element = scroller.value;
  if (!element) return;
  stickToBottom.value = atBottom(element);
  if (element.scrollTop <= AUTO_LOAD_THRESHOLD_PX) void loadEarlier();
  scheduleStickyPrompt();
}
function scrollToBottom() {
  const element = scroller.value;
  if (!element) return;
  element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
}
function navigatePrompt(direction: -1 | 1) {
  const element = scroller.value;
  if (!element) return;
  const anchors = [...element.querySelectorAll<HTMLElement>(".cw-user-prompt-anchor[data-user-prompt='true']")];
  const viewportTop = element.getBoundingClientRect().top + 1;
  const current = anchors.findIndex((anchor) => anchor.getBoundingClientRect().top >= viewportTop);
  const index = direction < 0
    ? Math.max(0, (current < 0 ? anchors.length : current) - 1)
    : Math.min(anchors.length - 1, current < 0 ? anchors.length - 1 : current + 1);
  anchors[index]?.scrollIntoView({ block: "start", behavior: "smooth" });
}

const stickyPromptUuid = ref<string | null>(null);
const CLAUDE_CODE_STICKY_GAP_PX = 12;
const stickyPushPx = ref(0);
const stickyPromptStyles = new Set<MessageDisplayStyle>(["claude-code"]);
const stickyOverlayEl = ref<HTMLElement | null>(null);
let stickyOverlayRO: ResizeObserver | null = null;

const stickyPromptOverlayEntry = computed<NormalizedBlock | null>(() => {
  if (messageDisplayStyle.value !== "claude-code") return null;
  const uuid = stickyPromptUuid.value;
  if (!uuid) return null;
  return props.blocks.find((entry) => entry.kind === "user" && visualUuid(entry) === uuid) ?? null;
});
function isStickyPromptEntry(_entry: NormalizedBlock): boolean {
  if (messageDisplayStyle.value === "claude-code") return false;
  return false;
}
function stickyPromptOverlayStyle(): Record<string, string> | undefined {
  if (!stickyPromptOverlayEntry.value) return undefined;
  return { transform: `translateY(${-stickyPushPx.value}px)` };
}
function scheduleStickyPrompt() {
  cancelAnimationFrame(overlayRaf);
  overlayRaf = requestAnimationFrame(recomputeStickyPrompt);
}
function recomputeStickyPrompt() {
  const element = scroller.value;
  if (!element || !stickyPromptStyles.has(messageDisplayStyle.value)) {
    stickyPromptUuid.value = null;
    stickyPushPx.value = 0;
    return;
  }
  const nodes = element.querySelectorAll<HTMLElement>(".cw-user-prompt-anchor[data-user-prompt='true']");
  const elementRect = element.getBoundingClientRect();
  const isClaudeCode = messageDisplayStyle.value === "claude-code";
  const stickyTop = isClaudeCode ? CLAUDE_CODE_STICKY_GAP_PX : 0;
  const anchor = element.scrollTop + stickyTop + 1;
  let active: string | null = null;
  let activeTop = -Infinity;
  const tops: number[] = [];
  for (const node of nodes) {
    const uuid = node.dataset.uuid || null;
    if (!uuid) continue;
    const rect = node.getBoundingClientRect();
    const top = rect.top - elementRect.top + element.scrollTop;
    tops.push(top);
    if (top <= anchor && top > activeTop) {
      activeTop = top;
      active = uuid;
    }
  }
  if (stickyPromptUuid.value !== active) stickyPromptUuid.value = active;
  let push = 0;
  if (active) {
    let nextTop = Infinity;
    for (const top of tops) if (top > activeTop + 1 && top < nextTop) nextTop = top;
    if (nextTop !== Infinity && stickyOverlayEl.value) {
      const frame = stickyOverlayEl.value.parentElement;
      if (frame) {
        const frameTop = frame.getBoundingClientRect().top - elementRect.top + element.scrollTop;
        const pinBottom = frameTop + stickyOverlayEl.value.offsetHeight + 4;
        if (nextTop < pinBottom) push = pinBottom - nextTop;
      }
    }
  }
  const roundedPush = Math.max(0, Math.round(push));
  if (stickyPushPx.value !== roundedPush) stickyPushPx.value = roundedPush;
}

watch(stickyOverlayEl, (element) => {
  if (typeof ResizeObserver === "undefined") return;
  if (!stickyOverlayRO) stickyOverlayRO = new ResizeObserver(recomputeStickyPrompt);
  stickyOverlayRO.disconnect();
  if (element) stickyOverlayRO.observe(element);
});
watch(() => props.blocks.length, async () => {
  const shouldScrollToBottom = !initialScrollDone || stickToBottom.value;
  await nextTick();
  if (scroller.value && shouldScrollToBottom && !preserveEarlierScroll) scroller.value.scrollTop = scroller.value.scrollHeight;
  initialScrollDone = true;
  scheduleStickyPrompt();
});
watch([messageDisplayStyle, () => renderedSlice.value.items.length], async () => {
  await nextTick();
  recomputeStickyPrompt();
});
let handledSearchTarget = "";
watch(() => props.sessionId, async () => {
  renderLimit.value = INITIAL_RENDER_FAST;
  initialScrollDone = false;
  stickToBottom.value = true;
  stickyPromptUuid.value = null;
  stickyPushPx.value = 0;
  handledSearchTarget = "";
  await nextTick();
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
});
watch(
  [() => props.scrollTargetUuid, () => props.scrollTargetIndex, () => props.blocks.length],
  async ([uuid, index]) => {
  if (!uuid && !Number.isSafeInteger(index)) return;
  const token = `${props.sessionId}:${uuid ?? ""}:${index ?? ""}`;
  if (handledSearchTarget === token) return;
  const targetBlock = props.blocks.find((block) =>
    (!!uuid && (block.uuid === uuid || block.toolUseId === uuid)) ||
    (Number.isSafeInteger(index) && block.sourceIndexes.includes(index as number))
  );
  if (!targetBlock) return;
  const blockPosition = props.blocks.indexOf(targetBlock);
  // Search reads a bounded old window plus the live tail. Expand only far
  // enough to expose that hit; ordinary first paint remains a 30/200-row tail.
  renderLimit.value = Math.max(
    renderLimit.value,
    props.blocks.length - Math.max(0, blockPosition),
  );
  await nextTick();
  const target = scroller.value?.querySelector<HTMLElement>(
    `[data-message-key="${CSS.escape(targetBlock.key)}"]`
  );
  if (target) {
    handledSearchTarget = token;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.add("cw-search-highlight");
    setTimeout(() => target.classList.remove("cw-search-highlight"), 2200);
  }
}, { flush: "post" });
watch(() => props.firstSourceIndex, async (next, previous) => {
  if (!preserveEarlierScroll || previous === undefined || next === undefined || next >= previous) return;
  await nextTick();
  if (scroller.value) scroller.value.scrollTop += scroller.value.scrollHeight - beforeEarlierHeight;
  preserveEarlierScroll = false;
});
watch(() => props.loadingEarlier, (loading) => {
  if (!loading) preserveEarlierScroll = false;
});

onMounted(async () => {
  scroller.value?.addEventListener("scroll", onScroll, { passive: true });
  await nextTick();
  if (scroller.value && props.blocks.length) scroller.value.scrollTop = scroller.value.scrollHeight;
  initialScrollDone = true;
  recomputeStickyPrompt();
  const expand = async () => {
    if (renderLimit.value < INITIAL_RENDER_FULL) {
      const wasBottom = scroller.value ? atBottom(scroller.value) : false;
      renderLimit.value = INITIAL_RENDER_FULL;
      await nextTick();
      if (wasBottom && scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
      recomputeStickyPrompt();
    }
  };
  const idleWindow = window as Window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number };
  if (typeof idleWindow.requestIdleCallback === "function") idleHandle = idleWindow.requestIdleCallback(() => void expand(), { timeout: 1500 });
  else expandTimer = window.setTimeout(() => void expand(), 250);
});
onBeforeUnmount(() => {
  scroller.value?.removeEventListener("scroll", onScroll);
  cancelAnimationFrame(overlayRaf);
  stickyOverlayRO?.disconnect();
  stickyOverlayRO = null;
  if (expandTimer !== undefined) clearTimeout(expandTimer);
  const idleWindow = window as Window & { cancelIdleCallback?: (id: number) => void };
  if (idleHandle !== undefined) idleWindow.cancelIdleCallback?.(idleHandle);
});
</script>

<template>
  <div
    class="cw-transcript-frame cw-message-list"
    :class="messageDisplayClass"
    :data-message-display="messageDisplayStyle"
  >
    <div v-if="stickyPromptOverlayEntry" class="cw-sticky-prompt-overlay-frame">
      <div ref="stickyOverlayEl" class="cw-sticky-prompt-overlay" :style="stickyPromptOverlayStyle()">
        <UserPromptBlock
          :key="visualUuid(stickyPromptOverlayEntry)"
          :block="stickyPromptOverlayEntry"
          :display-style="style"
          preview
          hide-actions
        />
      </div>
    </div>
    <div ref="scroller" class="cw-transcript-scroll cw-message-scroller">
      <button
        v-if="blocks.length > renderedSlice.items.length || (firstSourceIndex || 0) > 0"
        class="cw-load-earlier"
        :disabled="loadingEarlier || loadingLocalEarlier"
        @click="loadEarlier"
      >{{ loadingEarlier || loadingLocalEarlier ? "Loading…" : "Load earlier" }}</button>
      <div v-if="loading" class="cw-empty">Restoring cached transcript…</div>
      <div v-else-if="!blocks.length" class="cw-empty">No transcript records yet.</div>
      <template v-for="block in renderedSlice.items" :key="block.key">
        <div
          v-if="block.kind === 'user'"
          class="cw-user-prompt-anchor"
          data-user-prompt="true"
          :data-uuid="visualUuid(block)"
          aria-hidden="true"
        />
        <TranscriptEntry
          :block="block"
          :actions="true"
          :interactions="blockInteractions(block)"
          :display-style="style"
          @rewind="rewind"
          @fork="fork"
        />
      </template>
      <div
        v-for="chip in chips"
        :key="chip.id"
        class="cw-pending-chip cw-queue-chip"
        :class="[
          `cw-pending-${chip.state}`,
          { 'cw-queue-chip-optimistic': chip.state === 'sending' || chip.state === 'queued' || chip.state === 'steered' },
          { 'cw-queue-chip-failed': chip.state === 'retry' }
        ]"
      >
        <span class="cw-queue-chip-label">{{ chip.steered ? "steered" : chip.state }}</span>
        {{ chip.text || `${chip.imageCount} attachment(s)` }}
        <span v-if="chip.state === 'retry' || chip.steered" class="cw-pending-actions">
          <button @click="emit('retryChip', chip)">Retry</button>
          <button @click="emit('dismissChip', chip.id)">Dismiss</button>
        </span>
      </div>
      <div class="cw-transcript-spacer" />
    </div>
    <div
      v-if="showContextNotice && contextUsage"
      class="cw-context-notice"
      :class="{ 'is-over-limit': contextUsage.overLimit }"
      role="status"
    >
      <span>
        context {{ formatTokenCount(contextUsage.usedTokens) }}
        <template v-if="contextUsage.totalTokens !== null"> · total {{ formatTokenCount(contextUsage.totalTokens) }}</template>
        · {{ contextUsage.overLimit ? "over limit" : `usage ${contextUsage.percent}%` }}
      </span>
      <button type="button" @click="emit('compact')">Compact</button>
      <button type="button" @click="emit('newChat')">New chat</button>
    </div>
    <div class="cw-prompt-nav">
      <button type="button" class="cw-floating-nav-button" aria-label="Previous prompt" @click="navigatePrompt(-1)">↑</button>
      <button type="button" class="cw-floating-nav-button" aria-label="Next prompt" @click="navigatePrompt(1)">↓</button>
    </div>
    <button v-if="!stickToBottom" type="button" class="cw-floating-nav-button cw-scroll-bottom-button" aria-label="Scroll to bottom" @click="scrollToBottom">↓</button>
  </div>
</template>
