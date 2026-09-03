import { defineStore } from "pinia";
import type { CodexGoal, SessionListItem } from "@claude-webui/shared/api";
import type { Status } from "@claude-webui/shared/sse";
import { listSessions, markReadRemote } from "../api/sessions.js";
import { assignCwdColors } from "../util/avatar.js";
import { dismissSessionNotification } from "../util/pwa-notifications.js";

const SESSION_LIST_STORAGE_KEY = "cw:sessions:v1";
const SESSION_LIST_STORAGE_LIMIT = 250;
const SESSION_LIST_FLUSH_DEBOUNCE_MS = 500;

function cachedSessionItem(item: SessionListItem): SessionListItem {
  // Process status belongs to the current backend lifetime. Persisting a
  // running badge would make a cold-loaded row lie until the refresh lands.
  const { status: _status, ...cached } = item;
  return cached;
}

function loadSessionListFromStorage(): SessionListItem[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSION_LIST_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is SessionListItem => (
        !!item
        && typeof item === "object"
        && typeof item.id === "string"
        && typeof item.cwd === "string"
        && typeof item.mtime === "string"
        && typeof item.size === "number"
      ))
      .slice(0, SESSION_LIST_STORAGE_LIMIT)
      .map(cachedSessionItem);
  } catch { return []; }
}

let sessionListFlushTimer: ReturnType<typeof setTimeout> | null = null;
let sessionListPending: SessionListItem[] | null = null;

function flushSessionListNow(): void {
  if (sessionListFlushTimer) {
    clearTimeout(sessionListFlushTimer);
    sessionListFlushTimer = null;
  }
  if (!sessionListPending) return;
  try {
    const recent = sessionListPending
      .filter(item => !item.id.startsWith("draft:"))
      .slice(0, SESSION_LIST_STORAGE_LIMIT)
      .map(cachedSessionItem);
    localStorage.setItem(SESSION_LIST_STORAGE_KEY, JSON.stringify(recent));
  } catch { /* quota or unavailable */ }
  sessionListPending = null;
}

function scheduleSessionListFlush(snapshot: SessionListItem[]): void {
  if (typeof localStorage === "undefined") return;
  sessionListPending = snapshot;
  if (sessionListFlushTimer) return;
  sessionListFlushTimer = setTimeout(flushSessionListNow, SESSION_LIST_FLUSH_DEBOUNCE_MS);
}

// Persist unread counts to localStorage so a backend restart followed by a
// page refresh doesn't wipe the badge. Without this, unread is purely
// in-memory and resets on any reload.
//
// v2: bumped from v1 to invalidate the wave of bogus 99+ counts that
// accumulated before the notifications-watcher startup-anchor gate landed.
// Those came from snapshotExisting racing with chokidar — the watcher
// emitted historical end_turns on restart, the frontend bumped unread per
// emit, and the bumps got saved to localStorage where a backend restart
// can't reach them. v1 entries get ignored on first load after upgrade.
const UNREAD_STORAGE_KEY = "cw:unread:v2";
const UNREAD_FLUSH_DEBOUNCE_MS = 200;

function loadUnreadFromStorage(): Record<string, number> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(UNREAD_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "number" && v > 0) out[k] = v;
      }
      return out;
    }
  } catch { /* corrupt — start fresh */ }
  return {};
}

let unreadFlushTimer: ReturnType<typeof setTimeout> | null = null;
let unreadPending: Record<string, number> | null = null;

function scheduleUnreadFlush(snapshot: Record<string, number>) {
  unreadPending = snapshot;
  if (unreadFlushTimer) return;
  unreadFlushTimer = setTimeout(() => {
    unreadFlushTimer = null;
    if (!unreadPending) return;
    try {
      const compact: Record<string, number> = {};
      for (const [k, v] of Object.entries(unreadPending)) {
        if (v > 0) compact[k] = v;
      }
      localStorage.setItem(UNREAD_STORAGE_KEY, JSON.stringify(compact));
    } catch { /* quota or unavailable */ }
    unreadPending = null;
  }, UNREAD_FLUSH_DEBOUNCE_MS);
}

if (typeof window !== "undefined") {
  const flushNow = () => {
    if (unreadFlushTimer) { clearTimeout(unreadFlushTimer); unreadFlushTimer = null; }
    if (unreadPending) {
      try { localStorage.setItem(UNREAD_STORAGE_KEY, JSON.stringify(unreadPending)); }
      catch { /* noop */ }
      unreadPending = null;
    }
  };
  window.addEventListener("pagehide", flushNow);
  window.addEventListener("beforeunload", flushNow);
  window.addEventListener("pagehide", flushSessionListNow);
  window.addEventListener("beforeunload", flushSessionListNow);
}

