<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Sidebar from "@/components/Sidebar.vue";
import SessionHeader from "@/components/SessionHeader.vue";
import TranscriptPane from "@/components/TranscriptPane.vue";
import ComposerBar from "@/components/ComposerBar.vue";
import InteractionTray from "@/components/InteractionTray.vue";
import NewSessionDialog from "@/components/NewSessionDialog.vue";
import SettingsDialog from "@/components/SettingsDialog.vue";
import OverlayHost from "@/components/OverlayHost.vue";
import { useBackgroundTasksStore, useInteractionsStore, useSessionsStore } from "@/stores/sessions";
import { usePreferencesStore } from "@/stores/preferences";
import { useLiveStore } from "@/stores/live";
import { attachmentPayloads, useComposerStore } from "@/stores/composer";
import { useUiStore } from "@/stores/ui";
import { useIdentityStore } from "@/stores/identity";
import { mainSocket, installWakeHandlers } from "@/api/ws";
import { installCacheFlushHandlers } from "@/persist/session-cache";
import { drafts, pendingSessions } from "@/persist/drafts";
import { parseLocalSlashCommand } from "@/util/slash-commands";
import { exportUrl } from "@/api/http";
import { reconstructTodos } from "@/parser";
import type { AgentKind, PendingPromptChip, SessionListItem } from "@/types";
import { parseCodexGoalFields } from "@/util/codex-goal";
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY,
  clampSidebarWidth,
  storedSidebarWidth,
} from "@/util/session-appearance";

const sessions = useSessionsStore(); const prefs = usePreferencesStore(); const live = useLiveStore(); const composer = useComposerStore(); const ui = useUiStore();
const background = useBackgroundTasksStore();
const interactions = useInteractionsStore();
const identity = useIdentityStore();
const appShellClass = computed(() => `cw-app-shell cw-shell-${prefs.messageDisplayStyle}`);
const sidebarWidth = ref(SIDEBAR_DEFAULT_WIDTH);
const sidebarResizing = ref(false);
const appShellStyle = computed(() => ({ "--cw-sidebar-width": `${sidebarWidth.value}px` }));
let sidebarResizePointer: number | null = null;
let sidebarResizeStartX = 0;
let sidebarResizeStartWidth = 0;
let sidebarResizeHandle: HTMLElement | null = null;
let lastStyleClass = "";
function syncThemeColor() {
  if (typeof document === "undefined") return;
  requestAnimationFrame(() => {
    const color = getComputedStyle(document.documentElement).getPropertyValue("--cw-shell-bg").trim();
    if (!color) return;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      document.head.append(meta);
    }
    meta.content = color;
  });
}
watch(
  () => prefs.messageDisplayStyle,
  (style) => {
    if (typeof document === "undefined") return;
    if (lastStyleClass) document.documentElement.classList.remove(lastStyleClass);
    lastStyleClass = `cw-style-${style}`;
    document.documentElement.classList.add(lastStyleClass);
    document.documentElement.dataset.messageDisplayStyle = style;
    syncThemeColor();
  },
  { immediate: true },
);
const showNew = ref(false); const newSessionCwd = ref(""); const showSettings = ref(false); const showTodos = ref(false); const pendingSelected = ref<string | null>(null); const pendingSending = ref(false);
const recentCwds = computed(() => [...new Set(sessions.sorted.map((item) => item.cwd).filter(Boolean))].slice(0, 8));
const pending = computed(() => pendingSessions.items.find((item) => item.id === pendingSelected.value));
const session = computed<SessionListItem | null>(() => sessions.selected ?? (pending.value ? { id: pending.value.id, cwd: pending.value.cwd, agent: pending.value.agent, mtime: new Date(pending.value.createdAt).toISOString(), size: 0, title: "New session" } : null));
const blocks = computed(() => sessions.selectedId ? live.blocks(sessions.selectedId) : []);
const sourceLines = computed(() => sessions.selectedId ? live.linesBySession[sessions.selectedId] ?? [] : []);
const firstSourceIndex = computed(() => sourceLines.value[0]?.index ?? 0);
const nextSourceIndex = computed(() => sourceLines.value.length ? Math.max(...sourceLines.value.map(line => line.index)) + 1 : 0);
const todos = computed(() => reconstructTodos(blocks.value));
const inlineToolUseIds = computed(() => blocks.value.flatMap((block) => [block, ...(block.children ?? [])]).map((block) => block.toolUseId).filter((id): id is string => !!id));
let removeWake: (() => void) | undefined; let removeFlush: (() => void) | undefined;
const updateViewing = () => sessions.setViewingSelected(document.visibilityState === "visible" && !ui.mobileListVisible);

