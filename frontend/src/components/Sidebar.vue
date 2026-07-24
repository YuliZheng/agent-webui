<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { SessionListItem } from "@/types";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  LoaderCircle,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  X,
} from "@/components/icons";
import SessionRow from "./SessionRow.vue";
import { useSessionsStore, useBackgroundTasksStore } from "@/stores/sessions";
import { usePreferencesStore } from "@/stores/preferences";
import { pendingSessions } from "@/persist/drafts";
import { mainSocket, WsError } from "@/api/ws";
import {
  lockGestureAxis,
  reconcileSelectedIds,
  sortPinnedByActivity,
} from "@/util/session-list";

type SidebarItem = SessionListItem & { createdAt?: number };
interface SidebarSection {
  id: string;
  name: string;
  cwd?: string;
  items: SidebarItem[];
  collapsed: boolean;
  pinned: boolean;
  automatic: boolean;
}

const emit = defineEmits<{
  select: [id: string, uuid?: string, index?: number];
  new: [cwd?: string];
  settings: [];
  refresh: [];
  delete: [id: string];
  deleteMany: [ids: string[]];
  rename: [id: string, title: string];
}>();

const sessions = useSessionsStore();
const prefs = usePreferencesStore();
const tasks = useBackgroundTasksStore();
const trayId = ref<string | null>(null);
const contextMenu = ref<{ id: string; left: number; top: number } | null>(null);
const searchOpen = ref(false);
const searchInput = ref<HTMLInputElement | null>(null);
const searching = ref(false);
const searchError = ref("");
const multiMode = ref(false);
const selectedIds = ref<string[]>([]);
const listEl = ref<HTMLElement | null>(null);
const pullDistance = ref(0);
const pullRefreshing = ref(false);
const viewMode = ref<"grouped" | "flat">(
  localStorage.getItem("agent-webui:sidebar-view:v1") === "flat" ? "flat" : "grouped",
);
const collapsedCwdIds = ref<string[]>(readCollapsedCwds());
let searchSequence = 0;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let pullStartX = 0;
let pullStartY = 0;
let pullDx = 0;
let pullDy = 0;
let pullAtTop = false;
let pullAxis: "x" | "y" | null = null;

const PULL_THRESHOLD = 60;
const PULL_MAX = 90;
const PULL_REFRESH_HOLD = 50;

const allItems = computed<SidebarItem[]>(() => [
  ...pendingSessions.items.map((item): SidebarItem => ({
    id: item.id,
    cwd: item.cwd,
    agent: item.agent,
    mtime: new Date(item.createdAt).toISOString(),
    size: 0,
    title: item.title ?? "New session",
    preview: "Draft — not started",
    peer: false,
    createdAt: item.createdAt,
  })),
  ...sessions.sorted,
]);

const searchQuery = computed(() => sessions.searchQuery.trim());
const searchMode = computed(() => searchOpen.value || Boolean(searchQuery.value));
const hiddenCount = computed(() => prefs.prefs.hiddenSessionIds.length);
const filtered = computed(() => allItems.value.filter((item) => {
  if (!prefs.prefs.showPeerSessions && item.peer) return false;
  const hidden = prefs.prefs.hiddenSessionIds.includes(item.id);
  if (hidden !== sessions.hiddenShown) return false;
  const query = searchQuery.value.toLowerCase();
  return !query
    || `${item.id} ${item.title ?? ""} ${item.cwd} ${item.preview ?? ""}`.toLowerCase().includes(query)
    || Boolean(sessions.contentMatches[item.id]);
}));

watch(() => sessions.searchQuery, (query) => {
  const sequence = ++searchSequence;
  const normalized = query.trim();
  clearTimeout(searchTimer);
  sessions.contentMatches = {};
  searching.value = false;
  searchError.value = "";
  void mainSocket.request("search-content", { query: "" }, 5_000).catch(() => undefined);
  if (normalized.length < 2) return;
  searchTimer = setTimeout(async () => {
    if (sequence !== searchSequence) return;
    searching.value = true;
    try {
      const result = await mainSocket.request<{
        matches: Array<{
          id: string;
          score: number;
          lastMatchUuid?: string | null;
          lastMatchIndex?: number | null;
        }>;
      }>("search-content", { query: normalized }, 120_000);
      if (sequence !== searchSequence) return;
      sessions.contentMatches = Object.fromEntries(result.matches.map((match) => [
        match.id,
        {
          score: match.score,
          lastMatchUuid: match.lastMatchUuid,
          lastMatchIndex: match.lastMatchIndex,
        },
      ]));
    } catch (error) {
      if (sequence !== searchSequence || (error instanceof WsError && error.code === 499)) return;
      searchError.value = error instanceof Error ? error.message : "Search failed";
    } finally {
      if (sequence === searchSequence) searching.value = false;
    }
  }, 450);
});

