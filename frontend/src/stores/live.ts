import { computed, reactive, ref, watch } from "vue";
import { defineStore } from "pinia";
import type { IndexedRawLine, Interaction, PushEvent, SessionListItem } from "@/types";
import { mainSocket } from "@/api/ws";
import { sessionCaches } from "@/persist/session-cache";
import { normalizeLines } from "@/parser";
import { useBackgroundTasksStore, useInteractionsStore, useSessionsStore } from "./sessions";
import { useComposerStore } from "./composer";
import { useUiStore } from "./ui";
import { readJson, writeJson } from "@/util/storage";
import { clearInteractionAnswerClaim } from "@/util/interactions";

export const INITIAL_SESSION_TAIL_LINES = 200;
export const EARLIER_SESSION_PAGE_LINES = 200;
// Prefetch is intentionally conservative and is not run at app startup. A cold
// tail needs an exact physical-line count, so parallel prefetch of several
// large JSONL files can saturate a Windows disk (and its antivirus scanner)
// even though the resulting browser caches are immediately released.
export const PREFETCH_MAX_SESSION_BYTES = 4 * 1024 * 1024;
export const PREFETCH_SESSION_LIMIT = 2;

export const useLiveStore = defineStore("live", () => {
  const linesBySession = reactive<Record<string, IndexedRawLine[]>>({});
  const restoring = reactive<Record<string, boolean>>({});
  const loadingEarlier = reactive<Record<string, boolean>>({});
  const connected = ref(false);
  const subscribed = new Set<string>();
  let openSequence = 0;
  let handingOffInsideOpen = false;
  let installed = false;
  let notifSeq = readJson<number>("agent-webui:notif-seq:v1", 0);
  const sessions = useSessionsStore();
  const interactions = useInteractionsStore();
  const tasks = useBackgroundTasksStore();
  const composer = useComposerStore();
  const ui = useUiStore();

  watch(
    () => sessions.selectedId,
    nextId => {
      if (handingOffInsideOpen) return;
      for (const sessionId of [...subscribed]) {
        if (sessionId !== nextId) void releaseTranscript(sessionId);
      }
    },
    { flush: "sync" },
  );

  function install(): void {
    if (installed) return; installed = true;
    mainSocket.addEventListener("push", ((event: CustomEvent<PushEvent>) => onPush(event.detail)) as EventListener);
    mainSocket.addEventListener("connection", ((event: CustomEvent<{ connected: boolean }>) => {
      connected.value = event.detail.connected;
      if (!connected.value) sessions.clearTransientStatuses();
    }) as EventListener);
    mainSocket.subscribe({ channel: "global", notifSinceSeq: notifSeq });
    mainSocket.connect();
  }

  async function open(sessionId: string): Promise<void> {
    const sequence = ++openSequence;
    const previousId = sessions.selectedId;
    handingOffInsideOpen = true;
    try {
      sessions.handoffSelection(sessionId);
    } finally {
      handingOffInsideOpen = false;
    }
    restoring[sessionId] = true;
    if (previousId && previousId !== sessionId) await releaseTranscript(previousId);
    for (const staleId of [...subscribed]) {
      if (staleId !== sessionId) await releaseTranscript(staleId);
    }
    if (sequence !== openSequence || sessions.selectedId !== sessionId) {
      if (sessions.selectedId !== sessionId) delete restoring[sessionId];
      return;
    }
    const cache = sessionCaches.get(sessionId);
    if (!cache.restored) await cache.restore();
    if (sequence !== openSequence || sessions.selectedId !== sessionId) {
      if (sessions.selectedId !== sessionId) {
        delete restoring[sessionId];
        await releaseTranscript(sessionId);
      }
      return;
    }
    linesBySession[sessionId] = [...cache.lines];
    restoring[sessionId] = false;
    if (!subscribed.has(sessionId)) {
      mainSocket.subscribe({
        channel: "session",
        sessionId,
        from: cache.nextLineIndex,
        ...(cache.lines.length ? {} : { tailN: INITIAL_SESSION_TAIL_LINES })
      });
      subscribed.add(sessionId);
    } else mainSocket.updateSessionFrom(sessionId, cache.nextLineIndex);
    void sessions.markRead(sessionId);
  }

  function close(sessionId: string): void {
    if (!subscribed.has(sessionId)) return;
    mainSocket.unsubscribe({ channel: "session", sessionId }); subscribed.delete(sessionId);
  }

  async function releaseTranscript(sessionId: string): Promise<void> {
    close(sessionId);
    delete linesBySession[sessionId];
    delete restoring[sessionId];
    delete loadingEarlier[sessionId];
    await sessionCaches.release(sessionId);
  }

  async function reload(sessionId: string): Promise<void> {
    const selected = sessions.selectedId === sessionId;
    close(sessionId);
    const cache = sessionCaches.get(sessionId);
    await cache.truncate(0);
    if (!selected || sessions.selectedId !== sessionId) return;
    linesBySession[sessionId] = [];
    mainSocket.subscribe({ channel: "session", sessionId, from: 0, tailN: INITIAL_SESSION_TAIL_LINES });
    subscribed.add(sessionId);
  }

  function blocks(sessionId: string) {
    const session = sessions.items.find((item) => item.id === sessionId);
    return normalizeLines(session?.agent ?? "claude", linesBySession[sessionId] ?? []);
  }

  async function loadEarlier(sessionId: string, count = EARLIER_SESSION_PAGE_LINES): Promise<void> {
    if (loadingEarlier[sessionId]) return;
    const current = linesBySession[sessionId] ?? [];
    const first = current[0]?.index ?? 0;
    if (first <= 0) return;
    loadingEarlier[sessionId] = true;
    try {
      const from = Math.max(0, first - count);
      const data = await mainSocket.request<IndexedRawLine[]>("read-range", { sessionId, from, to: first });
      if (!subscribed.has(sessionId) || sessions.selectedId !== sessionId) return;
      const cache = sessionCaches.get(sessionId); cache.merge(data, "backfill"); linesBySession[sessionId] = [...cache.lines];
    } finally {
      if (subscribed.has(sessionId) && sessions.selectedId === sessionId) loadingEarlier[sessionId] = false;
      else delete loadingEarlier[sessionId];
    }
  }

  /**
   * Load only a bounded neighborhood around a global-search hit. This keeps
   * old-session navigation useful without reading the whole JSONL into the
   * browser or disturbing the forward subscription at the file tail.
   */
  async function loadAround(sessionId: string, index: number, radius = 120): Promise<void> {
    if (!Number.isSafeInteger(index) || index < 0) return;
    const data = await mainSocket.request<IndexedRawLine[]>("read-range", {
      sessionId,
      from: Math.max(0, index - radius),
      to: index + radius + 1,
    });
    if (!subscribed.has(sessionId) || sessions.selectedId !== sessionId) return;
    const cache = sessionCaches.get(sessionId);
    // A search jump should not make every previously visited neighborhood
    // permanently resident. Preserve the live tail (which also preserves the
    // subscription's nextLineIndex), replace older backfill with this one
    // bounded window, and let normal upward pagination rebuild older context
    // only when the user asks for it.
    const tail = cache.lines.slice(-INITIAL_SESSION_TAIL_LINES);
    cache.replace([...data, ...tail]);
    linesBySession[sessionId] = [...cache.lines];
  }

  async function prefetch(items: SessionListItem[], n = 200): Promise<void> {
    // Keep this helper for an explicit future "cache for offline" action, but
    // serialize its I/O. The normal open flow remains selected-session-only.
    for (const item of items.filter(item => item.size <= PREFETCH_MAX_SESSION_BYTES).slice(0, PREFETCH_SESSION_LIMIT)) {
      try {
        const lines = await mainSocket.request<IndexedRawLine[]>("read-tail", { sessionId: item.id, n });
        if (sessions.selectedId === item.id) continue;
        const cache = sessionCaches.get(item.id);
        cache.merge(lines, "forward");
        // Prefetch warms only IndexedDB. Non-selected transcripts must not
        // remain resident after their short request completes.
        if (sessions.selectedId !== item.id) await sessionCaches.release(item.id);
      } catch {
        // Opportunistic prefetch must never disturb the active transcript.
      }
    }
  }

  function onPush(event: PushEvent): void {
    const kind = String(event.kind ?? event.type ?? "");
    if ((kind === "notif-baseline" || kind === "notification") && typeof event.seq === "number" && event.seq > notifSeq) {
      notifSeq = event.seq; writeJson("agent-webui:notif-seq:v1", notifSeq); mainSocket.updateGlobalNotifSinceSeq(notifSeq);
    }
    const sessionId = typeof event.sessionId === "string" ? event.sessionId : typeof event.id === "string" ? event.id : "";
    if (kind === "stream-line" && sessionId && subscribed.has(sessionId)) mergeStream(sessionId, [toLine(event)]);
    else if (kind === "stream-batch" && sessionId && subscribed.has(sessionId) && Array.isArray(event.lines)) mergeStream(sessionId, event.lines.map((line) => toLine(line as Record<string, unknown>)));
    else if (kind === "stream-truncate" && sessionId && subscribed.has(sessionId)) void truncate(sessionId, Number(event.keepCount ?? 0));
    else if (kind === "stream-reset" && sessionId && subscribed.has(sessionId)) void truncate(sessionId, 0);
    else if (kind === "session-added" && event.session && typeof event.session === "object") sessions.upsert(event.session as SessionListItem);
    else if (kind === "session-touched" && sessionId) {
      // The backend includes the updated lightweight list fields. Re-fetching
      // all sessions for every streamed append made an active transcript turn
      // into a continuous O(session-count) RPC/render loop.
      sessions.touch(sessionId, event.session as Partial<SessionListItem> ?? {});
    }
    else if (kind === "session-renamed" && sessionId) sessions.touch(sessionId, { title: String(event.title ?? "") });
    else if (kind === "session-status" && sessionId) sessions.setStatus(sessionId, { status: (event.status as any) ?? null, webuiAlive: event.webuiAlive === true, compacting: event.compacting === true });
    else if (kind === "session-settings" && sessionId) sessions.settings[sessionId] = {
      model: String(event.model ?? ""),
      effort: String(event.effort ?? ""),
      permissionMode: String(event.permissionMode ?? ""),
      sandboxMode: String(event.sandboxMode ?? "")
    };
    else if (kind === "session-read" && sessionId) sessions.applyRead(sessionId, String(event.at ?? new Date().toISOString()));
    else if (kind === "codex-steers-settled" && sessionId && Array.isArray(event.clientUuids)) {
      composer.settleCodexSteers(sessionId, event.clientUuids.filter((id): id is string => typeof id === "string"));
    }
    else if (kind === "interaction-added" && event.interaction) {
      const item = event.interaction as Interaction; interactions.add(item);
      if (sessions.selectedId !== item.sessionId) ui.showInteractionToast(item);
    }
    else if (kind === "interaction-removed" && sessionId && typeof event.requestId === "string") {
      const requestId = event.requestId;
      interactions.remove(sessionId, requestId);
      ui.dismissInteractionToast(sessionId, requestId);
      clearInteractionAnswerClaim(sessionId, requestId);
    }
    else if (kind === "background-tasks" && sessionId) tasks.set(sessionId, Array.isArray(event.tasks) ? event.tasks as any[] : []);
    else if (kind === "notification") notify(event);
  }

  function mergeStream(sessionId: string, lines: IndexedRawLine[]): void {
    const valid = lines.filter((line) => Number.isInteger(line.index) && typeof line.raw === "string"); if (!valid.length) return;
    const cache = sessionCaches.get(sessionId); cache.merge(valid, "forward"); linesBySession[sessionId] = [...cache.lines];
    mainSocket.updateSessionFrom(sessionId, cache.nextLineIndex);
    sessions.observeCurrent(sessionId);
    const session = sessions.items.find((item) => item.id === sessionId);
    if (session) {
      const latestUsers = normalizeLines(session.agent, valid).filter((block) => block.kind === "user");
      for (const block of latestUsers) composer.reconcile(sessionId, block.text ?? "", block.index);
    }
  }

  async function truncate(sessionId: string, keepCount: number): Promise<void> {
    const cache = sessionCaches.get(sessionId);
    await cache.truncate(keepCount);
    if (!subscribed.has(sessionId) || sessions.selectedId !== sessionId) return;
    linesBySession[sessionId] = [...cache.lines];
    mainSocket.updateSessionFrom(sessionId, cache.nextLineIndex);
  }

  function notify(event: PushEvent): void {
    const title = String(event.title ?? "Agent finished"); const body = String(event.body ?? "");
    const id = typeof event.id === "string" ? event.id : "";
    ui.toast(`${title}${body ? `: ${body}` : ""}`, "info", id ? { sessionId: id } : {});
    if (id) sessions.noteCompletion(id, typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString());
    if ("Notification" in window && Notification.permission === "granted" && document.visibilityState !== "visible") new Notification(title, { body, tag: String(event.id ?? event.uuid ?? "agent") });
  }

  return { linesBySession, restoring, loadingEarlier, connected, selectedBlocks: computed(() => sessions.selectedId ? blocks(sessions.selectedId) : []), install, open, close, reload, blocks, loadEarlier, loadAround, prefetch, onPush };
});

function toLine(value: Record<string, unknown>): IndexedRawLine {
  const data = value.data;
  return { index: Number(value.index), raw: typeof value.raw === "string" ? value.raw : typeof data === "string" ? data : JSON.stringify(data) };
}