onMounted(async () => {
  sidebarWidth.value = storedSidebarWidth(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY), window.innerWidth);
  live.install();
  removeWake = installWakeHandlers(mainSocket, () => { void live.prefetch(sessions.sorted); });
  removeFlush = installCacheFlushHandlers();
  document.addEventListener("visibilitychange", updateViewing); updateViewing();
  await Promise.allSettled([sessions.refresh(), prefs.load(), identity.load()]);
  void live.prefetch(sessions.sorted);
  const deepLink = new URL(location.href).searchParams.get("session");
  const first = sessions.items.find((item) => item.id === deepLink)?.id ?? sessions.sorted[0]?.id;
  if (first) await select(first);
});
onBeforeUnmount(() => {
  endSidebarResize();
  removeWake?.(); removeFlush?.(); document.removeEventListener("visibilitychange", updateViewing);
});
watch(() => ui.openSessionRequest, (request) => { if (request) void select(request.sessionId); });
watch([() => sessions.selectedId, () => interactions.items.map((item) => `${item.sessionId}:${item.requestId}`).join("|")], () => {
  // Keep an actionable global card even for the selected session: its matching
  // tool row may be outside the rendered window or simply off-screen.
  ui.syncInteractionToasts(interactions.items);
}, { immediate: true });
watch(() => session.value?.id, () => { showTodos.value = false; });
watch(() => ui.mobileListVisible, updateViewing);

function beginSidebarResize(event: PointerEvent) {
  if (event.button !== 0 || sidebarResizePointer != null) return;
  event.preventDefault();
  sidebarResizePointer = event.pointerId;
  sidebarResizeStartX = event.clientX;
  sidebarResizeStartWidth = sidebarWidth.value;
  sidebarResizeHandle = event.currentTarget as HTMLElement;
  sidebarResizeHandle.setPointerCapture?.(event.pointerId);
  sidebarResizing.value = true;
  window.addEventListener("pointermove", resizeSidebar);
  window.addEventListener("pointerup", endSidebarResize);
  window.addEventListener("pointercancel", endSidebarResize);
}
function resizeSidebar(event: PointerEvent) {
  if (event.pointerId !== sidebarResizePointer) return;
  sidebarWidth.value = clampSidebarWidth(sidebarResizeStartWidth + event.clientX - sidebarResizeStartX);
}
function endSidebarResize(event?: PointerEvent) {
  if (event && sidebarResizePointer != null && event.pointerId !== sidebarResizePointer) return;
  if (sidebarResizePointer != null && sidebarResizeHandle?.hasPointerCapture?.(sidebarResizePointer)) sidebarResizeHandle.releasePointerCapture(sidebarResizePointer);
  if (sidebarResizePointer != null) localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth.value));
  sidebarResizePointer = null;
  sidebarResizeHandle = null;
  sidebarResizing.value = false;
  window.removeEventListener("pointermove", resizeSidebar);
  window.removeEventListener("pointerup", endSidebarResize);
  window.removeEventListener("pointercancel", endSidebarResize);
}
function resizeSidebarWithKeyboard(event: KeyboardEvent) {
  const deltas: Record<string, number> = { ArrowLeft: -16, ArrowRight: 16 };
  if (!(event.key in deltas) && event.key !== "Home" && event.key !== "End") return;
  event.preventDefault();
  if (event.key === "Home") sidebarWidth.value = SIDEBAR_MIN_WIDTH;
  else if (event.key === "End") sidebarWidth.value = SIDEBAR_MAX_WIDTH;
  else sidebarWidth.value = clampSidebarWidth(sidebarWidth.value + deltas[event.key]!);
  localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth.value));
}