// Pending drafts persist to localStorage so a page refresh (or PWA cold
// start) doesn't lose a draft the user parked in the sidebar. WeChat-style:
// drafts stay until the first send promotes them or the user deletes the row.
const DRAFTS_STORAGE_KEY = "cw:pendingDrafts:v1";

export interface PendingDraft {
  cwd: string;
  createdAt: number;
  agent?: "claude" | "codex";
  // Pre-spawn model / permission / effort picks made via the PillRow in draft mode.
  // Sent along with the first prompt (newSession) so they apply from turn 1.
  model?: string;
  permissionMode?: string;
  effort?: string;
  serviceTier?: string;
  /** Stable key for retrying the first materializing request after an unknown transport outcome. */
  clientUuid?: string;
  /** Fingerprint of the draft payload that owns clientUuid. */
  clientFingerprint?: string;
}

function loadDraftsFromStorage(): Record<string, PendingDraft> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(DRAFTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, PendingDraft> = {};
      for (const [k, v] of Object.entries(parsed)) {
        const d = v as Partial<PendingDraft>;
        if (!k.startsWith("draft:") || typeof d?.cwd !== "string" || !d.cwd) continue;
        out[k] = {
          cwd: d.cwd,
          createdAt: typeof d.createdAt === "number" ? d.createdAt : Date.now(),
          ...(d.agent === "codex" || d.agent === "claude" ? { agent: d.agent } : {}),
          ...(typeof d.model === "string" && d.model ? { model: d.model } : {}),
          ...(typeof d.permissionMode === "string" && d.permissionMode ? { permissionMode: d.permissionMode } : {}),
          ...(typeof d.effort === "string" && d.effort ? { effort: d.effort } : {}),
          ...(d.serviceTier === "" || d.serviceTier === "priority" ? { serviceTier: d.serviceTier } : {}),
          ...(typeof d.clientUuid === "string" && d.clientUuid ? { clientUuid: d.clientUuid.slice(0, 200) } : {}),
          ...(typeof d.clientFingerprint === "string" && d.clientFingerprint ? { clientFingerprint: d.clientFingerprint.slice(0, 2_000) } : {}),
        };
      }
      return out;
    }
  } catch { /* corrupt — start fresh */ }
  return {};
}

function saveDraftsToStorage(drafts: Record<string, PendingDraft>) {
  if (typeof localStorage === "undefined") return;
  try { localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(drafts)); }
  catch { /* quota or unavailable */ }
}

// Build the sidebar list items for restored drafts. mtime = createdAt so a
// restored draft keeps its original position instead of jumping to the top.
function draftListItem(id: string, d: PendingDraft): SessionListItem {
  return {
    id,
    cwd: d.cwd,
    mtime: new Date(d.createdAt).toISOString(),
    size: 0,
    title: null,
    parentSessionId: null,
    ...(d.agent ? { agent: d.agent } : {}),
  };
}

interface State {
  list: SessionListItem[];
  byId: Record<string, SessionListItem>;
  statusBySession: Record<string, Status | null>;
  // Per-session "we own a live webui-spawned claude" flag. Independent of
  // statusBySession: an idle long-lived claude has status=null but
  // webuiAliveBySession[id]=true. Drives the Kill pill in MainPane.
  webuiAliveBySession: Record<string, boolean>;
  // Per-session "the CLI is running /compact right now" flag (wire-only
  // signal — the jsonl is silent for the whole compact, so this is the only
  // way to render "Compacting…" instead of generic thinking dots).
  compactingBySession: Record<string, boolean>;
  capacityRetryBySession: Record<string, {
    turnId: string;
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    retryAt: string;
  }>;
  // Set of sessions that are currently being (re)titled by the backend,
  // either via periodic auto-retitle or a user-clicked Auto button. Used
  // by SessionRow to render the same "⟳ Retitling…" spinner regardless of
  // whether the trigger was local or remote.
  retitlingBySession: Record<string, boolean>;
  goalBySession: Record<string, CodexGoal | null>;
  // Count of assistant turns that landed for a session while it wasn't the
  // currently-selected one. Reset to 0 the moment you select that session.
  unreadBySession: Record<string, number>;
  // Frontend-only "pending" sessions: created when the user clicks +Here or
  // creates a new session in the modal without a prompt. They appear in the
  // sidebar with id like `draft:<uuid>`, render as a clean composer-only
  // pane, and turn into a real session the moment the user types the first
  // prompt and the backend spawns claude. Persisted to localStorage so they
  // survive refreshes; removed only on promotion or explicit delete.
  pendingDrafts: Record<string, PendingDraft>;
  // Transient draft-id → real-session-id aliases. A new-session watcher can
  // promote the row before the originating RPC settles; async send cleanup
  // uses this map to restore/settle state on the visible real session.
  promotedDrafts: Record<string, string>;
  lastError: string | null;
  loaded: boolean;
  syncInFlight: number;
  /** Monotonic local metadata-event revision used to reject stale list snapshots. */
  metadataRevision: number;
  revisionBySession: Record<string, number>;
  /** Latest list request generation; older HTTP responses are ignored. */
  fetchGeneration: number;
}

