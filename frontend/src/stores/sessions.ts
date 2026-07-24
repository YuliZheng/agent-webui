import { computed, reactive, ref } from "vue";
import { defineStore } from "pinia";
import type { BackgroundTask, Interaction, ProcessStatus, SessionListItem, SessionSettings, SessionStatus } from "@/types";
import { mainSocket } from "@/api/ws";
import { pendingSessions } from "@/persist/drafts";
import { isSessionUnread } from "@/util/session-list";
import { readJson, writeJson } from "@/util/storage";

const UNREAD_COUNTS_KEY = "agent-webui:unread-counts:v1";

function storedUnreadCounts(): Record<string, number> {
  const stored = readJson<unknown>(UNREAD_COUNTS_KEY, {});
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
  return Object.fromEntries(Object.entries(stored).flatMap(([id, value]) =>
    Number.isSafeInteger(value) && Number(value) > 0 ? [[id, Math.min(999, Number(value))]] : []
  ));
}

export const useSessionsStore = defineStore("sessions", () => {
  const items = ref<SessionListItem[]>([]);
  const selectedId = ref<string | null>(null);
  const viewingSelected = ref(true);
  const loading = ref(false);
  const statuses = reactive<Record<string, SessionStatus>>({});
  const settings = reactive<Record<string, SessionSettings>>({});
  const readAt = reactive<Record<string, string>>({});
  const unreadCounts = reactive<Record<string, number>>(storedUnreadCounts());
  const draftEditedAt = reactive<Record<string, number>>({});
  const searchQuery = ref("");
  const contentMatches = ref<Record<string, {
    score: number;
    lastMatchUuid?: string | null;
    lastMatchIndex?: number | null;
  }>>({});
  const hiddenShown = ref(false);
  const readTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const selected = computed(() => items.value.find((item) => item.id === selectedId.value) ?? null);
  const effectiveTime = (item: SessionListItem) => Math.max(new Date(item.lastTurnAt ?? item.mtime).getTime(), draftEditedAt[item.id] ?? 0);
  const sorted = computed(() => [...items.value].sort((a, b) => effectiveTime(b) - effectiveTime(a)));

  async function refresh(): Promise<void> {
    loading.value = true;
    try {
      items.value = await mainSocket.request<SessionListItem[]>("get-sessions");
      for (const item of items.value) if (item.readAt) readAt[item.id] = item.readAt;
      const existing = new Set(items.value.map((item) => item.id));
      for (const id of Object.keys(unreadCounts)) if (!existing.has(id)) delete unreadCounts[id];
      for (const item of items.value) {
        if (!isUnread(item)) delete unreadCounts[item.id];
        else unreadCounts[item.id] ??= 1;
      }
      persistUnreadCounts();
    } finally { loading.value = false; syncBadge(); }
  }
  function upsert(item: SessionListItem): void {
    const index = items.value.findIndex((old) => old.id === item.id);
    if (index < 0) items.value = [...items.value, item]; else items.value[index] = { ...items.value[index]!, ...item };
    pendingSessions.reconcile(item.cwd, item.agent);
    syncBadge();
  }
  function touch(id: string, patch: Partial<SessionListItem> = {}): void {
    const item = items.value.find((candidate) => candidate.id === id); if (item) Object.assign(item, patch);
  }
  function setStatus(id: string, status: SessionStatus): void { statuses[id] = status; touch(id, { status: status.status }); }
  function clearTransientStatuses(): void {
    for (const id of Object.keys(statuses)) {
      statuses[id] = { status: null, webuiAlive: false, compacting: false };
    }
    for (const item of items.value) if (item.status === "running") item.status = null;
  }
  function persistUnreadCounts(): void { writeJson(UNREAD_COUNTS_KEY, { ...unreadCounts }); }
  function clearUnreadCount(id: string): void {
    if (!(id in unreadCounts)) return;
    delete unreadCounts[id];
    persistUnreadCounts();
  }
  async function markRead(id: string): Promise<void> {
    const at = new Date().toISOString(); readAt[id] = at; clearUnreadCount(id); syncBadge(); await mainSocket.request("mark-read", { sessionId: id, at }).catch(() => undefined);
  }
  function observeCurrent(id: string, at = new Date().toISOString()): void {
    if (selectedId.value !== id || !viewingSelected.value) return;
    readAt[id] = at; clearUnreadCount(id); syncBadge(); clearTimeout(readTimers.get(id));
    readTimers.set(id, setTimeout(() => {
      readTimers.delete(id);
      try {
        void Promise.resolve(mainSocket.request("mark-read", { sessionId: id, at: readAt[id] })).catch(() => undefined);
      } catch {
        // A socket replacement can race this debounced watermark update.
      }
    }, 500));
  }
  function handoffSelection(nextId: string | null): void {
    const previous = selectedId.value;
    if (previous && previous !== nextId) observeCurrent(previous);
    selectedId.value = nextId;
  }
  function isUnread(item: SessionListItem): boolean {
    return isSessionUnread(item, readAt[item.id], viewingSelected.value ? selectedId.value : null, effectiveTime(item));
  }
  function unreadCount(item: SessionListItem): number {
    return isUnread(item) ? Math.max(1, unreadCounts[item.id] ?? 0) : 0;
  }
  function noteCompletion(id: string, at = new Date().toISOString()): void {
    touch(id, { lastTurnAt: at });
    if (selectedId.value === id && viewingSelected.value) {
      observeCurrent(id);
      return;
    }
    unreadCounts[id] = Math.min(999, (unreadCounts[id] ?? 0) + 1);
    persistUnreadCounts();
    syncBadge();
  }
  function applyRead(id: string, at: string): void {
    readAt[id] = at;
    clearUnreadCount(id);
    syncBadge();
  }
  function setViewingSelected(value: boolean): void { viewingSelected.value = value; if (value && selectedId.value) observeCurrent(selectedId.value); }
  function syncBadge(): void {
    const count = items.value.reduce((total, item) => total + unreadCount(item), 0);
    const badges = navigator as Navigator & { setAppBadge?: (count?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    void (count ? badges.setAppBadge?.(count) : badges.clearAppBadge?.())?.catch(() => undefined);
  }
  return { items, selectedId, selected, viewingSelected, loading, statuses, settings, readAt, unreadCounts, searchQuery, contentMatches, hiddenShown, sorted, effectiveTime, refresh, upsert, touch, setStatus, clearTransientStatuses, markRead, observeCurrent, handoffSelection, isUnread, unreadCount, noteCompletion, applyRead, setViewingSelected, syncBadge, draftEditedAt };
});

export const useInteractionsStore = defineStore("interactions", () => {
  const items = ref<Interaction[]>([]);
  function add(item: Interaction): void { items.value = [...items.value.filter((old) => old.sessionId !== item.sessionId || old.requestId !== item.requestId), item]; }
  function remove(sessionId: string, requestId: string): void { items.value = items.value.filter((item) => item.sessionId !== sessionId || item.requestId !== requestId); }
  async function respond(item: Interaction, answer: unknown): Promise<void> {
    remove(item.sessionId, item.requestId);
    try { await mainSocket.request("interaction-respond", { sessionId: item.sessionId, requestId: item.requestId, answer }); }
    catch (error) { add(item); throw error; }
  }
  return { items, add, remove, respond };
});

export const useBackgroundTasksStore = defineStore("background-tasks", () => {
  const bySession = reactive<Record<string, BackgroundTask[]>>({});
  function set(sessionId: string, tasks: BackgroundTask[]): void { bySession[sessionId] = tasks; }
  return { bySession, set };
});