onBeforeUnmount(() => {
  clearTimeout(searchTimer);
  searchSequence++;
  void mainSocket.request("search-content", { query: "" }, 5_000).catch(() => undefined);
});

const isAnswering = (id: string): boolean => Boolean(
  sessions.statuses[id]?.status === "running"
  || sessions.items.find((item) => item.id === id)?.status === "running",
);
const isCompacting = (id: string): boolean => Boolean(sessions.statuses[id]?.compacting);
const isFailed = (id: string): boolean => Boolean(
  sessions.statuses[id]?.status === "failed"
  || sessions.items.find((item) => item.id === id)?.status === "failed",
);
const isActive = (id: string): boolean => Boolean(
  isAnswering(id)
  || isCompacting(id)
  || tasks.bySession[id]?.some((task) => task.status === "running"),
);
const itemEffectiveTime = (item: SidebarItem): number => (
  item.createdAt != null
    ? item.createdAt
    : sessions.items.some((session) => session.id === item.id)
      ? sessions.effectiveTime(item)
      : new Date(item.mtime).getTime()
);
const pinnedItems = computed(() => searchMode.value
  ? []
  : sortPinnedByActivity(
    filtered.value.filter((item) => prefs.prefs.pinnedSessionIds.includes(item.id)),
    isActive,
    itemEffectiveTime,
  ));
const activeItems = computed(() => searchMode.value || !prefs.prefs.showActiveSection
  ? []
  : filtered.value.filter((item) => (
    !prefs.prefs.pinnedSessionIds.includes(item.id) && isActive(item.id)
  )));
const regularItems = computed(() => {
  if (searchMode.value) {
    const query = searchQuery.value.toLowerCase();
    return [...filtered.value].sort((a, b) => (
      idMatchRank(b.id, query) - idMatchRank(a.id, query)
      || (sessions.contentMatches[b.id]?.score ?? 0) - (sessions.contentMatches[a.id]?.score ?? 0)
      || itemEffectiveTime(b) - itemEffectiveTime(a)
    ));
  }
  return (prefs.prefs.showActiveSection
    ? filtered.value.filter((item) => !isActive(item.id))
    : filtered.value)
    .filter((item) => !prefs.prefs.pinnedSessionIds.includes(item.id));
});
const searchSectionLabel = computed(() => {
  if (searchQuery.value.length < 2) return "输入至少 2 个字符，搜索全部对话内容";
  if (searching.value) return "正在搜索每条消息…";
  if (searchError.value) return searchError.value;
  return `${regularItems.value.length} 个结果`;
});

