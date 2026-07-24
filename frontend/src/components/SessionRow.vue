<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import AgentBadge from "./AgentBadge.vue";
import type { SessionListItem } from "@/types";
import { lockGestureAxis } from "@/util/session-list";
import { formatSessionListTime, sessionAppearance } from "@/util/session-appearance";

const props = withDefaults(defineProps<{
  session: SessionListItem;
  selected?: boolean;
  unreadCount?: number;
  answering?: boolean;
  compacting?: boolean;
  failed?: boolean;
  open?: boolean;
  taskCount?: number;
  pinned?: boolean;
  hidden?: boolean;
  multiSelect?: boolean;
  checked?: boolean;
  depth?: number;
  hideCwd?: boolean;
}>(), {
  unreadCount: 0,
  taskCount: 0,
  depth: 0,
  hideCwd: true,
});
const emit = defineEmits<{
  select: [];
  tray: [id: string | null];
  rename: [];
  delete: [];
  pin: [];
  hide: [];
  toggle: [];
  context: [value: { id: string; x: number; y: number }];
}>();

const TRAY_WIDTH = 210;
const dx = ref(0);
const now = ref(Date.now());
const deleteArmed = ref(false);
let startX = 0;
let startY = 0;
let axis: "x" | "y" | null = null;
let clock: ReturnType<typeof setInterval> | undefined;
let deleteTimer: ReturnType<typeof setTimeout> | undefined;

const date = computed(() => new Date(props.session.lastTurnAt ?? props.session.mtime));
const time = computed(() => formatSessionListTime(date.value));
const datetime = computed(() => Number.isNaN(date.value.getTime()) ? undefined : date.value.toISOString());
const appearance = computed(() => sessionAppearance(props.session.cwd, props.session.agent, props.session.id));
const avatarStyle = computed(() => ({
  "--cw-session-accent": appearance.value.color,
  backgroundImage: appearance.value.gradient,
}));
const rowStyle = computed(() => ({
  transform: `translateX(${props.open && !props.multiSelect ? -TRAY_WIDTH : dx.value}px)`,
  paddingLeft: `${12 + Math.max(0, props.depth) * 14}px`,
}));
const displayTitle = computed(() => props.session.title || props.session.cwd.split(/[\\/]/).filter(Boolean).pop() || "Untitled");
const isDraft = computed(() => props.session.id.startsWith("draft"));
const unreadLabel = computed(() => props.unreadCount > 99 ? "99+" : String(props.unreadCount));
const thinkingSeconds = computed(() => {
  const started = new Date(props.session.lastBoundaryAt ?? props.session.lastTurnAt ?? props.session.mtime).getTime();
  return Math.max(0, Math.floor((now.value - (Number.isFinite(started) ? started : now.value)) / 1000));
});
const previewText = computed(() => {
  if (props.compacting) return "🗜 Compacting…";
  if (props.answering) return `${props.session.agent === "codex" ? "Codex" : "Claude"} is thinking… ${thinkingSeconds.value}s`;
  if (isDraft.value) return `[Draft] ${props.session.preview?.replace(/^Draft\s*[—-]\s*/i, "") || "New session"}`;
  const preview = props.session.preview?.trim() ?? "";
  const imageMatch = preview.match(/(?:^|\s)(\d+)\s+images?\b/i);
  return imageMatch ? `📷 ${imageMatch[1]} images` : preview;
});

watch(() => props.answering, (active) => {
  if (clock) clearInterval(clock);
  clock = active ? setInterval(() => { now.value = Date.now(); }, 1_000) : undefined;
}, { immediate: true });
watch(() => props.open, (open) => {
  if (!open) disarmDelete();
});
onBeforeUnmount(() => {
  if (clock) clearInterval(clock);
  if (deleteTimer) clearTimeout(deleteTimer);
});