async function select(id: string, targetUuid?: string, targetIndex?: number) {
  if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission().catch(() => undefined);
  ui.mobileListVisible = false;
  if (pendingSessions.items.some((item) => item.id === id)) {
    sessions.handoffSelection(null); pendingSelected.value = id; composer.ensure(id); return;
  }
  pendingSelected.value = null;
  try {
    await live.open(id);
    if (Number.isSafeInteger(targetIndex) && (targetIndex ?? -1) >= 0) {
      try {
        await live.loadAround(id, targetIndex!);
      } catch (error) {
        ui.toast(error instanceof Error ? error.message : "Could not load the matching message", "error");
      }
    }
    ui.searchTarget = targetUuid || Number.isSafeInteger(targetIndex)
      ? { sessionId: id, uuid: targetUuid, index: targetIndex }
      : null;
    const url = new URL(location.href); url.searchParams.set("session", id); history.replaceState(null, "", url);
  } catch (error) { ui.toast(error instanceof Error ? error.message : "Could not open session", "error"); }
}
async function create(data: { cwd: string; agent: AgentKind; prompt: string }) {
  const normalized = await mainSocket.request<{ cwd: string }>("normalize-cwd", { cwd: data.cwd });
  showNew.value = false;
  if (!data.prompt.trim()) { const item = pendingSessions.create(normalized.cwd, data.agent); await select(item.id); return; }
  const result = await mainSocket.request<{ sessionId?: string; id?: string }>("new-session", { ...data, cwd: normalized.cwd }, 60_000);
  await sessions.refresh(); const id = result.sessionId ?? result.id ?? sessions.items.find((item) => item.cwd === normalized.cwd && item.agent === data.agent)?.id; if (id) await select(id);
}
function openNew(cwd?: string) {
  newSessionCwd.value = cwd ?? session.value?.cwd ?? "";
  showNew.value = true;
}
async function sendPending(text: string) {
  if (pendingSending.value || !pending.value || (!text.trim() && !(composer.attachments[pending.value.id]?.length))) return;
  pendingSending.value = true;
  const item = pending.value;
  const fileSnapshot = [...(composer.attachments[item.id] ?? [])];
  try {
    const images = await attachmentPayloads(fileSnapshot);
    const result = await mainSocket.request<{ sessionId?: string; id?: string }>("new-session", { cwd: item.cwd, agent: item.agent, prompt: text, images }, 60_000);
    if (drafts.clearIfMatches(item.id, text) && composer.textBySession[item.id] === text) composer.textBySession[item.id] = "";
    composer.clearAttachmentsIfMatches(item.id, fileSnapshot); pendingSessions.remove(item.id); pendingSelected.value = null;
    await sessions.refresh(); const id = result.sessionId ?? result.id ?? sessions.items.find((session) => session.cwd === item.cwd && session.agent === item.agent)?.id; if (id) await select(id);
  } catch (error) { ui.toast(error instanceof Error ? error.message : "Could not start session", "error"); }
  finally { pendingSending.value = false; }
}
async function loadEarlierSession(id: string) {
  try { await live.loadEarlier(id); }
  catch (error) { ui.toast(error instanceof Error ? error.message : "Could not load earlier messages", "error"); }
}
async function compactSelectedSession() {
  if (!session.value || pending.value) return;
  try {
    await mainSocket.request("compact-session", { sessionId: session.value.id }, 60_000);
  } catch (error) {
    ui.toast(error instanceof Error ? error.message : "Could not compact the session", "error");
  }
}
async function startNewChatInCurrentDirectory() {
  if (!session.value) return;
  const item = pendingSessions.create(session.value.cwd, session.value.agent);
  await select(item.id);
}
async function handleFork(data: { newSessionId: string; prefillText: string }) {
  if (!session.value || !data.newSessionId) return;
  try {
    let found = false;
    for (const waitMs of [0, 80, 160, 320] as const) {
      if (waitMs) await new Promise<void>(resolve => setTimeout(resolve, waitMs));
      await sessions.refresh();
      if (sessions.items.some((item) => item.id === data.newSessionId)) {
        found = true;
        break;
      }
    }
    if (!found) throw new Error(`Fork ${data.newSessionId} was created, but its rollout is not discoverable yet`);
    composer.ensure(data.newSessionId); composer.setText(data.newSessionId, data.prefillText);
    await select(data.newSessionId);
  } catch (error) { ui.toast(error instanceof Error ? error.message : "Fork created, but the new session could not be opened", "error"); }
}
async function retryPromptChip(chip: PendingPromptChip) {
  if (!session.value || pending.value) return;
  try { await composer.retryChip(session.value.id, chip, sessions.statuses[session.value.id]?.status === "running"); }
  catch (error) { ui.toast(error instanceof Error ? error.message : "Could not retry prompt", "error"); }
}
async function command(raw: string) {
  if (!session.value) return; const parsed = parseLocalSlashCommand(raw);
  if (!parsed) { if (pending.value) { await sendPending(raw); return; } await mainSocket.request("prompt", { sessionId: session.value.id, prompt: raw, clientUuid: crypto.randomUUID() }); composer.setText(session.value.id, ""); return; }
  const id = session.value.id;
  try {
    if (parsed.command === "settings") showSettings.value = true;
    else if (parsed.command === "theme") prefs.setDisplayStyle(parsed.args.toLowerCase().includes("wechat") ? "wechat" : "claude-code");
    else if (parsed.command === "clear") composer.chips[id] = [];
    else if (parsed.command === "compact") await mainSocket.request("compact-session", { sessionId: id });
    else if (parsed.command === "export") location.assign(exportUrl(id));
    else if (parsed.command === "model") await mainSocket.request("set-model", { sessionId: id, model: parsed.args });
    else if (parsed.command === "permissions" || parsed.command === "approval") await mainSocket.request("set-permission-mode", { sessionId: id, mode: parsed.args });
    else if (parsed.command === "goal") {
      if (!parsed.args) await mainSocket.request("codex-goal-get", { sessionId: id });
      else { const goal = parseCodexGoalFields(parsed.args); if (!goal) throw new Error("Use /goal <objective> or JSON with objective, status, and tokenBudget"); await mainSocket.request("codex-goal-set", { sessionId: id, ...goal }); }
    }
    else if (["mcp", "plugin", "hooks", "agents", "memory", "version", "doctor"].includes(parsed.command)) {
      const info = await mainSocket.request<{ title: string; markdown: string }>("cli-info", { sessionId: id, topic: parsed.command }); ui.toast(`${info.title}: ${info.markdown.slice(0, 180)}`);
    } else ui.toast(`Context: ${sourceLines.value.length} loaded source lines; status ${sessions.statuses[id]?.status ?? "idle"}`);
    composer.setText(id, "");
  } catch (error) { ui.toast(error instanceof Error ? error.message : "Command failed", "error"); }
}
type DeleteResult = { deleted: string[]; failed: Array<{ id: string; message: string }> };
async function deleteSession(id: string) {
  const pendingDraft = pendingSessions.items.find((item) => item.id === id);
  if (pendingDraft) {
    if (!confirm("Discard this unstarted session draft?")) return;
    const files = [...(composer.attachments[id] ?? [])];
    pendingSessions.remove(id); composer.setText(id, ""); composer.clearAttachmentsIfMatches(id, files);
    if (pendingSelected.value === id) { pendingSelected.value = null; sessions.handoffSelection(null); }
    return;
  }
  if (!confirm("Delete this session file?")) return;
  const result = await mainSocket.request<DeleteResult>("delete-sessions", { sessionIds: [id] });
  if (result.deleted.includes(sessions.selectedId ?? "")) sessions.handoffSelection(null);
  if (result.failed.length) ui.toast(result.failed.map((item) => `${item.id}: ${item.message}`).join("; "), "error");
  await sessions.refresh();
}
async function deleteManySessions(ids: string[]) {
  if (!ids.length || !confirm(`Delete ${ids.length} selected sessions?`)) return;
  const result = await mainSocket.request<DeleteResult>("delete-sessions", { sessionIds: ids });
  if (result.deleted.includes(sessions.selectedId ?? "")) sessions.handoffSelection(null);
  if (result.failed.length) ui.toast(`${result.failed.length} session(s) could not be deleted: ${result.failed.map((item) => item.message).join("; ")}`, "error");
  else ui.toast(`Deleted ${result.deleted.length} sessions`);
  await sessions.refresh();
}
async function renameSession(id: string, title: string) {
  if (pendingSessions.items.some((item) => item.id === id)) { pendingSessions.update(id, { title }); return; }
  await mainSocket.request("set-title", { sessionId: id, title }); sessions.touch(id, { title, titleSource: "manual" });
}
</script>