const groupSections = computed<SidebarSection[]>(() => {
  if (searchMode.value) {
    return [{
      id: "search-results",
      name: searchSectionLabel.value,
      items: regularItems.value,
      collapsed: false,
      pinned: false,
      automatic: false,
    }];
  }
  if (viewMode.value === "flat") {
    return [{
      id: "recent",
      name: "Recent",
      items: regularItems.value,
      collapsed: false,
      pinned: false,
      automatic: false,
    }];
  }
  const orderedGroups = [...prefs.prefs.groups].sort((a, b) => {
    const ai = prefs.prefs.pinnedGroupIds.indexOf(a.id);
    const bi = prefs.prefs.pinnedGroupIds.indexOf(b.id);
    return (ai < 0 ? 1e9 : ai) - (bi < 0 ? 1e9 : bi);
  });
  const claimed = new Set(orderedGroups.flatMap((group) => group.sessionIds));
  const manual: SidebarSection[] = orderedGroups.map((group) => ({
    id: group.id,
    name: group.name,
    items: regularItems.value.filter((item) => group.sessionIds.includes(item.id)),
    collapsed: group.collapsed === true,
    pinned: prefs.prefs.pinnedGroupIds.includes(group.id),
    automatic: false,
  }));
  const cwdBuckets = new Map<string, SidebarItem[]>();
  for (const item of regularItems.value) {
    if (claimed.has(item.id)) continue;
    const key = normalizedCwd(item.cwd);
    const bucket = cwdBuckets.get(key) ?? [];
    bucket.push(item);
    cwdBuckets.set(key, bucket);
  }
  const automatic = [...cwdBuckets.entries()]
    .map(([cwd, items]): SidebarSection => ({
      id: `cwd:${cwd}`,
      name: cwdLabel(cwd),
      cwd,
      items,
      collapsed: collapsedCwdIds.value.includes(cwd),
      pinned: false,
      automatic: true,
    }))
    .sort((a, b) => (
      Math.max(...b.items.map(itemEffectiveTime))
      - Math.max(...a.items.map(itemEffectiveTime))
    ));
  return [...manual.filter((section) => section.items.length), ...automatic];
});

