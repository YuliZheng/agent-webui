<script setup lang="ts">
import { computed, ref } from "vue";
import { Archive, ArchiveRestore, Pencil, Pin, Trash2 } from "lucide-vue-next";
import type { SessionListItem } from "@/types";
import { lockGestureAxis } from "@/util/session-list";
import { formatSessionListTime, sessionAppearance } from "@/util/session-appearance";
const props = defineProps<{ session: SessionListItem; selected?: boolean; unreadCount?: number; answering?: boolean; open?: boolean; taskCount?: number; pinned?: boolean; hidden?: boolean; multiSelect?: boolean; checked?: boolean }>();
const emit = defineEmits<{ select: []; tray: [id: string | null]; rename: []; delete: []; pin: []; hide: []; toggle: []; context: [value: { id: string; x: number; y: number }] }>();
const TRAY_WIDTH = 200;
const dx = ref(0); let startX = 0; let startY = 0; let axis: "x" | "y" | null = null;
const date = computed(() => new Date(props.session.lastTurnAt ?? props.session.mtime));
const time = computed(() => formatSessionListTime(date.value));
const datetime = computed(() => Number.isNaN(date.value.getTime()) ? undefined : date.value.toISOString());
const appearance = computed(() => sessionAppearance(props.session.cwd, props.session.agent, props.session.id));
const avatarStyle = computed(() => ({
  "--cw-session-accent": appearance.value.color,
  backgroundColor: appearance.value.color,
}));
const displayTitle = computed(() => props.session.title || props.session.cwd.split(/[\\/]/).filter(Boolean).pop() || "Untitled");
const isDraft = computed(() => props.session.id.startsWith("draft"));
const unreadLabel = computed(() => (props.unreadCount ?? 0) > 99 ? "99+" : String(props.unreadCount ?? 0));
function down(event: PointerEvent) { if (event.pointerType === "mouse" || props.multiSelect) return; startX = event.clientX; startY = event.clientY; axis = null; dx.value = props.open ? -TRAY_WIDTH : 0; }
function move(event: PointerEvent) {
  if (event.pointerType === "mouse" || props.multiSelect) return; const x = event.clientX - startX; const y = event.clientY - startY;
  if (!axis) axis = lockGestureAxis(x, y);
  if (axis === "x") { event.preventDefault(); dx.value = Math.max(-TRAY_WIDTH, Math.min(0, x + (props.open ? -TRAY_WIDTH : 0))); }
}
function up() { if (axis === "x") emit("tray", dx.value < -60 ? props.session.id : null); dx.value = 0; axis = null; }
</script>
<template>
  <div class="cw-session-row-wrap" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up" @contextmenu.prevent="emit('context', { id: session.id, x: $event.clientX, y: $event.clientY })">
    <div class="cw-swipe-tray" :class="{ active: (open || dx < 0) && !multiSelect }"><button title="Rename" aria-label="Rename session" @click="emit('rename')"><Pencil :size="16" /></button><button title="Pin" aria-label="Pin or unpin session" @click="emit('pin')"><Pin :size="16" /></button><button :title="hidden ? 'Unhide' : 'Hide'" :aria-label="hidden ? 'Unhide session' : 'Hide session'" @click="emit('hide')"><ArchiveRestore v-if="hidden" :size="16" /><Archive v-else :size="16" /></button><button class="danger" title="Delete" aria-label="Delete session" @click="emit('delete')"><Trash2 :size="16" /></button></div>
    <button class="cw-session-row" :class="{ selected, unread: unreadCount, 'is-answering': answering, 'has-session-state': answering || unreadCount, 'cw-session-row-selected': selected, 'multi-select': multiSelect }" :style="{ transform: `translateX(${open && !multiSelect ? -TRAY_WIDTH : dx}px)` }" @click="multiSelect ? emit('toggle') : emit('select')">
      <span class="cw-session-selected-strip" aria-hidden="true" />
      <span v-if="multiSelect" class="cw-multi-check" :class="{ checked }">{{ checked ? '✓' : '' }}</span>
      <span class="cw-session-avatar" :style="avatarStyle">
        <span class="cw-session-avatar-emoji">{{ session.titleEmoji || appearance.emoji }}</span>
        <span class="cw-session-agent-badge" :class="`is-${session.agent}`" :title="session.agent === 'codex' ? 'Codex' : 'Claude Code'">{{ session.agent === 'codex' ? 'C' : '✦' }}</span>
      </span>
      <span class="cw-session-copy">
        <span class="cw-session-title"><b>{{ displayTitle }}</b><time class="cw-session-time" :datetime="datetime">{{ time }}</time></span>
        <span v-if="session.preview" class="cw-session-preview" :class="{ 'cw-session-preview-draft': isDraft }">{{ session.preview }}</span>
        <span class="cw-session-cwd">{{ session.cwd }}</span>
        <span v-if="pinned || taskCount || session.status === 'running'" class="cw-session-meta"><i v-if="pinned">pinned</i><i v-if="taskCount">{{ taskCount }} tasks</i><i v-if="session.status === 'running'" class="active cw-session-running-dot"><span />active</i></span>
      </span>
      <span v-if="answering || unreadCount" class="cw-session-state-slot">
        <span v-if="answering" class="cw-session-answering-indicator" role="status" aria-label="Agent is answering" title="Agent is answering" />
        <span v-else-if="unreadCount" class="cw-session-unread" :aria-label="`${unreadCount} unread ${unreadCount === 1 ? 'reply' : 'replies'}`" :title="`${unreadCount} unread ${unreadCount === 1 ? 'reply' : 'replies'}`">{{ unreadLabel }}</span>
      </span>
    </button>
  </div>
</template>