let draftCounter = 0;
function nextDraftId(): string {
  draftCounter += 1;
  return `draft:${Date.now()}-${draftCounter}`;
}

function byMtimeDesc(a: SessionListItem, b: SessionListItem): number {
  return Date.parse(b.mtime) - Date.parse(a.mtime);
}

function validTime(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function compareSessionRecency(
  existing: SessionListItem,
  incoming: SessionListItem,
): -1 | 0 | 1 {
  // Draft promotion and fork navigation can insert a synthetic empty row with
  // a client-side "now" before the authoritative watcher/list item arrives.
  // Its clock can be a few milliseconds ahead of the file's mtime, so let the
  // first non-empty file record replace it even when that timestamp is older.
  if (existing.size === 0 && !existing.preview && incoming.size > 0) return 1;

  const incomingTime = validTime(incoming.mtime);
  const existingTime = validTime(existing.mtime);
  if (incomingTime !== existingTime) return incomingTime > existingTime ? 1 : -1;

  // Appends can share an mtime at the filesystem/API timestamp resolution.
  // For the same mtime, the larger append-only file is the newer snapshot.
  if (incoming.size !== existing.size) return incoming.size > existing.size ? 1 : -1;
  return 0;
}

export function mergeSessionListItem(
  existing: SessionListItem,
  incoming: SessionListItem,
  preserveExistingRecency = false,
): SessionListItem {
  const recency = compareSessionRecency(existing, incoming);
  const shouldPreserve = recency < 0
    || (preserveExistingRecency && recency === 0);
  if (!shouldPreserve) return { ...existing, ...incoming };
  return {
    ...existing,
    ...incoming,
    // Titles/settings from a snapshot can still be useful, but an older
    // snapshot/event must never roll the visible latest-message metadata back.
    mtime: existing.mtime,
    size: existing.size,
    preview: existing.preview ?? null,
    previewRole: existing.previewRole ?? null,
    lastTurnAt: existing.lastTurnAt ?? null,
    lastBoundaryAt: existing.lastBoundaryAt ?? null,
  };
}

export const useSessionsStore = defineStore("sessions", {
  state: (): State => {
    // Restore parked drafts (localStorage) straight into the sidebar list so
    // they're visible even before the first get-sessions roundtrip lands.
    const pendingDrafts = loadDraftsFromStorage();
    const draftItems = Object.entries(pendingDrafts).map(([id, d]) => draftListItem(id, d));
    const cachedItems = loadSessionListFromStorage();
    const initialItems = [...cachedItems, ...draftItems].sort(byMtimeDesc);
    return {
      list: initialItems,
      byId: Object.fromEntries(initialItems.map((s) => [s.id, s])),
      statusBySession: {},
      webuiAliveBySession: {},
      compactingBySession: {},
      capacityRetryBySession: {},
      retitlingBySession: {},
      goalBySession: {},
      unreadBySession: loadUnreadFromStorage(),
      pendingDrafts,
      promotedDrafts: {},
      lastError: null,
      loaded: cachedItems.length > 0,
      syncInFlight: 0,
      metadataRevision: 0,
      revisionBySession: {},
      fetchGeneration: 0,
    };
  },
  getters: {
    // cwd → palette index, assigned in recency order so the most recently
    // active distinct directories never collide on a color. `list` is kept
    // sorted by mtime desc (see byMtimeDesc), which is exactly the recency
    // order assignCwdColors wants. Recomputes (Pinia-cached) when the list
    // changes. SessionRow reads this to color its avatar by cwd.
    cwdColorIndex(state): Map<string, number> {
      return assignCwdColors(state.list.map((s) => s.cwd));
    },
  },
  actions: {
    // Hydrate from a pre-fetched list (e.g. window.__BOOT__.sessions baked
    // into the HTML by the backend). Skips the RPC roundtrip on first load.
    hydrateList(list: SessionListItem[], preserveAfterRevision?: number) {
      // Re-attach pending drafts: the backend list only knows real jsonl
      // sessions, but drafts live client-side and must survive refreshes.
      // Keep the existing row object when present so in-place edits (e.g.
      // model picks) stay reactive.
      const draftItems = Object.entries(this.pendingDrafts).map(
        ([id, d]) => this.byId[id] ?? draftListItem(id, d),
      );
      const backendIds = new Set(list.map(item => item.id));
      const mergedBackend = list.flatMap(item => {
        const existing = this.byId[item.id];
        const changedAfterRequest = preserveAfterRevision !== undefined
          && (this.revisionBySession[item.id] ?? 0) > preserveAfterRevision;
        // A delete that happened after this request started leaves a revision
        // tombstone but no row. Do not resurrect it from the stale response.
        if (!existing && changedAfterRequest) return [];
        return [existing
          ? mergeSessionListItem(existing, item, changedAfterRequest)
          : item];
      });
      const liveOnly = preserveAfterRevision === undefined
        ? []
        : this.list.filter(item =>
          !(item.id in this.pendingDrafts)
          && !backendIds.has(item.id)
          && (this.revisionBySession[item.id] ?? 0) > preserveAfterRevision);
      const sorted = [...mergedBackend, ...liveOnly, ...draftItems].sort(byMtimeDesc);
      this.list = sorted;
      this.byId = Object.fromEntries(sorted.map((s) => [s.id, s]));
      for (const s of sorted) {
        if (s.status !== undefined) this.statusBySession[s.id] = (s.status ?? null) as Status | null;
        // Offline catch-up: clear badges for sessions already read elsewhere.
        this.reconcileRead(s, true);
      }
      // Prune ghost unread counts: a session deleted while this device was
      // offline never goes through removeMany, so its localStorage badge
      // would otherwise stick forever — uncleaable, since there's no row
      // left to open (markRead) and totalUnread can't peer/hidden-filter an
      // id that isn't in byId.
      let pruned = false;
      for (const id of Object.keys(this.unreadBySession)) {
        if (!this.byId[id]) { delete this.unreadBySession[id]; pruned = true; }
      }
      if (pruned) scheduleUnreadFlush({ ...this.unreadBySession });
      scheduleSessionListFlush(this.list);
      this.loaded = true;
      this.lastError = null;
    },
    async fetchAll(): Promise<boolean> {
      this.syncInFlight++;
      const generation = ++this.fetchGeneration;
      const startedAtRevision = this.metadataRevision;
      try {
        const list = await listSessions();
        if (generation === this.fetchGeneration) {
          this.hydrateList(list, startedAtRevision);
        }
        return true;
      } catch (err) {
        if (generation === this.fetchGeneration) {
          this.lastError = (err as Error).message;
        }
        return false;
      } finally {
        this.syncInFlight = Math.max(0, this.syncInFlight - 1);
      }
    },
    addOrTouch(item: SessionListItem) {
      const existing = this.byId[item.id];
      const acceptedRecency = !existing
        || compareSessionRecency(existing, item) >= 0;
      if (existing) {
        Object.assign(existing, mergeSessionListItem(existing, item));
      } else {
        this.byId[item.id] = item;
        this.list.push(item);
      }
      if (acceptedRecency) {
        this.metadataRevision += 1;
        this.revisionBySession[item.id] = this.metadataRevision;
      }
      this.list.sort(byMtimeDesc);
      const row = this.byId[item.id];
      if (row) this.reconcileRead(row);
    },
    setStatus(id: string, status: Status | null, webuiAlive: boolean, compacting?: boolean) {
      this.statusBySession[id] = status;
      if (status !== "running") delete this.capacityRetryBySession[id];
      if (webuiAlive) this.webuiAliveBySession[id] = true;
      else delete this.webuiAliveBySession[id];
      if (compacting) this.compactingBySession[id] = true;
      else delete this.compactingBySession[id];
    },
    setCompacting(id: string, compacting: boolean) {
      if (compacting) this.compactingBySession[id] = true;
      else delete this.compactingBySession[id];
    },
    // Wipe every per-session status. Called on WS reconnect: the backend
    // snapshot that follows only re-asserts non-null statuses, so any
    // session that finished while we were offline would otherwise stay
    // stuck on a stale "running" forever. Same applies to webuiAlive.
    clearAllStatus() {
      this.statusBySession = {};
      this.webuiAliveBySession = {};
      this.compactingBySession = {};
      this.capacityRetryBySession = {};
    },
    setCapacityRetry(id: string, retry: {
      turnId: string;
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      retryAt: string;
    }) {
      this.capacityRetryBySession[id] = retry;
    },
    setTitle(id: string, title: string | null, source?: "auto" | "manual" | null, emoji?: string | null) {
      const e = this.byId[id];
      if (e) {
        e.title = title;
        if (source !== undefined) e.titleSource = source;
        // emoji is undefined → don't touch (manual rename without explicit
        // emoji shouldn't blank out the existing one). Only overwrite when
        // the caller passes null (explicit clear) or a real string.
        if (emoji !== undefined) e.titleEmoji = emoji;
      }
    },
    setBoundaryAt(id: string, at: string) {
      const e = this.byId[id];
      if (e) e.lastBoundaryAt = at;
    },
    setRetitling(id: string, inflight: boolean) {
      if (inflight) this.retitlingBySession[id] = true;
      else delete this.retitlingBySession[id];
    },
    setGoal(id: string, goal: CodexGoal | null) {
      if (goal) this.goalBySession[id] = goal;
      else delete this.goalBySession[id];
    },
    isRetitling(id: string): boolean {
      return !!this.retitlingBySession[id];
    },
    setUnread(id: string, count: number) {
      const next = Number.isSafeInteger(count) && count > 0 ? count : 0;
      const previous = this.unreadBySession[id] ?? 0;
      const item = this.byId[id];
      if (item) item.unreadCount = next;
      if (next > 0) this.unreadBySession[id] = next;
      else delete this.unreadBySession[id];
      if (previous !== next) scheduleUnreadFlush({ ...this.unreadBySession });
    },
    bumpUnread(id: string) {
      this.setUnread(id, (this.unreadBySession[id] ?? 0) + 1);
    },
    // User opened this session on THIS device. Clear the local count AND push
    // the read watermark to the server so every other device clears too. The
    // watermark is the session's lastTurnAt at read time (falls back to mtime).
    markRead(id: string) {
      const e = this.byId[id];
      const at = e?.lastTurnAt || e?.mtime;
      if (at) this.markReadAt(id, at);
      else this.markReadLocal(id);
    },
    // Advance monotonically. Delayed completion notifications can arrive
    // after the user has already sent the next prompt; they must never move a
    // newer read watermark backwards and resurrect an unread badge.
    markReadAt(id: string, at: string) {
      this.markReadLocal(id);
      const e = this.byId[id];
      if (!e || validTime(at) <= validTime(e.readAt)) return;
      e.readAt = at;
      markReadRemote(id, at);
    },
    // Clear the local unread count WITHOUT broadcasting. Used when a
    // `session-read` arrives from another device (avoids an echo loop) and by
    // the list-load reconcile for sessions already read elsewhere.
    markReadLocal(id: string) {
      void dismissSessionNotification(id);
      this.setUnread(id, 0);
    },
    // Offline catch-up: if the server-synced read watermark is at or past the
    // session's latest turn, it's been read on some device — clear the local
    // badge. Called for each row on list hydrate / touch.
    reconcileRead(item: SessionListItem, allowOfflineCatchUp = false) {
      const latest = item.lastTurnAt || item.mtime;
      if (latest && item.readAt && Date.parse(item.readAt) >= Date.parse(latest)) {
        this.markReadLocal(item.id);
        return;
      }
      if (Number.isSafeInteger(item.unreadCount) && Number(item.unreadCount) >= 0) {
        this.setUnread(item.id, Number(item.unreadCount));
        return;
      }
      // Compatibility/migration fallback: old backends and cached rows do not
      // carry unreadCount. A latest assistant turn beyond readAt is at least one
      // unread reply, so a device that slept through the live event still gets
      // the badge when it catches up.
      if (
        allowOfflineCatchUp
        &&
        latest
        && item.previewRole === "assistant"
        && validTime(latest) > validTime(item.readAt)
        && !((this.unreadBySession[item.id] ?? 0) > 0)
      ) {
        this.setUnread(item.id, 1);
      }
    },
    // Remove a batch of sessions from the local store after the backend
    // has deleted their jsonl files. Drops byId / list / status / unread
    // entries together so the sidebar updates atomically.
    removeMany(ids: string[]) {
      const set = new Set(ids);
      let unreadChanged = false;
      let draftsChanged = false;
      for (const id of ids) {
        this.metadataRevision += 1;
        this.revisionBySession[id] = this.metadataRevision;
        delete this.byId[id];
        delete this.statusBySession[id];
        delete this.webuiAliveBySession[id];
        delete this.compactingBySession[id];
        delete this.capacityRetryBySession[id];
        delete this.goalBySession[id];
        if (id in this.unreadBySession) { delete this.unreadBySession[id]; unreadChanged = true; }
        if (id in this.pendingDrafts) { delete this.pendingDrafts[id]; draftsChanged = true; }
      }
      this.list = this.list.filter((s) => !set.has(s.id));
      if (unreadChanged) scheduleUnreadFlush({ ...this.unreadBySession });
      if (draftsChanged) saveDraftsToStorage(this.pendingDrafts);
    },
    // Create a frontend-only pending session — appears in the sidebar with
    // a draft id, no jsonl behind it, mtime "now" so it sorts to the top
    // of its cwd group. Returns the draft id.
    createPending(cwd: string, agent?: "claude" | "codex"): string {
      const id = nextDraftId();
      const nowIso = new Date().toISOString();
      this.pendingDrafts[id] = { cwd, createdAt: Date.now(), ...(agent ? { agent } : {}) };
      const item: SessionListItem = {
        id, cwd, mtime: nowIso, size: 0, title: null, parentSessionId: null,
        ...(agent ? { agent } : {}),
      };
      this.byId[id] = item;
      this.list.unshift(item);
      this.list.sort(byMtimeDesc);
      saveDraftsToStorage(this.pendingDrafts);
      return id;
    },
    isPending(id: string): boolean {
      return id in this.pendingDrafts;
    },
    recordPromotion(draftId: string, sessionId: string) {
      if (!draftId || !sessionId || draftId === sessionId) return;
      this.promotedDrafts[draftId] = sessionId;
    },
    resolvePromoted(id: string): string {
      let current = id;
      const seen = new Set<string>();
      while (this.promotedDrafts[current] && !seen.has(current)) {
        seen.add(current);
        current = this.promotedDrafts[current]!;
      }
      return current;
    },
    dropPending(id: string) {
      if (!(id in this.pendingDrafts)) return;
      delete this.pendingDrafts[id];
      delete this.byId[id];
      this.list = this.list.filter((s) => s.id !== id);
      saveDraftsToStorage(this.pendingDrafts);
    },
    // Stash a pre-spawn model / permission pick on a draft. Applied by the
    // backend at first-spawn time (newSession carries them along).
    setPendingSettings(id: string, patch: { model?: string; permissionMode?: string; effort?: string; serviceTier?: string }) {
      const d = this.pendingDrafts[id];
      if (!d) return;
      // Empty string returns model / permission / effort to their defaults.
      // For serviceTier it is an explicit Fast-off choice, which must survive
      // when the global default is Fast-on.
      if (patch.model !== undefined) {
        if (patch.model) d.model = patch.model;
        else delete d.model;
      }
      if (patch.permissionMode !== undefined) {
        if (patch.permissionMode) d.permissionMode = patch.permissionMode;
        else delete d.permissionMode;
      }
      if (patch.effort !== undefined) {
        if (patch.effort) d.effort = patch.effort;
        else delete d.effort;
      }
      if (patch.serviceTier !== undefined) {
        d.serviceTier = patch.serviceTier === "priority" ? "priority" : "";
      }
      saveDraftsToStorage(this.pendingDrafts);
    },
    newSessionClientUuid(id: string, fingerprint: string, suggested: string): string {
      const draft = this.pendingDrafts[id];
      if (!draft) return suggested;
      if (!draft.clientUuid || draft.clientFingerprint !== fingerprint) {
        draft.clientUuid = suggested;
        draft.clientFingerprint = fingerprint;
        saveDraftsToStorage(this.pendingDrafts);
      }
      return draft.clientUuid;
    },
    // Used after a real session lands for a pending draft's cwd: find the
    // most-recently-created pending whose cwd matches and return its id.
    pendingForCwd(cwd: string): string | null {
      let best: { id: string; createdAt: number } | null = null;
      for (const [id, p] of Object.entries(this.pendingDrafts)) {
        if (p.cwd !== cwd) continue;
        if (!best || p.createdAt > best.createdAt) best = { id, createdAt: p.createdAt };
      }
      return best?.id ?? null;
    },
  },
});