function readCollapsedCwds(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem("agent-webui:collapsed-cwds:v1") ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
function normalizedCwd(cwd: string): string {
  return cwd.replace(/[\\/]+$/, "").replaceAll("\\", "/").toLowerCase();
}
function cwdLabel(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  if (!parts.length) return cwd;
  const tail = parts.at(-1)!;
  const parent = parts.length > 1 ? parts.at(-2)! : "";
  return parent ? `${tail}  ·  ${parent}` : tail;
}
function idMatchRank(id: string, query: string): number {
  if (!query) return 0;
  const value = id.toLowerCase();
  if (value === query) return 3;
  if (value.startsWith(query)) return 2;
  return value.includes(query) ? 1 : 0;
}
function taskCount(id: string): number {
  return tasks.bySession[id]?.filter((task) => task.status === "running").length ?? 0;
}
function depthFor(item: SidebarItem): number {
  let depth = 0;
  let parent = item.parentSessionId ?? null;
  const byId = new Map(allItems.value.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  while (parent && depth < 8 && !seen.has(parent)) {
    seen.add(parent);
    depth++;
    parent = byId.get(parent)?.parentSessionId ?? null;
  }
  return depth;
}
function sectionUnread(section: SidebarSection): number {
  return section.items.reduce((sum, item) => sum + sessions.unreadCount(item), 0);
}
function sectionActive(section: SidebarSection): boolean {
  return section.items.some((item) => isActive(item.id));
}
function isRealSession(id: string): boolean {
  return sessions.items.some((item) => item.id === id);
}
function pin(id: string) {
  if (!isRealSession(id)) return;
  const list = prefs.prefs.pinnedSessionIds;
  prefs.prefs.pinnedSessionIds = list.includes(id)
    ? list.filter((value) => value !== id)
    : [id, ...list];
  void prefs.save();
  trayId.value = null;
}
function hide(id: string) {
  if (!isRealSession(id)) return;
  const list = prefs.prefs.hiddenSessionIds;
  prefs.prefs.hiddenSessionIds = list.includes(id)
    ? list.filter((value) => value !== id)
    : [...list, id];
  void prefs.save();
  trayId.value = null;
}
function openContext(value: { id: string; x: number; y: number }) {
  contextMenu.value = {
    id: value.id,
    left: Math.max(8, Math.min(value.x, innerWidth - 210)),
    top: Math.max(8, Math.min(value.y, innerHeight - 300)),
  };
}
function rename(id: string) {
  const current = allItems.value.find((item) => item.id === id);
  const title = window.prompt("Session title", current?.title ?? "");
  if (title != null) emit("rename", id, title);
  contextMenu.value = null;
  trayId.value = null;
}
function moveToGroup(sessionId: string, groupId: string) {
  if (!isRealSession(sessionId)) return;
  for (const group of prefs.prefs.groups) {
    group.sessionIds = group.sessionIds.filter((id) => id !== sessionId);
  }
  const target = prefs.prefs.groups.find((group) => group.id === groupId);
  if (target) target.sessionIds.push(sessionId);
  void prefs.save();
  contextMenu.value = null;
}
function newGroup(sessionId: string) {
  if (!isRealSession(sessionId)) return;
  const name = window.prompt("New group name");
  if (!name) return;
  prefs.prefs.groups.push({
    id: crypto.randomUUID().replaceAll("-", "_"),
    name,
    sessionIds: [sessionId],
  });
  void prefs.save();
  contextMenu.value = null;
}
function toggleSection(section: SidebarSection) {
  if (section.automatic && section.cwd) {
    collapsedCwdIds.value = section.collapsed
      ? collapsedCwdIds.value.filter((cwd) => cwd !== section.cwd)
      : [...collapsedCwdIds.value, section.cwd];
    localStorage.setItem(
      "agent-webui:collapsed-cwds:v1",
      JSON.stringify(collapsedCwdIds.value),
    );
    return;
  }
  const group = prefs.prefs.groups.find((item) => item.id === section.id);
  if (group) {
    group.collapsed = !group.collapsed;
    void prefs.save();
  }
}
function pinGroup(groupId: string) {
  const ids = prefs.prefs.pinnedGroupIds;
  prefs.prefs.pinnedGroupIds = ids.includes(groupId)
    ? ids.filter((id) => id !== groupId)
    : [...ids, groupId];
  void prefs.save();
}
function renameGroup(groupId: string) {
  const group = prefs.prefs.groups.find((item) => item.id === groupId);
  if (!group) return;
  const name = window.prompt("Group name", group.name);
  if (name?.trim()) {
    group.name = name.trim();
    void prefs.save();
  }
}
function deleteGroup(groupId: string) {
  const group = prefs.prefs.groups.find((item) => item.id === groupId);
  if (!group || !confirm(`Delete group "${group.name}"? Sessions will remain.`)) return;
  prefs.prefs.groups = prefs.prefs.groups.filter((item) => item.id !== groupId);
  prefs.prefs.pinnedGroupIds = prefs.prefs.pinnedGroupIds.filter((id) => id !== groupId);
  void prefs.save();
}
function toggleSelected(id: string) {
  if (!isRealSession(id)) return;
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter((value) => value !== id)
    : [...selectedIds.value, id];
}
function startSelect(id: string) {
  multiMode.value = true;
  selectedIds.value = isRealSession(id) ? [id] : [];
  trayId.value = null;
  contextMenu.value = null;
}
function toggleMulti() {
  multiMode.value = !multiMode.value;
  selectedIds.value = [];
  trayId.value = null;
}
function deleteSelected() {
  if (selectedIds.value.length) emit("deleteMany", [...selectedIds.value]);
}
function toggleViewMode() {
  viewMode.value = viewMode.value === "grouped" ? "flat" : "grouped";
  localStorage.setItem("agent-webui:sidebar-view:v1", viewMode.value);
}
function clearSearch(keepOpen = true) {
  sessions.searchQuery = "";
  searchOpen.value = keepOpen;
  if (keepOpen) void nextTick(() => searchInput.value?.focus());
}
function openSearch() {
  searchOpen.value = true;
  void nextTick(() => searchInput.value?.focus());
}
function closeSearch() {
  clearSearch(false);
}
function onSearchKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeSearch();
    return;
  }
  if (event.key !== "Enter") return;
  const first = regularItems.value[0];
  const match = first ? sessions.contentMatches[first.id] : undefined;
  if (first) {
    emit(
      "select",
      first.id,
      match?.lastMatchUuid ?? undefined,
      match?.lastMatchIndex ?? undefined,
    );
  }
}
function selectItem(item: SidebarItem) {
  const match = sessions.contentMatches[item.id];
  emit(
    "select",
    item.id,
    match?.lastMatchUuid ?? undefined,
    match?.lastMatchIndex ?? undefined,
  );
  trayId.value = null;
}

watch([() => sessions.items.map((item) => item.id), () => sessions.loading], ([existing]) => {
  selectedIds.value = reconcileSelectedIds(selectedIds.value, existing as string[]);
  if (!selectedIds.value.length && multiMode.value && !sessions.loading) multiMode.value = false;
});