<template>
  <div class="cw-app" data-shell-version="viewport-v1" :class="[appShellClass, { 'cw-show-list': ui.mobileListVisible, 'cw-sidebar-is-resizing': sidebarResizing }]" :style="appShellStyle">
    <Sidebar @select="select" @new="openNew" @settings="showSettings = true" @refresh="sessions.refresh" @delete="deleteSession" @delete-many="deleteManySessions" @rename="renameSession" />
    <div
      class="cw-sidebar-resizer"
      role="separator"
      aria-label="Resize chats sidebar"
      aria-orientation="vertical"
      :aria-valuemin="SIDEBAR_MIN_WIDTH"
      :aria-valuemax="SIDEBAR_MAX_WIDTH"
      :aria-valuenow="sidebarWidth"
      tabindex="0"
      @pointerdown="beginSidebarResize"
      @keydown="resizeSidebarWithKeyboard"
    />
    <main class="cw-main cw-main-pane">
      <template v-if="session">
        <SessionHeader
          :session="session"
          :status="sessions.statuses[session.id]"
          :background-tasks="background.bySession[session.id] || []"
          :connected="live.connected"
          @back="ui.mobileListVisible = true"
          @renamed="sessions.touch(session.id, { title: $event, titleSource: 'manual' })"
        />
        <ComposerBar :key="session.id" :session-id="session.id" :session="session" :agent="session.agent" :settings="sessions.settings[session.id]" :status="sessions.statuses[session.id]" :active="sessions.statuses[session.id]?.status === 'running'" :start-line="nextSourceIndex" :pending="!!pending" :disabled="pendingSending" @command="command" @send-pending="sendPending" />
        <button v-if="todos.length" class="cw-todo-pill" @click="showTodos = true">{{ todos.filter(t => t.status === 'completed').length }}/{{ todos.length }} todos</button>
        <TranscriptPane v-if="!pending" :session-id="session.id" :agent="session.agent" :blocks="blocks" :chips="composer.chips[session.id] || []" :style="prefs.messageDisplayStyle" :loading="live.restoring[session.id]" :loading-earlier="live.loadingEarlier[session.id]" :first-source-index="firstSourceIndex" :scroll-target-uuid="ui.searchTarget?.sessionId === session.id ? ui.searchTarget.uuid : undefined" :scroll-target-index="ui.searchTarget?.sessionId === session.id ? ui.searchTarget.index : undefined" @prefill="composer.setText(session.id, $event)" @forked="handleFork" @retry-chip="retryPromptChip" @dismiss-chip="composer.dismiss(session.id, $event)" @load-earlier="loadEarlierSession(session.id)" @compact="compactSelectedSession" @new-chat="startNewChatInCurrentDirectory" />
        <div v-else class="cw-transcript-frame"><div class="cw-empty cw-pending-empty"><strong>New {{ session.agent }} session</strong><span>{{ session.cwd }}</span><span>Your session starts when you send the first prompt.</span></div></div>
        <InteractionTray :session-id="session.id" :exclude-tool-use-ids="inlineToolUseIds" />
      </template>
      <div v-else class="cw-empty cw-no-selection"><strong>Select or start a session</strong><span>Claude Code and Codex histories appear here.</span></div>
    </main>
    <NewSessionDialog v-if="showNew" :initial-cwd="newSessionCwd" :recent-cwds="recentCwds" @close="showNew = false" @create="create" />
    <SettingsDialog v-if="showSettings" @close="showSettings = false" />
    <Teleport to="body"><div v-if="showTodos" class="cw-modal-scrim cw-modal-overlay" @click.self="showTodos = false"><section class="cw-modal cw-modal-card cw-todo-modal"><header><h2>Session tasks</h2><button @click="showTodos = false">Close</button></header><ol><li v-for="todo in todos" :key="todo.id" :class="`is-${todo.status}`"><span class="cw-todo-check">{{ todo.status === 'completed' ? '✓' : '' }}</span><div><strong>{{ todo.subject }}</strong><small>{{ todo.status.replaceAll('_', ' ') }}</small></div></li></ol></section></div></Teleport>
    <OverlayHost />
  </div>
</template>