function down(event: PointerEvent) {
  if (event.pointerType === "mouse" || props.multiSelect) return;
  startX = event.clientX;
  startY = event.clientY;
  axis = null;
  dx.value = props.open ? -TRAY_WIDTH : 0;
}
function move(event: PointerEvent) {
  if (event.pointerType === "mouse" || props.multiSelect) return;
  const x = event.clientX - startX;
  const y = event.clientY - startY;
  if (!axis) axis = lockGestureAxis(x, y);
  if (axis === "x") {
    event.preventDefault();
    dx.value = Math.max(-TRAY_WIDTH, Math.min(0, x + (props.open ? -TRAY_WIDTH : 0)));
  }
}
function up() {
  if (axis === "x") emit("tray", dx.value < -60 ? props.session.id : null);
  dx.value = 0;
  axis = null;
}
function disarmDelete() {
  deleteArmed.value = false;
  if (deleteTimer) clearTimeout(deleteTimer);
  deleteTimer = undefined;
}
function requestDelete() {
  if (!deleteArmed.value) {
    deleteArmed.value = true;
    if (deleteTimer) clearTimeout(deleteTimer);
    deleteTimer = setTimeout(disarmDelete, 3_000);
    return;
  }
  disarmDelete();
  emit("delete");
}
</script>

<template>
  <div
    class="cw-session-row-wrap"
    @pointerdown="down"
    @pointermove="move"
    @pointerup="up"
    @pointercancel="up"
    @contextmenu.prevent="emit('context', { id: session.id, x: $event.clientX, y: $event.clientY })"
  >
    <div class="cw-swipe-tray" :class="{ active: (open || dx < 0) && !multiSelect }">
      <button title="Rename" aria-label="Rename session" @click="emit('rename')"><span aria-hidden="true">✎</span><small>Rename</small></button>
      <button :title="pinned ? 'Unpin' : 'Pin'" aria-label="Pin or unpin session" @click="emit('pin')"><span aria-hidden="true">{{ pinned ? "☆" : "★" }}</span><small>{{ pinned ? "Unpin" : "Pin" }}</small></button>
      <button class="danger" :class="{ confirm: deleteArmed }" title="Delete" aria-label="Delete session" @click="requestDelete"><span aria-hidden="true">{{ deleteArmed ? "!" : "×" }}</span><small>{{ deleteArmed ? "Confirm" : "Delete" }}</small></button>
    </div>
    <button
      class="cw-session-row"
      :class="{
        selected,
        unread: unreadCount,
        'is-answering': answering,
        'is-failed': failed,
        'cw-session-row-selected': selected,
        'multi-select': multiSelect,
      }"
      :style="rowStyle"
      @click="multiSelect ? emit('toggle') : emit('select')"
    >
      <span class="cw-session-selected-strip" aria-hidden="true" />
      <span v-if="multiSelect" class="cw-multi-check" :class="{ checked }">{{ checked ? "✓" : "" }}</span>
      <span class="cw-session-avatar" :style="avatarStyle">
        <span class="cw-session-avatar-emoji">{{ session.titleEmoji || appearance.emoji }}</span>
        <AgentBadge class="cw-session-agent-badge" :agent="session.agent" :size="17" />
      </span>
      <span class="cw-session-copy">
        <span class="cw-session-title">
          <b>
            <span v-if="isDraft" class="cw-session-draft-dot" aria-label="Draft" title="Draft" />
            <span v-if="pinned" class="cw-session-inline-mark" aria-label="Pinned" title="Pinned">★</span>
            {{ displayTitle }}
            <span v-if="session.titleSource === 'manual'" class="cw-session-inline-mark" aria-label="Manual title" title="Manual title">✎</span>
            <span v-if="session.peer" class="cw-session-inline-mark" aria-label="Peer session" title="Peer session">🔕</span>
          </b>
          <time class="cw-session-time" :datetime="datetime">{{ time }}</time>
        </span>
        <span class="cw-session-preview-row">
          <span v-if="answering" class="cw-session-running-dot" role="status" aria-label="Agent is thinking"><span class="ping" /><span class="dot" /></span>
          <span v-else-if="failed || session.status === 'failed'" class="cw-session-failed-dot" role="status" aria-label="Session failed" />
          <span v-if="previewText" class="cw-session-preview" :class="{ 'cw-session-preview-draft': isDraft, 'is-thinking': answering }">{{ previewText }}</span>
          <span v-if="taskCount" class="cw-session-task-badge" :title="`${taskCount} running background task${taskCount === 1 ? '' : 's'}`">⟳{{ taskCount }}</span>
          <span v-if="unreadCount" class="cw-session-unread" :aria-label="`${unreadCount} unread ${unreadCount === 1 ? 'reply' : 'replies'}`">{{ unreadLabel }}</span>
        </span>
        <span v-if="!hideCwd" class="cw-session-cwd" :style="{ color: appearance.color }">{{ session.cwd }}</span>
      </span>
    </button>
  </div>
</template>