function pullStart(event: TouchEvent) {
  if (searchMode.value || pullRefreshing.value) return;
  const touch = event.touches[0];
  if (!touch) return;
  pullAtTop = (listEl.value?.scrollTop ?? 1) <= 0;
  pullStartX = touch.clientX;
  pullStartY = touch.clientY;
  pullDx = 0;
  pullDy = 0;
  pullAxis = null;
  pullDistance.value = 0;
}
function pullMove(event: TouchEvent) {
  if (!pullAtTop || pullRefreshing.value) return;
  const touch = event.touches[0];
  if (!touch) return;
  const dx = touch.clientX - pullStartX;
  const dy = touch.clientY - pullStartY;
  pullDx = dx;
  pullDy = dy;
  if (!pullAxis) pullAxis = lockGestureAxis(dx, dy);
  if (
    pullAxis === "y"
    && dy > 0
    && Math.abs(dy) >= 2 * Math.abs(dx)
    && (listEl.value?.scrollTop ?? 1) <= 0
  ) {
    event.preventDefault();
    pullDistance.value = Math.min(dy * 0.5, PULL_MAX);
  }
}
function resetPull() {
  pullDistance.value = pullRefreshing.value ? PULL_REFRESH_HOLD : 0;
  pullAtTop = false;
  pullAxis = null;
  pullDx = 0;
  pullDy = 0;
}
function pullEnd(event: TouchEvent) {
  if (!pullAtTop || pullRefreshing.value) {
    resetPull();
    return;
  }
  const touch = event.changedTouches[0];
  const dx = touch ? touch.clientX - pullStartX : pullDx;
  const dy = touch ? touch.clientY - pullStartY : pullDy;
  const shouldRefresh = dy >= PULL_THRESHOLD && Math.abs(dy) >= 2 * Math.abs(dx);
  if (!shouldRefresh) {
    resetPull();
    return;
  }
  pullRefreshing.value = true;
  pullDistance.value = PULL_REFRESH_HOLD;
  const started = performance.now();
  emit("refresh");
  window.setTimeout(() => {
    const remaining = Math.max(0, 350 - (performance.now() - started));
    window.setTimeout(() => {
      pullRefreshing.value = false;
      resetPull();
    }, remaining);
  }, 0);
}
</script>

