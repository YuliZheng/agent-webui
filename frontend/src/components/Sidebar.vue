<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Archive, ArchiveRestore, CheckSquare, ChevronDown, ChevronRight, LoaderCircle, Menu, Pencil, Pin, Plus, RefreshCw, Search, Settings, Trash2, X } from "lucide-vue-next";
import SessionRow from "./SessionRow.vue";
import { useSessionsStore, useBackgroundTasksStore } from "@/stores/sessions";
import { usePreferencesStore } from "@/stores/preferences";
import { pendingSessions } from "@/persist/drafts";
import { mainSocket, WsError } from "@/api/ws";
import { lockGestureAxis, reconcileSelectedIds, shouldRefreshPull, sortPinnedByActivity } from "@/util/session-list";
const emit = defineEmits<{ select: [id: string, uuid?: string, index?: number]; new: []; settings: []; refresh: []; delete: [id: string]; deleteMany: [ids: string[]]; rename: [id: string, title: string] }>();
const sessions = useSessionsStore(); const prefs = usePreferencesStore(); const tasks = useBackgroundTasksStore();
const trayId = ref<string | null>(null);
const contextMenu = ref<{ id: string; left: number; top: number } | null>(null);
const searchOpen = ref(false);
const searchInput = ref<HTMLInputElement | null>(null);
const searching = ref(false);
const searchError = ref("");
let searchSequence = 0;
const headerMenuOpen = ref(false);
const multiMode = ref(false); const selectedIds = ref<string[]>([]);
const listEl = ref<HTMLElement | null>(null); const pullY = ref(0); let pullStartX = 0; let pullStartY = 0; let pullDx = 0; let pullDy = 0; let pullAtTop = false; let pullAxis: "x" | "y" | null = null;
const allItems = computed(() => [
  ...pendingSessions.items.map((item) => ({ id: item.id, cwd: item.cwd, agent: item.agent, mtime: new Date(item.createdAt).toISOString(), size: 0, title: item.title ?? "New session", preview: "Draft — not started", peer: false })),
  ...sessions.sorted
]);
const filtered = computed(() => allItems.value.filter((item) => {
  if (!prefs.prefs.showPeerSessions && item.peer) return false;
  const hidden = prefs.prefs.hiddenSessionIds.includes(item.id); if (hidden !== sessions.hiddenShown) return false;
  const q = sessions.searchQuery.trim().toLowerCase(); return !q || `${item.title ?? ""} ${item.cwd} ${item.preview ?? ""}`.toLowerCase().includes(q) || !!sessions.contentMatches[item.id];
}));
let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(() => sessions.searchQuery, (query) => {
  const sequence = ++searchSequence;
  const normalized = query.trim();
  clearTimeout(searchTimer);
  sessions.contentMatches = {};
  searching.value = false;
  searchError.value = "";
  // Supersede an already-running disk scan immediately, rather than letting
  // it compete with typing during the debounce interval.
  void mainSocket.request("search-content", { query: "" }, 5_000).catch(() => undefined);
  if (normalized.length < 2) {
    return;
  }
  searchTimer = setTimeout(async () => {
    if (sequence !== searchSequence) return;
    searching.value = true;
    try {
      const result = await mainSocket.request<{ matches: Array<{
        id: string;
        score: number;
        lastMatchUuid?: string | null;
        lastMatchIndex?: number | null;
      }> }>(
        "search-content",
        { query: normalized },
        120_000
      );
      if (sequence !== searchSequence) return;
      sessions.contentMatches = Object.fromEntries(result.matches.map((match) => [
        match.id,
        {
          score: match.score,
          lastMatchUuid: match.lastMatchUuid,
          lastMatchIndex: match.lastMatchIndex,
        }
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
const isAnswering = (id: string): boolean => Boolean(sessions.statuses[id]?.status === "running" || sessions.items.find((item) => item.id === id)?.status === "running");
const isActive = (id: string): boolean => Boolean(isAnswering(id) || sessions.statuses[id]?.compacting || tasks.bySession[id]?.some((task) => task.status === "running"));
const itemEffectiveTime = (item: (typeof allItems.value)[number]) => "createdAt" in item ? Number(item.createdAt) : sessions.items.some((session) => session.id === item.id) ? sessions.effectiveTime(item) : new Date(item.mtime).getTime();
const searchMode = computed(() => Boolean(sessions.searchQuery.trim()));
const pinnedItems = computed(() => searchMode.value ? [] : sortPinnedByActivity(filtered.value.filter((item) => prefs.prefs.pinnedSessionIds.includes(item.id)), isActive, itemEffectiveTime));
const activeItems = computed(() => searchMode.value ? [] : prefs.prefs.showActiveSection ? filtered.value.filter((item) => !prefs.prefs.pinnedSessionIds.includes(item.id) && isActive(item.id)) : []);
const regularItems = computed(() => {
  if (searchMode.value) return [...filtered.value].sort((a, b) =>
    (sessions.contentMatches[b.id]?.score ?? 0) - (sessions.contentMatches[a.id]?.score ?? 0)
    || itemEffectiveTime(b) - itemEffectiveTime(a)
  );
  return (prefs.prefs.showActiveSection ? filtered.value.filter((item) => !isActive(item.id)) : filtered.value)
    .filter((item) => !prefs.prefs.pinnedSessionIds.includes(item.id));
});
const searchSectionLabel = computed(() => {
  const length = sessions.searchQuery.trim().length;
  if (length < 2) return "Type at least 2 characters";
  if (searching.value) return "Searching every message…";
  if (searchError.value) return searchError.value;
  return `${regularItems.value.length} result${regularItems.value.length === 1 ? "" : "s"}`;
});
const groupSections = computed(() => {
  if (searchMode.value) return [{ id: "ungrouped", name: searchSectionLabel.value, items: regularItems.value, collapsed: false, pinned: false }];
  const orderedGroups = [...prefs.prefs.groups].sort((a, b) => {
    const ai = prefs.prefs.pinnedGroupIds.indexOf(a.id); const bi = prefs.prefs.pinnedGroupIds.indexOf(b.id); return (ai < 0 ? 1e9 : ai) - (bi < 0 ? 1e9 : bi);
  });
  const claimed = new Set(orderedGroups.flatMap((group) => group.sessionIds));
  const groups = orderedGroups.map((group) => ({ id: group.id, name: group.name, items: regularItems.value.filter((item) => group.sessionIds.includes(item.id)), collapsed: group.collapsed === true, pinned: prefs.prefs.pinnedGroupIds.includes(group.id) }));
  const ungrouped = { id: "ungrouped", name: activeItems.value.length ? "Recent" : "", items: regularItems.value.filter((item) => !claimed.has(item.id)), collapsed: false, pinned: false };
  return ungrouped.items.length ? [...groups, ungrouped] : groups;
});
function pin(id: string) { if (!isRealSession(id)) return; const list = prefs.prefs.pinnedSessionIds; prefs.prefs.pinnedSessionIds = list.includes(id) ? list.filter((x) => x !== id) : [id, ...list]; void prefs.save(); trayId.value = null; }
function hide(id: string) { if (!isRealSession(id)) return; const list = prefs.prefs.hiddenSessionIds; prefs.prefs.hiddenSessionIds = list.includes(id) ? list.filter((x) => x !== id) : [...list, id]; void prefs.save(); trayId.value = null; }
function openContext(value: { id: string; x: number; y: number }) { contextMenu.value = { id: value.id, left: Math.max(8, Math.min(value.x, innerWidth - 190)), top: Math.max(8, Math.min(value.y, innerHeight - 180)) }; }
function rename(id: string) { const current = allItems.value.find((item) => item.id === id); const title = window.prompt("Session title", current?.title ?? ""); if (title != null) emit("rename", id, title); contextMenu.value = null; trayId.value = null; }
function moveToGroup(sessionId: string, groupId: string) { if (!isRealSession(sessionId)) return; for (const group of prefs.prefs.groups) group.sessionIds = group.sessionIds.filter((id) => id !== sessionId); const target = prefs.prefs.groups.find((group) => group.id === groupId); if (target) target.sessionIds.push(sessionId); void prefs.save(); contextMenu.value = null; }
function newGroup(sessionId: string) { if (!isRealSession(sessionId)) return; const name = window.prompt("New group name"); if (!name) return; prefs.prefs.groups.push({ id: crypto.randomUUID().replaceAll("-", "_"), name, sessionIds: [sessionId] }); void prefs.save(); contextMenu.value = null; }
function toggleGroup(groupId: string) { const group = prefs.prefs.groups.find((item) => item.id === groupId); if (group) { group.collapsed = !group.collapsed; void prefs.save(); } }
function pinGroup(groupId: string) { const ids = prefs.prefs.pinnedGroupIds; prefs.prefs.pinnedGroupIds = ids.includes(groupId) ? ids.filter((id) => id !== groupId) : [...ids, groupId]; void prefs.save(); }
function renameGroup(groupId: string) { const group = prefs.prefs.groups.find((item) => item.id === groupId); if (!group) return; const name = window.prompt("Group name", group.name); if (name?.trim()) { group.name = name.trim(); void prefs.save(); } }
function deleteGroup(groupId: string) { const group = prefs.prefs.groups.find((item) => item.id === groupId); if (!group || !confirm(`Delete group "${group.name}"? Sessions will remain.`)) return; prefs.prefs.groups = prefs.prefs.groups.filter((item) => item.id !== groupId); prefs.prefs.pinnedGroupIds = prefs.prefs.pinnedGroupIds.filter((id) => id !== groupId); void prefs.save(); }
const isRealSession = (id: string) => sessions.items.some((item) => item.id === id);
function toggleSelected(id: string) { if (!isRealSession(id)) return; selectedIds.value = selectedIds.value.includes(id) ? selectedIds.value.filter((value) => value !== id) : [...selectedIds.value, id]; }
function toggleMulti() { multiMode.value = !multiMode.value; selectedIds.value = []; trayId.value = null; headerMenuOpen.value = false; }
function deleteSelected() { if (selectedIds.value.length) emit("deleteMany", [...selectedIds.value]); }
function clearSearch(keepOpen = true) {
  sessions.searchQuery = "";
  searchOpen.value = keepOpen;
  if (keepOpen) void nextTick(() => searchInput.value?.focus());
}
function toggleSearch() {
  headerMenuOpen.value = false;
  if (searchOpen.value || sessions.searchQuery) {
    clearSearch(false);
    return;
  }
  searchOpen.value = true;
  void nextTick(() => searchInput.value?.focus());
}
function onSearchKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    clearSearch(false);
    return;
  }
  if (event.key !== "Enter") return;
  const first = regularItems.value[0];
  const match = first ? sessions.contentMatches[first.id] : undefined;
  if (first) emit(
    "select",
    first.id,
    match?.lastMatchUuid ?? undefined,
    match?.lastMatchIndex ?? undefined,
  );
}
watch([() => sessions.items.map((item) => item.id), () => sessions.loading], ([existing]) => {
  selectedIds.value = reconcileSelectedIds(selectedIds.value, existing as string[]); if (!selectedIds.value.length && multiMode.value && !sessions.loading) multiMode.value = false;
});
function pullStart(event: TouchEvent) { const touch = event.touches[0]; if (!touch) return; pullAtTop = (listEl.value?.scrollTop ?? 1) <= 0; pullStartX = touch.clientX; pullStartY = touch.clientY; pullDx = 0; pullDy = 0; pullAxis = null; pullY.value = 0; }
function pullMove(event: TouchEvent) {
  if (!pullAtTop) return; const touch = event.touches[0]; if (!touch) return; const dx = touch.clientX - pullStartX; const dy = touch.clientY - pullStartY; pullDx = dx; pullDy = dy;
  if (!pullAxis) pullAxis = lockGestureAxis(dx, dy);
  if (pullAxis === "y" && dy > 0 && Math.abs(dy) >= 2 * Math.abs(dx) && (listEl.value?.scrollTop ?? 1) <= 0) { event.preventDefault(); pullY.value = Math.min(84, dy * .55); }
}
function resetPull() { pullY.value = 0; pullAtTop = false; pullAxis = null; pullDx = 0; pullDy = 0; }
function pullEnd(event: TouchEvent) { const touch = event.changedTouches[0]; const dx = touch ? touch.clientX - pullStartX : pullDx; const dy = touch ? touch.clientY - pullStartY : pullDy; if (shouldRefreshPull(pullAtTop, dx, dy)) emit("refresh"); resetPull(); }
</script>
<template>
  <aside class="cw-sidebar">
    <header class="cw-sidebar-header">
      <div class="cw-sidebar-brand">
        <strong>{{ multiMode ? `${selectedIds.length} selected` : 'Chats' }}</strong>
        <small v-if="!multiMode">{{ allItems.length }} total</small>
      </div>
      <div v-if="multiMode" class="cw-sidebar-header-actions">
        <button title="Delete selected" aria-label="Delete selected sessions" :disabled="!selectedIds.length" @click="deleteSelected"><Trash2 :size="18" /></button>
        <button title="Cancel selection" aria-label="Cancel selection" @click="toggleMulti"><X :size="20" /></button>
      </div>
      <div v-else class="cw-sidebar-header-actions">
        <button title="Search every message" aria-label="Search every message" :aria-pressed="searchOpen || Boolean(sessions.searchQuery)" :class="{ active: searchOpen || sessions.searchQuery }" @click="toggleSearch"><Search :size="21" /></button>
        <button title="Chat list menu" aria-label="Chat list menu" :class="{ active: headerMenuOpen }" @click="headerMenuOpen = !headerMenuOpen"><Menu :size="22" /></button>
        <button title="New session" aria-label="New session" @click="emit('new')"><Plus :size="23" /></button>
        <button title="Settings" aria-label="Settings" @click="emit('settings')"><Settings :size="21" /></button>
      </div>
    </header>
    <label v-if="searchOpen || sessions.searchQuery" class="cw-search cw-sidebar-search-header">
      <LoaderCircle v-if="searching" class="cw-spin" :size="16" />
      <Search v-else :size="16" />
      <input ref="searchInput" v-model="sessions.searchQuery" class="cw-sidebar-search-input" placeholder="Search every message" autocomplete="off" spellcheck="false" @keydown="onSearchKeydown" />
      <button v-if="sessions.searchQuery" type="button" title="Clear search" aria-label="Clear search" @click="clearSearch()"><X :size="15" /></button>
      <button v-else type="button" title="Close search" aria-label="Close search" @click="clearSearch(false)"><X :size="15" /></button>
    </label>
    <div v-if="headerMenuOpen" class="cw-sidebar-list-menu">
      <button @click="emit('refresh'); headerMenuOpen = false"><RefreshCw :size="16" /> Refresh chats</button>
      <button @click="toggleMulti"><CheckSquare :size="16" /> Select multiple</button>
      <button @click="sessions.hiddenShown = !sessions.hiddenShown; headerMenuOpen = false"><ArchiveRestore :size="16" />{{ sessions.hiddenShown ? 'Back to chats' : 'Hidden chats' }}</button>
    </div>
    <div ref="listEl" class="cw-session-list cw-sidebar-scroller" @touchstart="pullStart" @touchmove="pullMove" @touchend="pullEnd" @touchcancel="resetPull">
      <div class="cw-pull-refresh" :class="{ ready: pullY >= 35 }" :style="{ height: `${pullY}px` }"><RefreshCw :size="15" />{{ pullY >= 35 ? 'Release to refresh' : 'Pull to refresh' }}</div>
      <div v-if="sessions.loading && !filtered.length && !searchMode" class="cw-empty">Refreshing…</div>
      <div v-if="pinnedItems.length" class="cw-section-label">Pinned</div>
      <SessionRow v-for="item in pinnedItems" :key="`pinned-${item.id}`" :session="item" :selected="item.id === sessions.selectedId" :unread-count="sessions.unreadCount(item)" :answering="isAnswering(item.id)" :open="trayId === item.id" :multi-select="multiMode" :checked="selectedIds.includes(item.id)"
        pinned :hidden="prefs.prefs.hiddenSessionIds.includes(item.id)" :task-count="tasks.bySession[item.id]?.filter(t => t.status === 'running').length"
        @select="emit('select', item.id, sessions.contentMatches[item.id]?.lastMatchUuid ?? undefined, sessions.contentMatches[item.id]?.lastMatchIndex ?? undefined); trayId = null" @toggle="toggleSelected(item.id)" @tray="trayId = $event" @rename="rename(item.id)" @pin="pin(item.id)" @hide="hide(item.id)" @delete="emit('delete', item.id)" @context="openContext" />
      <div v-if="activeItems.length" class="cw-section-label">Active</div>
      <SessionRow v-for="item in activeItems" :key="`active-${item.id}`" :session="item" :selected="item.id === sessions.selectedId" :unread-count="sessions.unreadCount(item)" :answering="isAnswering(item.id)" :open="trayId === item.id"
        :pinned="prefs.prefs.pinnedSessionIds.includes(item.id)" :hidden="prefs.prefs.hiddenSessionIds.includes(item.id)" :task-count="tasks.bySession[item.id]?.filter(t => t.status === 'running').length" :multi-select="multiMode" :checked="selectedIds.includes(item.id)"
        @select="emit('select', item.id, sessions.contentMatches[item.id]?.lastMatchUuid ?? undefined, sessions.contentMatches[item.id]?.lastMatchIndex ?? undefined); trayId = null" @toggle="toggleSelected(item.id)" @tray="trayId = $event" @rename="rename(item.id)" @pin="pin(item.id)" @hide="hide(item.id)" @delete="emit('delete', item.id)" @context="openContext" />
      <template v-for="section in groupSections" :key="section.id"><div v-if="section.name" class="cw-section-label cw-group-label"><button v-if="section.id !== 'ungrouped'" @click="toggleGroup(section.id)"><ChevronRight v-if="section.collapsed" :size="12" /><ChevronDown v-else :size="12" /></button><span>{{ section.name }}</span><template v-if="section.id !== 'ungrouped'"><button :title="section.pinned ? 'Unpin group' : 'Pin group'" @click="pinGroup(section.id)"><Pin :size="12" /></button><button title="Rename group" @click="renameGroup(section.id)"><Pencil :size="12" /></button><button title="Delete group" @click="deleteGroup(section.id)"><Trash2 :size="12" /></button></template></div>
        <SessionRow v-for="item in (section.collapsed ? [] : section.items)" :key="item.id" :session="item" :selected="item.id === sessions.selectedId" :unread-count="sessions.unreadCount(item)" :answering="isAnswering(item.id)" :open="trayId === item.id"
          :pinned="prefs.prefs.pinnedSessionIds.includes(item.id)" :hidden="prefs.prefs.hiddenSessionIds.includes(item.id)" :task-count="tasks.bySession[item.id]?.filter(t => t.status === 'running').length" :multi-select="multiMode" :checked="selectedIds.includes(item.id)"
          @select="emit('select', item.id, sessions.contentMatches[item.id]?.lastMatchUuid ?? undefined, sessions.contentMatches[item.id]?.lastMatchIndex ?? undefined); trayId = null" @toggle="toggleSelected(item.id)" @tray="trayId = $event" @rename="rename(item.id)" @pin="pin(item.id)" @hide="hide(item.id)" @delete="emit('delete', item.id)" @context="openContext" />
      </template>
      <div v-if="!filtered.length && !sessions.loading && !searching" class="cw-empty">{{ searchMode ? 'No matching conversations' : 'No sessions' }}</div>
    </div>
    <Teleport to="body"><template v-if="contextMenu">
      <button class="cw-popover-scrim" aria-label="Close context menu" @click="contextMenu = null" />
      <div class="cw-action-popover cw-session-context cw-context-menu" :style="{ left: `${contextMenu.left}px`, top: `${contextMenu.top}px` }">
        <button class="cw-context-menu-item" @click="rename(contextMenu.id)"><Pencil :size="15" /> Rename</button>
        <button class="cw-context-menu-item" @click="pin(contextMenu.id); contextMenu = null"><Pin :size="15" /> Pin / unpin</button>
        <button class="cw-context-menu-item" @click="hide(contextMenu.id); contextMenu = null"><Archive :size="15" /> Hide / unhide</button>
        <button v-for="group in prefs.prefs.groups" :key="group.id" class="cw-context-menu-item" @click="moveToGroup(contextMenu.id, group.id)">Move to {{ group.name }}</button>
        <button class="cw-context-menu-item" @click="moveToGroup(contextMenu.id, '')">Remove from group</button>
        <button class="cw-context-menu-item" @click="newGroup(contextMenu.id)">New group…</button>
        <button class="danger cw-context-menu-item" @click="emit('delete', contextMenu.id); contextMenu = null"><Trash2 :size="15" /> Delete</button>
      </div>
    </template></Teleport>
  </aside>
</template>