<template>
  <aside class="cw-sidebar">
    <template v-if="searchMode">
      <header class="cw-sidebar-search-page-header">
        <button type="button" title="Back to chats" aria-label="Back to chats" @click="closeSearch">
          <ArrowLeft :size="21" />
        </button>
        <label class="cw-sidebar-search-box">
          <LoaderCircle v-if="searching" class="cw-spin" :size="17" />
          <Search v-else :size="17" />
          <input
            ref="searchInput"
            v-model="sessions.searchQuery"
            class="cw-sidebar-search-input"
            placeholder="Search all chats"
            autocomplete="off"
            spellcheck="false"
            @keydown="onSearchKeydown"
          />
          <button
            v-if="sessions.searchQuery"
            type="button"
            title="Clear search"
            aria-label="Clear search"
            @click="clearSearch()"
          ><X :size="15" /></button>
        </label>
      </header>
      <div class="cw-sidebar-search-summary">{{ searchSectionLabel }}</div>
    </template>
    <header v-else class="cw-sidebar-header">
      <div class="cw-sidebar-brand">
        <strong>{{ multiMode ? `${selectedIds.length} selected` : "Chats" }}</strong>
        <small v-if="!multiMode">{{ allItems.length }} total</small>
      </div>
      <div v-if="multiMode" class="cw-sidebar-header-actions">
        <button
          title="Delete selected"
          aria-label="Delete selected sessions"
          :disabled="!selectedIds.length"
          @click="deleteSelected"
        ><Trash2 :size="18" /></button>
        <button title="Cancel selection" aria-label="Cancel selection" @click="toggleMulti">
          <X :size="20" />
        </button>
      </div>
      <div v-else class="cw-sidebar-header-actions">
        <button title="Search every message" aria-label="Search every message" @click="openSearch">
          <Search :size="21" />
        </button>
        <button
          :title="viewMode === 'grouped' ? 'Use flat chat list' : 'Group chats by folder'"
          aria-label="Toggle flat and grouped chat list"
          @click="toggleViewMode"
        ><span class="cw-sidebar-view-glyph" aria-hidden="true">{{ viewMode === "grouped" ? "☷" : "☰" }}</span></button>
        <button title="New session" aria-label="New session" @click="emit('new')">
          <Plus :size="23" />
        </button>
        <button title="Settings" aria-label="Settings" @click="emit('settings')">
          <Settings :size="21" />
        </button>
      </div>
    </header>

    <div
      ref="listEl"
      class="cw-session-list cw-sidebar-scroller"
      @touchstart="pullStart"
      @touchmove="pullMove"
      @touchend="pullEnd"
      @touchcancel="resetPull"
    >
      <div
        v-if="!searchMode"
        class="cw-pull-refresh"
        :class="{ ready: pullDistance >= PULL_THRESHOLD, refreshing: pullRefreshing }"
        :style="{ height: `${pullDistance}px` }"
      >
        <LoaderCircle v-if="pullRefreshing" class="cw-spin" :size="14" />
        <span v-else>{{ pullDistance >= PULL_THRESHOLD ? "↑" : "↓" }}</span>
        <span>{{ pullRefreshing ? "刷新中…" : pullDistance >= PULL_THRESHOLD ? "松开刷新" : "下拉刷新" }}</span>
      </div>

      <div v-if="sessions.loading && !filtered.length && !searchMode" class="cw-empty">Refreshing…</div>

      <div v-if="pinnedItems.length" class="cw-section-label cw-section-summary">
        <span>★ Pinned ({{ pinnedItems.length }})</span>
        <span v-if="pinnedItems.some(item => isActive(item.id))" class="cw-section-running-dot" />
      </div>
      <SessionRow
        v-for="item in pinnedItems"
        :key="`pinned-${item.id}`"
        :session="item"
        :selected="item.id === sessions.selectedId"
        :unread-count="sessions.unreadCount(item)"
        :answering="isAnswering(item.id)"
        :compacting="isCompacting(item.id)"
        :failed="isFailed(item.id)"
        :open="trayId === item.id"
        :depth="depthFor(item)"
        :multi-select="multiMode"
        :checked="selectedIds.includes(item.id)"
        :task-count="taskCount(item.id)"
        pinned
        hide-cwd
        @select="selectItem(item)"
        @toggle="toggleSelected(item.id)"
        @tray="trayId = $event"
        @rename="rename(item.id)"
        @pin="pin(item.id)"
        @hide="hide(item.id)"
        @delete="emit('delete', item.id)"
        @context="openContext"
      />

      <div v-if="activeItems.length" class="cw-section-label cw-section-summary">
        <span>● Active ({{ activeItems.length }})</span>
        <span class="cw-section-running-dot" />
      </div>
      <SessionRow
        v-for="item in activeItems"
        :key="`active-${item.id}`"
        :session="item"
        :selected="item.id === sessions.selectedId"
        :unread-count="sessions.unreadCount(item)"
        :answering="isAnswering(item.id)"
        :compacting="isCompacting(item.id)"
        :failed="isFailed(item.id)"
        :open="trayId === item.id"
        :depth="depthFor(item)"
        :pinned="prefs.prefs.pinnedSessionIds.includes(item.id)"
        :hidden="prefs.prefs.hiddenSessionIds.includes(item.id)"
        :task-count="taskCount(item.id)"
        :multi-select="multiMode"
        :checked="selectedIds.includes(item.id)"
        hide-cwd
        @select="selectItem(item)"
        @toggle="toggleSelected(item.id)"
        @tray="trayId = $event"
        @rename="rename(item.id)"
        @pin="pin(item.id)"
        @hide="hide(item.id)"
        @delete="emit('delete', item.id)"
        @context="openContext"
      />

      <template v-for="section in groupSections" :key="section.id">
        <div
          v-if="section.name"
          class="cw-section-label cw-group-label"
          :class="{ 'cw-search-results-label': searchMode }"
        >
          <button
            v-if="!searchMode"
            class="cw-group-collapse"
            :aria-label="`${section.collapsed ? 'Expand' : 'Collapse'} ${section.name}`"
            @click="toggleSection(section)"
          >
            <ChevronRight v-if="section.collapsed" :size="12" />
            <ChevronDown v-else :size="12" />
          </button>
          <span class="cw-group-title">{{ section.name }}</span>
          <span v-if="sectionActive(section)" class="cw-section-running-dot" />
          <span v-if="sectionUnread(section)" class="cw-section-unread">{{ sectionUnread(section) }}</span>
          <button
            v-if="section.automatic && section.cwd"
            class="cw-group-new"
            title="New chat in this folder"
            aria-label="New chat in this folder"
            @click="emit('new', section.cwd)"
          ><Plus :size="13" /></button>
          <template v-else-if="!searchMode && section.id !== 'recent'">
            <button
              :title="section.pinned ? 'Unpin group' : 'Pin group'"
              @click="pinGroup(section.id)"
            ><Pin :size="12" /></button>
            <button title="Rename group" @click="renameGroup(section.id)"><Pencil :size="12" /></button>
            <button title="Delete group" @click="deleteGroup(section.id)"><Trash2 :size="12" /></button>
          </template>
        </div>
        <SessionRow
          v-for="item in (section.collapsed ? [] : section.items)"
          :key="item.id"
          :session="item"
          :selected="item.id === sessions.selectedId"
          :unread-count="sessions.unreadCount(item)"
          :answering="isAnswering(item.id)"
          :compacting="isCompacting(item.id)"
          :failed="isFailed(item.id)"
          :open="trayId === item.id"
          :depth="depthFor(item)"
          :pinned="prefs.prefs.pinnedSessionIds.includes(item.id)"
          :hidden="prefs.prefs.hiddenSessionIds.includes(item.id)"
          :task-count="taskCount(item.id)"
          :multi-select="multiMode"
          :checked="selectedIds.includes(item.id)"
          :hide-cwd="viewMode === 'grouped' && !searchMode"
          @select="selectItem(item)"
          @toggle="toggleSelected(item.id)"
          @tray="trayId = $event"
          @rename="rename(item.id)"
          @pin="pin(item.id)"
          @hide="hide(item.id)"
          @delete="emit('delete', item.id)"
          @context="openContext"
        />
      </template>

      <div v-if="!filtered.length && !sessions.loading && !searching" class="cw-empty">
        {{ searchMode ? "No matching conversations" : "No sessions" }}
      </div>
      <div v-if="!searchMode" class="cw-sidebar-utility-row">
        <button type="button" @click="emit('refresh')"><RefreshCw :size="14" /> Refresh</button>
        <button type="button" @click="toggleMulti">□ Select</button>
        <button type="button" @click="sessions.hiddenShown = !sessions.hiddenShown">
          <ArchiveRestore :size="14" />{{ sessions.hiddenShown ? "Chats" : `Hidden${hiddenCount ? ` (${hiddenCount})` : ""}` }}
        </button>
      </div>
    </div>

    <Teleport to="body">
      <template v-if="contextMenu">
        <button class="cw-popover-scrim" aria-label="Close context menu" @click="contextMenu = null" />
        <div
          class="cw-action-popover cw-session-context cw-context-menu"
          :style="{ left: `${contextMenu.left}px`, top: `${contextMenu.top}px` }"
        >
          <button class="cw-context-menu-item" @click="rename(contextMenu.id)">
            <Pencil :size="15" /> Rename
          </button>
          <button class="cw-context-menu-item" @click="pin(contextMenu.id); contextMenu = null">
            <Pin :size="15" /> Pin / unpin
          </button>
          <button class="cw-context-menu-item" @click="hide(contextMenu.id); contextMenu = null">
            <Archive :size="15" /> Hide / unhide
          </button>
          <button class="cw-context-menu-item" @click="startSelect(contextMenu.id)">□ Select</button>
          <button
            v-for="group in prefs.prefs.groups"
            :key="group.id"
            class="cw-context-menu-item"
            @click="moveToGroup(contextMenu.id, group.id)"
          >Move to {{ group.name }}</button>
          <button class="cw-context-menu-item" @click="moveToGroup(contextMenu.id, '')">
            Remove from group
          </button>
          <button class="cw-context-menu-item" @click="newGroup(contextMenu.id)">New group…</button>
          <button
            class="danger cw-context-menu-item"
            @click="emit('delete', contextMenu.id); contextMenu = null"
          ><Trash2 :size="15" /> Delete</button>
        </div>
      </template>
    </Teleport>
  </aside>
</template>
