import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { mkdir, open, readFile, realpath, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import compress from "@fastify/compress";
import fastifyStatic from "@fastify/static";
import type { WebSocket } from "ws";
import { COOKIE_NAME, requestToken, resolveToken, setTokenCookie, timingSafeToken } from "./auth.js";
import { asRecord, asString, assertSessionId, RpcError, type SessionRecord } from "./types.js";
import { SessionIndex } from "./services/session-index.js";
import {
  configureLineIndexPersistence,
  countJsonlLines,
  flushLineIndexPersistence,
  JsonlTailer,
  isRenderableClaudeLine,
  MAX_JSONL_RECORD_BYTES,
  preserveIndexes,
  readRecordAt,
  readRange,
  readTail,
  readTailSnapshot,
} from "./services/jsonl.js";
import { AppState, normalizePrefs } from "./services/state.js";
import { PubSub } from "./services/pubsub.js";
import { ClaudeDriver } from "./services/claude-driver.js";
import { CODEX_REASONING_EFFORTS, CodexDriver } from "./services/codex-driver.js";
import { inspectLocalPath, listLocalDirectory, openLocalPath, PreviewStore, readLocalSource, resolveLocalFile, resolveLocalPath } from "./services/files.js";
import { autoTitle, autoTitleFromText, deleteSessions, forkSession, getUserMessages, markdownExport, rewindSession, searchSessions } from "./actions/sessions.js";
import { expandHome, isWithin, safeFilename } from "./util/paths.js";
import { resolveCodexExecutable } from "./util/executable.js";
import { codexDurableTerminal, isMeaningfulEndTurnRecord, NotificationDeduper } from "./services/notifications.js";
import { assertDirectPromptAllowed, normalizeDirectPromptError } from "./services/session-prompt.js";
import {
  failRunningClaudeBackgroundTasks,
  mergeClaudeBackgroundTasks,
  mergeCodexBackgroundTask,
  settleRunningCodexBackgroundTasks,
  type BackgroundTaskRecord,
} from "./services/background-tasks.js";
import { ClaudeProcessObserver, type ForeignClaudeObservation } from "./services/claude-process-observer.js";
import { ContentSearchIndex } from "./services/content-search-index.js";
import { fullCodexContextUsage } from "./services/codex-context-usage.js";
import { sendJson } from "./services/ws-send.js";
import { themedVisualizationHtml } from "./services/visualization.js";
import {
  sanitizeTranscriptLines,
  sanitizeTranscriptRaw,
  transcriptImagePayload,
} from "./services/transcript-images.js";
import {
  formatTitleWithEmoji,
  resolveSessionTitle,
  splitTitleEmoji,
} from "./services/session-title.js";
import {
  appendConversationTitleRequests,
  appendIncrementalTitleRequests,
  formatIncrementalTitleContext,
  formatTitleRequestContext,
  recentSessionTitleContext,
  sessionTitleRequests,
  titleRequestText,
} from "./services/session-title-context.js";
import { CodexSessionTitleGenerator } from "./services/session-title-generator.js";
import type { SessionTitleGenerator } from "./services/session-title-generator.js";
import {
  MAX_CLAUDE_PROMPT_ATTACHMENTS,
  MAX_CODEX_PROMPT_ATTACHMENTS,
  MAX_PROMPT_ATTACHMENT_BYTES,
  type AgentCapabilities,
  type AgentSelectOption,
  type PrefsBlob,
} from "@agent-webui/shared";

const execFileAsync = promisify(execFile);
// Automatic mobile gap repair should never pull a multi-megabyte tool record.
// Full-fidelity range reads remain available when the user explicitly loads
// older history; this compact mode is only for quietly reconnecting a recent
// sparse suffix to the already-cached turn.
const COMPACT_RANGE_MAX_BYTES = 512 * 1024;
const COMPACT_RANGE_MAX_RECORD_BYTES = 128 * 1024;

export interface BuildAppOptions {
  home?: string;
  stateDir?: string;
  claudeRoot?: string;
  codexRoot?: string;
  claudeSessionsDir?: string;
  frontendDist?: string;
  token?: string;
  tokenPath?: string;
  claudeBinary?: string;
  codexBinary?: string;
  titleGenerator?: SessionTitleGenerator;
  logger?: boolean;
  startWatchers?: boolean;
  sessionColdScanPaceMs?: number;
}

interface RpcRequest { type: string; reqId?: string; [key: string]: unknown }

function rawPath(request: FastifyRequest): string {
  const raw = request.raw.url ?? "/";
  const question = raw.indexOf("?");
  const value = question >= 0 ? raw.slice(0, question) : raw;
  try { return decodeURIComponent(value); } catch { return "\0"; }
}

function fileContentDisposition(kind: "inline" | "attachment", filePath: string): string {
  const name = basename(filePath);
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, char =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function webSocketOriginAllowed(origin: unknown, host: unknown): boolean {
  // CLI/non-browser clients may omit Origin and still need cookie-authenticated
  // access. Browsers always send it; when present, require the page origin to
  // match the HTTP Host so another same-site port cannot drive this privileged
  // socket with the user's cookie.
  if (origin === undefined) return true;
  if (typeof origin !== "string" || typeof host !== "string" || !host) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.host.toLocaleLowerCase() === host.toLocaleLowerCase();
  } catch {
    return false;
  }
}

export async function runIdempotentRequest<T>(
  completed: Map<string, T>,
  inflight: Map<string, Promise<T>>,
  key: string,
  operation: () => Promise<T>,
  maxCompleted = 1_000,
): Promise<T> {
  const prior = completed.get(key);
  if (prior !== undefined) return prior;
  const running = inflight.get(key);
  if (running) return running;
  // Schedule through Promise.resolve so a synchronous throw while constructing
  // the operation follows the same cleanup path as an async rejection.
  const request = Promise.resolve().then(operation);
  inflight.set(key, request);
  try {
    const result = await request;
    completed.set(key, result);
    while (completed.size > maxCompleted) completed.delete(completed.keys().next().value!);
    return result;
  } finally {
    if (inflight.get(key) === request) inflight.delete(key);
  }
}

function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!); }
function safeBootJson(value: unknown): string { return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026"); }
export function interactionAddedPush(interaction: import("./services/state.js").Interaction) {
  const existingInput = asRecord(interaction.input) ?? {};
  const questions = interaction.questions
    ?? (Array.isArray(existingInput.questions) ? existingInput.questions : undefined);
  const input = interaction.kind === "question" && questions
    ? { ...existingInput, questions }
    : existingInput;
  return {
    type: "interaction-added",
    kind: "interaction-added",
    sessionId: interaction.sessionId,
    requestId: interaction.requestId,
    subtype: "can_use_tool",
    toolName: interaction.kind === "question"
      ? "AskUserQuestion"
      : interaction.toolName,
    ...(Object.keys(input).length ? { input } : {}),
    ...(interaction.toolUseId ? { toolUseId: interaction.toolUseId } : {}),
    receivedAt: interaction.createdAt,
    // Retain the richer native shape for existing clients while the reference
    // frontend consumes the flat compatibility fields above.
    interaction,
  } as const;
}

function interactionRemovedPush(
  event: { sessionId: string; requestId: string; reason?: string },
  fallback: "answered" | "cancelled" | "process_died" | "superseded" = "answered",
) {
  const reason = event.reason === "process-died"
    ? "process_died"
    : event.reason === "cancelled" || event.reason === "superseded" || event.reason === "answered"
      ? event.reason
      : fallback;
  return { type: "interaction-removed", kind: "interaction-removed", sessionId: event.sessionId, requestId: event.requestId, reason } as const;
}

function withoutSessionPath(value: Record<string, unknown>): Record<string, unknown> {
  const { path: _path, ...safe } = value;
  return safe;
}

function sessionAddedPush(value: Record<string, unknown>) {
  const session = withoutSessionPath(value);
  return { type: "session-added", kind: "session-added", ...session, session } as const;
}

function sessionTouchedPush(id: string, value: Record<string, unknown>) {
  const session = withoutSessionPath(value);
  return { type: "session-touched", kind: "session-touched", id, ...session, session } as const;
}

function backgroundTaskKind(value: Record<string, unknown>): "agent" | "workflow" | "shell" | "cron" {
  const explicit = asString(value.kind);
  if (explicit === "agent" || explicit === "workflow" || explicit === "shell" || explicit === "cron") return explicit;
  const text = `${asString(value.title) ?? ""} ${asString(value.detail) ?? ""}`.toLocaleLowerCase();
  if (/\b(workflow|pipeline)\b/.test(text)) return "workflow";
  if (/\b(cron|scheduled|schedule)\b/.test(text)) return "cron";
  if (/\b(bash|shell|command|exec|terminal)\b/.test(text)) return "shell";
  return "agent";
}

export function backgroundTasksWire(tasks: readonly unknown[]): Array<{
  taskId: string;
  kind: "agent" | "workflow" | "shell" | "cron";
  relatedSessionIds?: string[];
  label: string;
  startedAt: string;
  status: "running" | "completed" | "failed";
  completedAt?: string;
}> {
  const fallbackTime = new Date(0).toISOString();
  return tasks.flatMap(raw => {
    const task = asRecord(raw);
    if (!task) return [];
    const taskId = asString(task.taskId) ?? asString(task.id);
    if (!taskId) return [];
    const rawStatus = asString(task.status);
    const status = rawStatus === "completed"
      ? "completed"
      : rawStatus === "failed" || rawStatus === "cancelled"
        ? "failed"
        : "running";
    const completedAt = asString(task.completedAt) ?? asString(task.finishedAt);
    const relatedSessionIds = Array.isArray(task.relatedSessionIds)
      ? task.relatedSessionIds.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
    return [{
      taskId,
      kind: backgroundTaskKind(task),
      ...(relatedSessionIds.length ? { relatedSessionIds } : {}),
      label: asString(task.label) ?? asString(task.title) ?? asString(task.detail) ?? taskId,
      startedAt: asString(task.startedAt) ?? completedAt ?? fallbackTime,
      status,
      ...(status !== "running" && completedAt ? { completedAt } : {}),
    }];
  });
}

function backgroundTasksPush(sessionId: string, tasks: readonly unknown[]) {
  return { type: "background-tasks", kind: "background-tasks", sessionId, tasks: backgroundTasksWire(tasks) } as const;
}
export const REQUEST_LOGGING_DISABLED = true;
function codexApproval(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value === "full-access") return "never";
  if (value === "auto") return "untrusted";
  if (value === "ask" || value === "read-only") return "on-request";
  if (["untrusted", "on-request", "never"].includes(value)) return value;
  throw new RpcError(400, "Unsupported Codex approval preset");
}
function codexPresetSandbox(value: string | undefined): string | undefined {
  if (value === "full-access") return "danger-full-access";
  if (value === "auto" || value === "ask") return "workspace-write";
  if (value === "read-only") return "read-only";
  return undefined;
}
function codexSandbox(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (["read-only", "workspace-write", "danger-full-access"].includes(value)) return value;
  throw new RpcError(400, "Unsupported Codex sandbox mode");
}
function claudePermission(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value === "default") return undefined;
  if (["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"].includes(value)) return value;
  throw new RpcError(400, "Unsupported Claude permission mode");
}
function settingValue(value: unknown, label: string, maxLength = 128): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new RpcError(400, `${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > maxLength || normalized.includes("\0")) throw new RpcError(400, `Invalid ${label.toLocaleLowerCase()}`);
  return normalized;
}
function reasoningEffort(value: unknown): string | undefined {
  const effort = settingValue(value, "Reasoning effort", 32);
  if (effort && !/^[0-9A-Za-z_-]+$/.test(effort)) throw new RpcError(400, "Invalid reasoning effort");
  return effort;
}
const CODEX_REASONING_EFFORT_SET = new Set<string>(CODEX_REASONING_EFFORTS);
function codexReasoningEffort(value: unknown): string | undefined {
  const effort = reasoningEffort(value);
  if (effort && !CODEX_REASONING_EFFORT_SET.has(effort)) {
    throw new RpcError(400, `Unsupported Codex reasoning effort: ${effort}`);
  }
  return effort;
}
function codexServiceTier(value: unknown): string | undefined {
  const tier = settingValue(value, "Codex service tier", 32);
  if (tier && tier !== "priority") throw new RpcError(400, `Unsupported Codex service tier: ${tier}`);
  return tier;
}
function storedCodexServiceTier(value: unknown): string | null | undefined {
  // Persisted "standard" is an explicit Fast-off choice. Keep sending null
  // so a restarted app-server cannot silently re-inherit global Fast config.
  if (value === "standard") return null;
  return codexServiceTier(value);
}

const CLAUDE_EFFORTS: AgentSelectOption[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
];
const CLAUDE_PERMISSIONS: AgentSelectOption[] = [
  { value: "auto", label: "Auto", description: "Claude chooses when to ask." },
  { value: "acceptEdits", label: "Accept edits", description: "Automatically accepts file edits." },
  { value: "manual", label: "Manual", description: "Requires explicit approvals." },
  { value: "dontAsk", label: "Don't ask", description: "Denies actions that require approval." },
  { value: "plan", label: "Plan", description: "Read-only planning mode." },
  { value: "bypassPermissions", label: "Bypass permissions", description: "Skips permission prompts. Use only in a trusted environment." },
];
function claudeCapabilities(prefs: PrefsBlob): AgentCapabilities {
  return {
    agent: "claude",
    models: [
      ...["deepseek-v4-pro", "deepseek-v4-flash"].map(value => ({
        value,
        label: value,
        supportedEfforts: CLAUDE_EFFORTS.map(option => ({ ...option })),
      })),
      ...["sonnet", "opus", "haiku"].map(value => ({
        value,
        label: value[0]!.toUpperCase() + value.slice(1),
        supportedEfforts: CLAUDE_EFFORTS.map(option => ({ ...option })),
      })),
    ],
    permissionModes: CLAUDE_PERMISSIONS.map(option => ({ ...option })),
    sandboxModes: [],
    defaults: {
      model: prefs.defaultClaudeModel || null,
      // External default: the CLI's own env (CLAUDE_CODE_EFFORT_LEVEL from
      // ~/.claude/settings.json) wins when the webui pref is unset.
      effort: prefs.defaultClaudeEffort || process.env.CLAUDE_CODE_EFFORT_LEVEL || null,
      permissionMode: prefs.defaultClaudePermissionMode || null,
      sandboxMode: null,
    },
  };
}
const ATTACHMENT_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]);
const NOTIFICATION_APPEND_CHUNK_BYTES = 512 * 1024;
const NOTIFICATION_TRAILING_MAX_CHARS = 512 * 1024;
const FOREIGN_STATUS_MIN_INTERVAL_MS = 750;

export function decodeAttachmentPayload(raw: unknown): { name?: string; type: string; data: string; bytes: Buffer } {
  const item = asRecord(raw);
  const declared = asString(item?.type) ?? asString(item?.mediaType) ?? asString(item?.mime);
  const payload = asString(item?.data);
  if (!declared || !payload || !ATTACHMENT_TYPES.has(declared)) throw new RpcError(415, "Only PNG, JPEG, GIF, WebP, and PDF attachments are supported");
  const comma = payload.indexOf(",");
  const header = comma >= 0 ? payload.slice(0, comma) : null;
  const data = comma >= 0 ? payload.slice(comma + 1) : payload;
  if ((header !== null && header !== `data:${declared};base64`)
    || !data
    || data.length % 4 === 1
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new RpcError(400, "Attachment must contain matching base64 data");
  }
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new RpcError(413, "Attachment exceeds 10 MiB");
  return { name: asString(item?.name), type: declared, data, bytes };
}

export function decodeAvatarPayload(raw: unknown): Buffer {
  const body = asRecord(raw);
  const data = asString(body?.data);
  if (!data) throw new RpcError(400, "Avatar image is required");
  const decoded = decodeAttachmentPayload({ type: "image/png", data });
  if (decoded.bytes.length > 2 * 1024 * 1024) {
    throw new RpcError(413, "Avatar image exceeds 2 MiB");
  }
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (
    decoded.bytes.length < 24
    || !decoded.bytes.subarray(0, pngSignature.length).equals(pngSignature)
    || decoded.bytes.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new RpcError(415, "Avatar must be a valid PNG image");
  }
  const width = decoded.bytes.readUInt32BE(16);
  const height = decoded.bytes.readUInt32BE(20);
  if (!width || !height || width > 2048 || height > 2048) {
    throw new RpcError(413, "Avatar dimensions must be between 1 and 2048 pixels");
  }
  return decoded.bytes;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const home = resolve(options.home ?? homedir());
  const stateDir = resolve(options.stateDir ?? join(home, ".agent-webui"));
  const claudeRoot = resolve(options.claudeRoot ?? join(home, ".claude", "projects"));
  const codexRoot = resolve(options.codexRoot ?? join(home, ".codex", "sessions"));
  const frontendDist = resolve(options.frontendDist ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "frontend", "dist"));
  const token = await resolveToken(options.tokenPath ?? join(stateDir, "token"), options.token);
  await mkdir(stateDir, { recursive: true });
  await configureLineIndexPersistence(join(stateDir, "line-index.json"));

  const app = Fastify({ logger: options.logger ?? false, logController: new LogController({ disableRequestLogging: REQUEST_LOGGING_DISABLED }), bodyLimit: 64 * 1024 * 1024, requestTimeout: 30_000 });
  await app.register(cookie);
  await app.register(compress, { global: true });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 * 1024 } });

  const index = new SessionIndex({
    claudeRoot,
    codexRoot,
    cachePath: join(stateDir, "session-index.json"),
    deferColdPreviews: options.startWatchers !== false,
    coldScanPaceMs: options.sessionColdScanPaceMs ?? (options.startWatchers === false ? 0 : undefined),
  });
  const state = new AppState(stateDir);
  void state.cleanupStalePendingAttachments().then(failures => {
    if (failures.length) app.log.warn({ failures }, "Some stale attachment batches could not be cleaned");
  }).catch(error => {
    app.log.warn({ err: error }, "Stale attachment cleanup failed");
  });
  state.claudeBinary = options.claudeBinary ?? "claude";
  state.titleGenerator = options.titleGenerator
    ?? new CodexSessionTitleGenerator(options.codexBinary ?? "codex").generate;
  const contentSearchIndex = await ContentSearchIndex.open(
    join(stateDir, "content-search-v6.sqlite"),
    event => {
      if (event.type === "error") app.log.warn({ contentSearchIndex: event }, "Content search index update failed");
      else if (event.type === "disabled") app.log.warn({ contentSearchIndex: event }, "Content search index disabled");
      else app.log.info({ contentSearchIndex: event }, "Content search index progress");
    },
  );
  if (contentSearchIndex) {
    for (const name of [
      "content-search.sqlite",
      "content-search.sqlite-wal",
      "content-search.sqlite-shm",
      "content-search-v5.sqlite",
      "content-search-v5.sqlite-wal",
      "content-search-v5.sqlite-shm",
    ]) {
      try {
        await unlink(join(stateDir, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          app.log.warn({ err: error, name }, "Obsolete content search cache cleanup failed");
        }
      }
    }
  }
  const pubsub = new PubSub();
  const claude = new ClaudeDriver(options.claudeBinary ?? "claude", options.claudeSessionsDir ?? join(home, ".claude", "sessions"), state);
  const claudeProcesses = new ClaudeProcessObserver(options.claudeSessionsDir ?? join(home, ".claude", "sessions"));
  claude.setForeignAttachmentLookup(sessionId => claudeProcesses.foreignAttachment(sessionId));
  const codex = new CodexDriver(options.codexBinary ?? "codex", state);
  claude.on("driver-error", event => app.log.warn({ agent: "claude", event }, "Agent driver reported a recoverable error"));
  codex.on("driver-error", event => app.log.warn({ agent: "codex", event }, "Agent driver reported a recoverable error"));
  const previews = new PreviewStore(join(stateDir, "previews"));
  // Source/image reads are restricted to discovered or explicitly normalized
  // working directories. The home directory is only a navigation root.
  const extraRoots = new Set<string>();
  const explicitRoots = new Set<string>();
  const sessionCwds = new Map<string, string>();
  const cwdUseCounts = new Map<string, number>();
  const subscriptions = new Map<WebSocket, Map<string, JsonlTailer>>();
  const searchControllers = new Map<WebSocket, AbortController>();
  const idle = new Map<WebSocket, NodeJS.Timeout>();
  const lastSizes = new Map<string, number>();
  const notificationTrailing = new Map<string, string>();
  const notificationUuids = new NotificationDeduper(1024);
  const foreignClaudeSessions = new Set<string>();
  const notificationWork = new Map<string, Promise<void>>();
  const notificationPending = new Map<string, SessionRecord>();
  const autoTitleWork = new Set<string>();
  const autoTitlePending = new Map<string, { requests: string[]; turns: number }>();
  const autoTitleTurns = new Map<string, number>();
  const autoTitleCycleRequests = new Map<string, string[]>();
  const autoTitleAnchorRequests = new Map<string, { requests: string[]; size: number }>();
  const titleMutationWork = new Map<string, Promise<void>>();
  const recentAutoTitlePrompts = new Map<string, string[]>();
  const newSessionResults = new Map<string, { sessionId: string }>();
  const newSessionRequests = new Map<string, Promise<{ sessionId: string }>>();
  const deletedSessionIds = new Set<string>();
  const bulkRetitleQueue: string[] = [];
  const bulkRetitleQueued = new Set<string>();
  let bulkRetitleWork: Promise<void> | undefined;
  const foreignStatusWork = new Set<string>();
  const foreignStatusPending = new Set<string>();
  const foreignStatusLastRead = new Map<string, number>();
  const foreignStatusTimers = new Map<string, NodeJS.Timeout>();
  const canonicalCodexTitles = new Map<string, string | null>();
  let codexTitleListWork: Promise<void> | undefined;
  let codexTitleListLoaded = false;
  let codexTitleRetryAfter = 0;
  let closing = false;
  // Historical background-task reconstruction is deliberately lazy. Eagerly
  // reading 5,000 lines from every Claude transcript at startup caused hundreds
  // of full JSONL index builds to run together on installations with a large
  // session archive, saturating disk and making the whole machine unresponsive.
  const taskHistoryLoaded = new Set<string>();
  // The initial archive is historical state, not hundreds of simultaneous
  // "new chat" events. In particular, do not run the auto-titler (and perform
  // one atomic titles.json write) for every row during cold discovery.
  let initialDiscoveryComplete = false;
  const taskHistoryWork = new Map<string, Promise<void>>();

  function trackSessionRoot(session: Pick<SessionRecord, "id" | "cwd">): void {
    const previous = sessionCwds.get(session.id);
    if (previous === session.cwd) return;
    if (previous) {
      const count = (cwdUseCounts.get(previous) ?? 1) - 1;
      if (count > 0) cwdUseCounts.set(previous, count);
      else {
        cwdUseCounts.delete(previous);
        if (!explicitRoots.has(previous)) extraRoots.delete(previous);
      }
    }
    sessionCwds.set(session.id, session.cwd);
    cwdUseCounts.set(session.cwd, (cwdUseCounts.get(session.cwd) ?? 0) + 1);
    extraRoots.add(session.cwd);
  }
  function untrackSessionRoot(sessionId: string): void {
    const cwd = sessionCwds.get(sessionId);
    if (!cwd) return;
    sessionCwds.delete(sessionId);
    const count = (cwdUseCounts.get(cwd) ?? 1) - 1;
    if (count > 0) cwdUseCounts.set(cwd, count);
    else {
      cwdUseCounts.delete(cwd);
      if (!explicitRoots.has(cwd)) extraRoots.delete(cwd);
    }
  }

  async function applyCanonicalCodexTitle(
    sessionId: string,
    name: string | null,
    localTitles?: Awaited<ReturnType<typeof state.titles.get>>,
  ): Promise<void> {
    const session = index.get(sessionId);
    if (!session || session.agent !== "codex") return;
    const titles = localTitles ?? await state.titles.get();
    const before = resolveSessionTitle("codex", titles[sessionId], canonicalCodexTitles.get(sessionId));
    canonicalCodexTitles.set(sessionId, name);
    const after = resolveSessionTitle("codex", titles[sessionId], name);
    if (before.title !== after.title || before.source !== after.source || before.emoji !== after.emoji) {
      pubsub.push({
        type: "session-renamed",
        kind: "session-renamed",
        id: sessionId,
        title: after.title,
        titleSource: after.source,
        emoji: after.emoji ?? null,
      });
    }
  }

  async function serializeTitleMutation<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = titleMutationWork.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    titleMutationWork.set(sessionId, tail);
    try {
      return await result;
    } finally {
      if (titleMutationWork.get(sessionId) === tail) titleMutationWork.delete(sessionId);
    }
  }

  async function publishAutoTitle(session: SessionRecord, title: string): Promise<{
    title: string | null;
    titleSource: "auto" | "manual" | null;
    emoji: string | null;
  }> {
    return serializeTitleMutation(session.id, async () => {
      const titles = await state.titles.get();
      const entry = titles[session.id];
      if (session.agent === "codex" && entry?.source !== "manual") {
        const canonical = formatTitleWithEmoji(title, entry?.emoji);
        // Update the cache before the RPC. App-server may synchronously emit
        // thread/name/updated before thread/name/set resolves; the optimistic
        // value makes that echo a no-op, leaving one deliberate rename push
        // below instead of two flickering updates.
        canonicalCodexTitles.set(session.id, canonical);
        try {
          await codex.setThreadName(session.id, canonical);
        } catch (error) {
          // Prefer the freshly generated local entry in this WebUI when the
          // canonical write fails, instead of snapping back to a stale name.
          canonicalCodexTitles.set(session.id, null);
          app.log.warn(
            { sessionId: session.id, error },
            "Codex title was generated locally but its canonical thread name could not be updated",
          );
        }
      }
      const resolved = resolveSessionTitle(
        session.agent,
        entry,
        canonicalCodexTitles.get(session.id),
      );
      pubsub.push({
        type: "session-renamed",
        kind: "session-renamed",
        id: session.id,
        title: resolved.title,
        titleSource: resolved.source,
        emoji: resolved.emoji ?? null,
      });
      return {
        title: resolved.title,
        titleSource: resolved.source,
        emoji: resolved.emoji ?? null,
      };
    });
  }

  function ensureCodexThreadNames(): void {
    if (options.startWatchers === false || closing || codexTitleListLoaded || codexTitleListWork || Date.now() < codexTitleRetryAfter) return;
    codexTitleListWork = (async () => {
      const [names, localTitles] = await Promise.all([codex.threadNames(), state.titles.get()]);
      if (closing) return;
      for (const [sessionId, name] of names) {
        await applyCanonicalCodexTitle(sessionId, name, localTitles);
      }
      codexTitleListLoaded = true;
    })().catch(() => {
      codexTitleRetryAfter = Date.now() + 60_000;
    }).finally(() => {
      codexTitleListWork = undefined;
    });
  }

  const sessionView = async () => {
    // Canonical Codex names are deliberately lazy: starting the backend alone
    // must not spawn the app-server. The first session-list consumer starts one
    // bounded background snapshot and receives incremental rename pushes.
    ensureCodexThreadNames();
    const [titles, reads] = await Promise.all([state.titles.get(), state.reads.get()]);
    return index.list().map(session => {
      const resolvedTitle = resolveSessionTitle(session.agent, titles[session.id], canonicalCodexTitles.get(session.id));
      return {
        ...session,
        path: undefined,
        title: resolvedTitle.title,
        titleSource: resolvedTitle.source,
        titleEmoji: resolvedTitle.emoji ?? null,
        readAt: reads[session.id]?.at ?? null,
        peer: foreignClaudeSessions.has(session.id),
        ...state.status.get(session.id),
      };
    });
  };
  async function inferForeignClaudeTurn(session: SessionRecord, maxAgeMs = 10 * 60_000): Promise<boolean> {
    const lines = await readTail(session.path, 80).catch(() => []);
    for (let index = lines.length - 1; index >= 0; index--) {
      try {
        const record = asRecord(JSON.parse(lines[index]!.raw)); if (!record || record.isSidechain === true || record.isMeta === true) continue;
        const type = asString(record.type); const message = asRecord(record.message); const subtype = asString(record.subtype);
        if (type === "system" && ["turn_duration", "turn_complete", "api_error", "compact_boundary"].includes(subtype ?? "")) return false;
        if (type !== "user" && type !== "assistant") continue;
        const timestamp = Date.parse(asString(record.timestamp) ?? "");
        if (!Number.isFinite(timestamp) || Date.now() - timestamp > maxAgeMs) return false;
        if (type === "assistant" && message?.stop_reason != null) return false;
        return true;
      } catch { /* malformed tail record */ }
    }
    return false;
  }
  async function rebuildClaudeTasks(session: SessionRecord): Promise<void> {
    if (session.agent !== "claude") return;
    let tasks: ReturnType<typeof mergeClaudeBackgroundTasks> = [];
    for (const line of await readTail(session.path, 5000).catch(() => [])) {
      try { tasks = mergeClaudeBackgroundTasks(tasks, JSON.parse(line.raw)); } catch { /* isolate */ }
    }
    if (index.get(session.id)?.path !== session.path) return;
    const current = (state.tasks.get(session.id) ?? []) as BackgroundTaskRecord[];
    if (current.length) {
      const byId = new Map(tasks.map(task => [task.id, task]));
      for (const task of current) byId.set(task.id, task);
      tasks = [...byId.values()];
    }
    if (!tasks.length) return;
    state.tasks.set(session.id, tasks);
    pubsub.push(backgroundTasksPush(session.id, tasks));
  }
  async function ensureTaskHistory(session: SessionRecord): Promise<void> {
    if (session.agent !== "claude" || taskHistoryLoaded.has(session.id)) return;
    const existing = taskHistoryWork.get(session.id);
    if (existing) return existing;
    const work = rebuildClaudeTasks(session)
      .then(() => {
        if (index.get(session.id)?.path === session.path) taskHistoryLoaded.add(session.id);
      })
      .finally(() => taskHistoryWork.delete(session.id));
    taskHistoryWork.set(session.id, work);
    return work;
  }

  function loginPage(reply: FastifyReply, message = "Paste the local access token to continue."): FastifyReply {
    const safeMessage = escapeHtml(message);
    return reply
      .code(401)
      .header("Cache-Control", "no-store")
      .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
      .type("text/html; charset=utf-8")
      .send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Agent WebUI sign in</title>
  <style>
    :root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    *{box-sizing:border-box}
    body{min-height:100vh;margin:0;display:grid;place-items:center;background:#111;color:#ededed;padding:24px}
    main{width:min(420px,100%);border:1px solid #333;background:#1f1f1f;padding:24px}
    h1{font-size:20px;margin:0 0 8px}p{margin:0 0 18px;color:#aaa;line-height:1.5}
    label{display:block;font-size:13px;margin-bottom:7px;color:#ccc}
    input{width:100%;height:42px;border:1px solid #4d4d4d;background:#111;color:#fff;padding:0 11px;font:inherit;outline:none}
    input:focus{border-color:#1aad19}
    button{width:100%;height:40px;margin-top:12px;border:0;background:#1aad19;color:#06130d;font:600 14px inherit;cursor:pointer}
  </style>
</head>
<body>
  <main>
    <h1>Agent WebUI</h1>
    <p>${safeMessage}</p>
    <form method="get" action="/">
      <label for="token">Access token</label>
      <input id="token" name="token" type="password" required autofocus autocomplete="current-password" spellcheck="false">
      <button type="submit">Sign in</button>
    </form>
  </main>
</body>
</html>`);
  }

  app.addHook("onRequest", async (request, reply) => {
    const path = rawPath(request);
    const capability = /^(?:\/preview\/[0-9a-f]{8}-[0-9a-f-]{27}\/index\.html)$/i.test(path);
    const bind = request.method === "GET" && path === "/api/auth/bind";
    const rootBind = request.method === "GET" && path === "/" && typeof (request.query as Record<string, unknown>)?.token === "string";
    if (capability || bind || rootBind || path === "/ws/main") return;
    if (!timingSafeToken(token, requestToken(request))) {
      const acceptsHtml = request.method === "GET"
        && !path.startsWith("/api/")
        && path !== "/api"
        && !path.startsWith("/assets/")
        && String(request.headers.accept ?? "").includes("text/html");
      if (acceptsHtml) return loginPage(reply);
      await reply.code(401).send({ error: "Authentication required" });
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (reply.sent) return;
    const code = error instanceof RpcError ? error.code : ((error as { statusCode?: number }).statusCode ?? 500);
    void reply.code(code >= 400 && code <= 599 ? code : 500).send({ error: error instanceof Error ? error.message : "Internal server error" });
  });

  let indexCache: { mtime: number; html: string } | undefined;
  async function spa(reply: FastifyReply): Promise<FastifyReply> {
    const path = join(frontendDist, "index.html");
    reply
      .header("Content-Security-Policy", "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Content-Type-Options", "nosniff");
    try {
      const info = await stat(path);
      if (!indexCache || indexCache.mtime !== info.mtimeMs) indexCache = { mtime: info.mtimeMs, html: await readFile(path, "utf8") };
      return reply
        .header("Cache-Control", "no-cache")
        .type("text/html; charset=utf-8")
        .send(indexCache.html);
    } catch {
      return reply
        .code(503)
        .type("text/html")
        .send("<!doctype html><title>Agent WebUI</title><p>Frontend build is unavailable. Run npm run build.</p>");
    }
  }

  app.get("/", async (request, reply) => {
    const supplied = (request.query as Record<string, unknown>)?.token;
    if (supplied !== undefined) {
      if (!timingSafeToken(token, supplied)) return loginPage(reply, "That token is invalid. Check the startup URL and try again.");
      setTokenCookie(reply, token); reply.redirect("/"); return;
    }
    if (!timingSafeToken(token, requestToken(request))) return loginPage(reply);
    return spa(reply);
  });
  app.get("/api/auth/bind", async (request, reply) => {
    const supplied = (request.query as Record<string, unknown>)?.token;
    if (!timingSafeToken(token, supplied)) return reply.code(401).send({ error: "Invalid token" });
    setTokenCookie(reply, token); return { ok: true };
  });
  app.get("/api/me", async () => ({ home }));
  app.get("/api/me/avatar", async (_request, reply) => {
    reply.header("Cache-Control", "private, no-cache");
    try { return reply.type("image/png").send(await readFile(join(stateDir, "me-avatar.png"))); }
    catch {
      const initials = escapeHtml(basename(home).slice(0, 2).toUpperCase());
      return reply.type("image/svg+xml").send(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="8" fill="#1aad19"/><text x="48" y="61" text-anchor="middle" font-family="sans-serif" font-size="36" fill="#07180d">${initials}</text></svg>`);
    }
  });
  app.put("/api/me/avatar", async request => {
    const bytes = decodeAvatarPayload(request.body);
    await writeFile(join(stateDir, "me-avatar.png"), bytes, { mode: 0o600 });
    return { ok: true };
  });
  app.delete("/api/me/avatar", async () => {
    try {
      await unlink(join(stateDir, "me-avatar.png"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { ok: true };
  });
  app.get("/api/sessions", sessionView);
  app.get("/api/sessions/:id/tail", async request => {
    const { id } = request.params as { id: string }; assertSessionId(id); const session = await index.resolveLight(id); if (!session) throw new RpcError(404, "Session not found");
    const query = request.query as Record<string, unknown>;
    const priority = query.priority === "interactive" ? "interactive" : "background";
    const snapshot = await readTailSnapshot(session.path, Number(query.n ?? 200), priority);
    const filtered = session.agent === "claude" ? preserveIndexes(snapshot.lines, isRenderableClaudeLine) : snapshot.lines;
    return {
      totalLines: snapshot.lineCount,
      fromIndex: filtered[0]?.index ?? snapshot.lineCount,
      lines: sanitizeTranscriptLines(id, filtered),
      supportsCompactRange: true,
    };
  });
  app.get("/api/sessions/:id/range", async request => {
    const { id } = request.params as { id: string }; assertSessionId(id); const session = await index.resolveLight(id); if (!session) throw new RpcError(404, "Session not found");
    const query = request.query as Record<string, unknown>;
    const compact = query.mode === "compact";
    const lines = await readRange(
      session.path,
      Number(query.from ?? 0),
      query.to === undefined ? undefined : Number(query.to),
      compact ? {
        maxBytes: COMPACT_RANGE_MAX_BYTES,
        maxRecordBytes: COMPACT_RANGE_MAX_RECORD_BYTES,
        priority: "background",
      } : undefined,
    );
    const filtered = session.agent === "claude" ? preserveIndexes(lines, isRenderableClaudeLine) : lines;
    return {
      totalLines: await countJsonlLines(session.path),
      lines: sanitizeTranscriptLines(id, filtered),
    };
  });
  app.get("/api/sessions/:id/context-usage", async request => {
    const { id } = request.params as { id: string };
    assertSessionId(id);
    const session = await index.resolveLight(id);
    if (!session) throw new RpcError(404, "Session not found");
    if (session.agent !== "codex") throw new RpcError(400, "Context usage scan is only available for Codex sessions");
    const query = request.query as Record<string, unknown>;
    const rawLimit = query.autoCompactLimit;
    const configuredLimit = rawLimit === undefined || rawLimit === ""
      ? null
      : Number(rawLimit);
    if (configuredLimit !== null && (!Number.isFinite(configuredLimit) || configuredLimit <= 0)) {
      throw new RpcError(400, "autoCompactLimit must be a positive number");
    }
    return fullCodexContextUsage(session.path, configuredLimit);
  });

  const objectBody = (request: FastifyRequest) => asRecord(request.body) ?? {};
  interface PreparedAttachments {
    files: unknown[];
    batchId?: string;
  }
  async function attachments(value: unknown, agent: "claude" | "codex"): Promise<PreparedAttachments> {
    if (!Array.isArray(value)) return { files: [] };
    const maxCount = agent === "codex" ? MAX_CODEX_PROMPT_ATTACHMENTS : MAX_CLAUDE_PROMPT_ATTACHMENTS;
    if (value.length > maxCount) throw new RpcError(413, `Too many attachments (max ${maxCount})`);
    const decoded = value.map(decodeAttachmentPayload);
    const totalBytes = decoded.reduce((total, item) => total + item.bytes.length, 0);
    if (totalBytes > MAX_PROMPT_ATTACHMENT_BYTES) throw new RpcError(413, "Attachments exceed the 40 MiB request limit");
    if (agent === "claude") {
      return { files: decoded.map(item => ({ name: item.name, type: item.type, data: item.data })) };
    }
    if (decoded.some(item => !item.type.startsWith("image/"))) {
      throw new RpcError(501, "This Codex app-server accepts local images but not PDF inputs");
    }
    if (!decoded.length) return { files: [] };

    const batch = await state.createAttachmentBatch();
    try {
      const files: string[] = [];
      for (const item of decoded) {
        const extension = item.type === "image/png" ? ".png" : item.type === "image/webp" ? ".webp" : item.type === "image/gif" ? ".gif" : ".jpg";
        const path = join(batch.directory, `${crypto.randomUUID()}${extension}`);
        await writeFile(path, item.bytes, { mode: 0o600 });
        const actualPath = await realpath(path);
        if (!isWithin(batch.directory, actualPath)) throw new RpcError(403, "Unsafe attachment path");
        files.push(actualPath);
      }
      return { files, batchId: batch.batchId };
    } catch (error) {
      await state.discardAttachmentBatch(batch.batchId).catch(cleanupError => {
        app.log.error({ err: cleanupError, batchId: batch.batchId }, "Failed to clean rejected attachment batch");
      });
      throw error;
    }
  }
  async function discardFailedAttachments(batchId: string | undefined): Promise<void> {
    if (!batchId) return;
    try {
      await state.discardAttachmentBatch(batchId);
    } catch (error) {
      app.log.error({ err: error, batchId }, "Failed to clean attachment batch after request failure");
    }
  }
  async function claimAttachments(batchId: string | undefined, sessionId: string, attempt = 0): Promise<void> {
    if (!batchId) return;
    try {
      await state.claimAttachmentBatch(batchId, sessionId);
    } catch (error) {
      app.log.error({ err: error, batchId, sessionId, attempt }, "Failed to persist accepted attachment ownership");
      // The provider may still be reading these paths. Never turn a successful
      // provider mutation into a client-visible failure (which would invite a
      // duplicate retry), and never delete the files. Retry manifest ownership
      // in the background so later session deletion can reclaim them.
      if (!closing && attempt < 4) {
        const timer = setTimeout(
          () => void claimAttachments(batchId, sessionId, attempt + 1),
          Math.min(60_000, 1_000 * (10 ** attempt)),
        );
        timer.unref?.();
      }
    }
  }
  async function normalizeCwd(input: unknown): Promise<string> {
    if (typeof input !== "string" || input.includes("\0")) throw new RpcError(400, "Invalid working directory");
    let actual: string; try { actual = await realpath(resolve(expandHome(input, home))); } catch { throw new RpcError(404, "Working directory does not exist"); }
    const info = await stat(actual); if (!info.isDirectory()) throw new RpcError(400, "Working directory is not a directory");
    explicitRoots.add(actual);
    extraRoots.add(actual);
    return actual;
  }
  async function newSessionOnce(args: Record<string, unknown>): Promise<{ sessionId: string }> {
    const cwd = await normalizeCwd(args.cwd); const prompt = asString(args.prompt) ?? ""; const agent = args.agent === "codex" ? "codex" : "claude";
    const prepared = await attachments(args.images, agent);
    const files = prepared.files;
    const prefs = await state.prefs.get();
    if (agent === "codex") {
      let accepted = false;
      try {
        const permissionMode = settingValue(args.permissionMode, "Codex approval") ?? prefs.defaultCodexApprovalPreset;
        const hasServiceTierOverride = Object.prototype.hasOwnProperty.call(args, "serviceTier");
        const serviceTier = hasServiceTierOverride
          ? codexServiceTier(args.serviceTier) ?? null
          : codexServiceTier(prefs.defaultCodexServiceTier);
        const result = await codex.newSession(cwd, prompt, {
          model: settingValue(args.model, "Model") ?? settingValue(prefs.defaultCodexModel, "Model"),
          effort: codexReasoningEffort(args.effort) ?? codexReasoningEffort(prefs.defaultCodexEffort),
          serviceTier,
          approvalPolicy: codexApproval(permissionMode),
          sandboxMode: codexSandbox(
            settingValue(args.sandboxMode, "Codex sandbox") ??
            codexPresetSandbox(permissionMode) ??
            prefs.defaultCodexSandboxMode,
          ),
          cwd,
        }, files as string[]);
        // Once Codex accepts the turn it may still be reading these paths.
        // A later manifest/settings failure must leave the pending batch in
        // place for retry/stale cleanup, never remove files from under Codex.
        accepted = true;
        await claimAttachments(prepared.batchId, result.sessionId);
        if (hasServiceTierOverride || serviceTier) {
          await state.settings.update(all => {
            const current = all[result.sessionId] ?? {};
            current.serviceTier = serviceTier ?? "standard";
            all[result.sessionId] = current;
          });
          pubsub.push({
            type: "session-settings",
            kind: "session-settings",
            id: result.sessionId,
            ...(await state.settings.get())[result.sessionId],
          });
        }
        return result;
      } catch (error) {
        if (!accepted) await discardFailedAttachments(prepared.batchId);
        throw error;
      }
    }
    if (!prompt && !files.length) throw new RpcError(400, "Claude requires a prompt or attachment when materializing a session");
    return claude.newSession(cwd, prompt, {
      model: settingValue(args.model, "Model") ?? settingValue(prefs.defaultClaudeModel, "Model"),
      effort: reasoningEffort(args.effort) ?? reasoningEffort(prefs.defaultClaudeEffort),
      permissionMode: claudePermission(settingValue(args.permissionMode, "Claude permission") ?? prefs.defaultClaudePermissionMode),
      images: files,
    });
  }
  async function newSession(args: Record<string, unknown>): Promise<{ sessionId: string }> {
    const clientUuid = asString(args.clientUuid)?.trim();
    if (clientUuid !== undefined && (!clientUuid || clientUuid.length > 200)) {
      throw new RpcError(400, "Invalid new-session idempotency key");
    }
    if (!clientUuid) return newSessionOnce(args);
    const agent = args.agent === "codex" ? "codex" : "claude";
    const key = `${agent}:${clientUuid}`;
    return runIdempotentRequest(newSessionResults, newSessionRequests, key, () => newSessionOnce(args));
  }
  async function promptSession(id: string, args: Record<string, unknown>) {
    assertSessionId(id); const session = await index.resolveLight(id); if (!session) throw new RpcError(404, "Session not found");
    assertDirectPromptAllowed(session);
    const prompt = asString(args.prompt) ?? ""; const prepared = await attachments(args.images, session.agent); const files = prepared.files; if (!prompt.trim() && !files.length) throw new RpcError(400, "Prompt is empty");
    const settings = (await state.settings.get())[id]; const prefs = await state.prefs.get();
    let accepted = false;
    try {
      const permissionMode = settingValue(args.permissionMode, "Codex approval") ?? settings?.permissionMode ?? prefs.defaultCodexApprovalPreset;
      const result = session.agent === "codex"
        ? await codex.prompt(id, prompt, {
          model: settingValue(args.model, "Model") ?? settings?.model ?? prefs.defaultCodexModel,
          effort: codexReasoningEffort(args.effort) ?? codexReasoningEffort(settings?.effort) ?? codexReasoningEffort(prefs.defaultCodexEffort),
          serviceTier: codexServiceTier(args.serviceTier) ?? storedCodexServiceTier(settings?.serviceTier),
          approvalPolicy: codexApproval(permissionMode),
          sandboxMode: codexSandbox(
            settingValue(args.sandboxMode, "Codex sandbox") ??
            codexPresetSandbox(permissionMode) ??
            settings?.sandboxMode ??
            prefs.defaultCodexSandboxMode,
          ),
          cwd: session.cwd,
        }, files as string[], asString(args.clientUuid))
        : await claude.prompt(id, session.cwd, prompt, {
          model: settingValue(args.model, "Model") ?? settings?.model ?? prefs.defaultClaudeModel,
          effort: reasoningEffort(args.effort) ?? settings?.effort ?? prefs.defaultClaudeEffort,
          permissionMode: claudePermission(settingValue(args.permissionMode, "Claude permission") ?? settings?.permissionMode ?? prefs.defaultClaudePermissionMode),
          clientUuid: asString(args.clientUuid),
          images: files,
        });
      // See newSession: only a driver rejection is safe to clean immediately.
      accepted = true;
      await claimAttachments(prepared.batchId, id);
      return result;
    } catch (error) {
      if (!accepted) await discardFailedAttachments(prepared.batchId);
      throw normalizeDirectPromptError(error);
    }
  }
  async function stopSession(id: string) {
    assertSessionId(id); const session = await index.resolveLight(id); if (!session) throw new RpcError(404, "Session not found");
    if (session.agent === "codex") await codex.stop(id); else claude.stop(id); return { ok: true };
  }
  app.post("/api/sessions/new", async request => newSession(objectBody(request)));
  app.post("/api/sessions/:id/prompt", async request => promptSession((request.params as { id: string }).id, objectBody(request)));
  app.post("/api/sessions/:id/stop", async request => stopSession((request.params as { id: string }).id));
  app.get("/api/preferences", async () => state.prefs.get());
  app.put("/api/preferences", async request => { await state.prefs.put(normalizePrefs(request.body)); return { ok: true }; });
  app.post("/api/refresh", async () => { await index.scan(); return { sessions: await sessionView() }; });
  app.get("/api/sessions/:id/export", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    assertSessionId(id);
    const session = await index.resolveLight(id);
    if (!session) throw new RpcError(404, "Session not found");
    const local = (await state.titles.get())[id];
    const resolved = resolveSessionTitle(session.agent, local, canonicalCodexTitles.get(id));
    const markdown = await markdownExport(index, id, resolved.title ?? undefined);
    reply.header("Content-Disposition", `attachment; filename="${id}.md"`).type("text/markdown; charset=utf-8").send(markdown);
  });
  app.get("/api/local-file", async request => {
    const query = request.query as Record<string, unknown>; return readLocalSource(String(query.path ?? ""), [...extraRoots], query.line === undefined ? undefined : Number(query.line));
  });
  app.get("/api/local-file-content", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const source = await resolveLocalFile(String(query.path ?? ""), [...extraRoots]);
    const download = query.download === "1";
    if (!download && source.size > 256 * 1024 * 1024) throw new RpcError(413, "File exceeds 256 MiB");
    if (!download && !/\.pdf$/i.test(source.path)) {
      throw new RpcError(415, "Only PDF files can be embedded through this endpoint");
    }
    reply
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Length", String(source.size))
      .header(
        "Content-Disposition",
        fileContentDisposition(download ? "attachment" : "inline", source.path),
      )
      .type(download ? "application/octet-stream" : "application/pdf");
    return reply.send(createReadStream(source.path));
  });
  app.get("/local-file", async (request, reply) => {
    const query = request.query as Record<string, unknown>; const source = await readLocalSource(String(query.path ?? ""), [...extraRoots], query.line === undefined ? undefined : Number(query.line));
    reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'").type("text/html").send(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(String(source.name))}</title><style>body{margin:0;font:14px/1.55 ui-monospace,monospace;background:#1f1f1f;color:#eee}pre{padding:16px;white-space:pre-wrap}</style><pre id="source"></pre><script>document.getElementById('source').textContent=${safeBootJson(source.content)}</script>`);
  });
  async function imagePath(sessionId: string, filename: unknown): Promise<string> {
    assertSessionId(sessionId); safeFilename(filename); const session = await index.resolveLight(sessionId); if (!session) throw new RpcError(404, "Session not found");
    const roots = await Promise.all([session.cwd, dirname(session.path)].map(async root => { try { return await realpath(root); } catch { return resolve(root); } }));
    for (const candidate of [join(dirname(session.path), "images", filename), join(session.cwd, filename)]) {
      try { const actual = await realpath(candidate); if (roots.some(root => isWithin(root, actual)) && (await stat(actual)).isFile()) return actual; } catch { /* next */ }
    }
    throw new RpcError(404, "Image not found");
  }
  app.get("/api/images/:sessionId/:filename", async (request, reply) => {
    const params = request.params as { sessionId: string; filename: string }; const path = await imagePath(params.sessionId, params.filename);
    const mime = /\.png$/i.test(path) ? "image/png" : /\.gif$/i.test(path) ? "image/gif" : /\.webp$/i.test(path) ? "image/webp" : "image/jpeg";
    return reply.type(mime).send(await readFile(path));
  });
  const transcriptImage = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as {
      sessionId: string;
      lineIndex: string;
      imageIndex: string;
    };
    assertSessionId(params.sessionId);
    const lineIndex = Number(params.lineIndex);
    const imageIndex = Number(params.imageIndex);
    if (!Number.isSafeInteger(lineIndex) || lineIndex < 0 || !Number.isSafeInteger(imageIndex) || imageIndex < 0 || imageIndex > 31) {
      throw new RpcError(400, "Invalid transcript image location");
    }
    const session = await index.resolveLight(params.sessionId);
    if (!session) throw new RpcError(404, "Session not found");
    // 10 MiB decoded input plus JSON/base64 overhead and a small envelope.
    const line = await readRecordAt(session.path, lineIndex, MAX_JSONL_RECORD_BYTES);
    if (!line || line.index !== lineIndex) throw new RpcError(404, "Transcript image record not found");
    let record: Record<string, unknown> | null = null;
    try { record = asRecord(JSON.parse(line.raw)); } catch { /* handled below */ }
    const payload = record ? transcriptImagePayload(record, imageIndex) : null;
    if (!payload) throw new RpcError(404, "Transcript image not found");
    const decoded = decodeAttachmentPayload(payload);
    if (!decoded.type.startsWith("image/")) throw new RpcError(415, "Transcript attachment is not an image");
    reply
      .header("Cache-Control", "private, max-age=31536000, immutable")
      .header("X-Content-Type-Options", "nosniff");
    return reply.type(decoded.type).send(decoded.bytes);
  };
  // Keep the original route for cached clients while using the broader name
  // for generated/tool-result images as well as user inputs.
  app.get("/api/sessions/:sessionId/input-image/:lineIndex/:imageIndex", transcriptImage);
  app.get("/api/sessions/:sessionId/transcript-image/:lineIndex/:imageIndex", transcriptImage);
  app.get("/api/codex-image", async (request, reply) => {
    const query = request.query as Record<string, unknown>; const path = String(query.path ?? "");
    const source = await resolveLocalFile(path, [...extraRoots]);
    if (!/\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(source.path)) throw new RpcError(415, "Unsupported image type");
    if (source.size > 20 * 1024 * 1024) throw new RpcError(413, "Image is too large");
    const mime = /\.png$/i.test(source.path) ? "image/png"
      : /\.gif$/i.test(source.path) ? "image/gif"
      : /\.webp$/i.test(source.path) ? "image/webp"
      : /\.bmp$/i.test(source.path) ? "image/bmp"
      : /\.avif$/i.test(source.path) ? "image/avif"
      : "image/jpeg";
    return reply.type(mime).send(await readFile(source.path));
  });
  app.get("/api/sessions/:sessionId/visualization/:filename", async (request, reply) => {
    const params = request.params as { sessionId: string; filename: string };
    assertSessionId(params.sessionId);
    safeFilename(params.filename);
    if (!/\.html?$/i.test(params.filename)) throw new RpcError(415, "Visualization must be an HTML file");
    const session = await index.resolveLight(params.sessionId);
    if (!session || session.agent !== "codex") throw new RpcError(404, "Codex session not found");
    const sessionDirectory = dirname(session.path);
    if (!isWithin(codexRoot, sessionDirectory)) throw new RpcError(403, "Session is outside the Codex root");
    const datedDirectory = relative(codexRoot, sessionDirectory);
    const visualizationRoot = resolve(
      dirname(codexRoot),
      "visualizations",
      datedDirectory,
      params.sessionId,
    );
    let actualRoot: string;
    let actual: string;
    try {
      actualRoot = await realpath(visualizationRoot);
      actual = await realpath(join(actualRoot, params.filename));
    } catch {
      throw new RpcError(404, "Visualization not found");
    }
    if (!isWithin(actualRoot, actual)) throw new RpcError(403, "Visualization escapes its session directory");
    const info = await stat(actual);
    if (!info.isFile()) throw new RpcError(404, "Visualization not found");
    if (info.size > 5 * 1024 * 1024) throw new RpcError(413, "Visualization exceeds 5 MiB");
    reply
      .header("Content-Security-Policy", "sandbox allow-scripts; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'")
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "private, no-store")
      .type("text/html; charset=utf-8");
    return reply.send(themedVisualizationHtml(await readFile(actual, "utf8")));
  });
  app.post("/api/preview", async request => {
    const body = objectBody(request); const html = asString(body.html); if (html === undefined) throw new RpcError(400, "Missing HTML"); return previews.create(html);
  });
  app.route({ method: ["GET", "HEAD"], url: "/preview/:uuid/index.html", handler: async (request, reply) => {
    const uuid = (request.params as { uuid: string }).uuid; const data = await previews.read(uuid);
    reply.header("Content-Security-Policy", "sandbox allow-scripts; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'")
      .header("X-Content-Type-Options", "nosniff").header("Cache-Control", "no-store").type("text/html; charset=utf-8");
    return request.method === "HEAD" ? reply.send() : reply.send(data);
  }});

  function resetIdle(socket: WebSocket): void {
    const old = idle.get(socket); if (old) clearTimeout(old);
    const timer = setTimeout(() => socket.close(1001, "Idle timeout"), 120_000); timer.unref?.(); idle.set(socket, timer);
  }
  async function stopSocket(socket: WebSocket): Promise<void> {
    pubsub.remove(socket); const timer = idle.get(socket); if (timer) clearTimeout(timer); idle.delete(socket);
    searchControllers.get(socket)?.abort(); searchControllers.delete(socket);
    const map = subscriptions.get(socket); subscriptions.delete(socket);
    if (map) await Promise.allSettled([...map.values()].map(tailer => tailer.stop()));
  }
  function send(socket: WebSocket, value: unknown): void { sendJson(socket, value); }
  async function subscribeSession(socket: WebSocket, sessionId: string, from: number, tailN?: number): Promise<void> {
    assertSessionId(sessionId); const session = await index.resolveLight(sessionId); if (!session) throw new RpcError(404, "Session not found");
    // Opening a Codex transcript is the strongest signal that the next action
    // may be Send. Attach the shared app-server thread in the background now,
    // while the user is reading, instead of making the prompt RPC pay the
    // full thread/resume latency. CodexDriver coalesces this with a concurrent
    // prompt-side resume, so there is still exactly one writer/attach request.
    if (session.agent === "codex") {
      void codex.resume(sessionId).catch(error => {
        app.log.debug({ err: error, sessionId }, "Codex session prewarm failed");
      });
    }
    let map = subscriptions.get(socket); if (!map) { map = new Map(); subscriptions.set(socket, map); }
    const previous = map.get(sessionId); map.delete(sessionId); if (previous) void previous.stop();
    const tailer = new JsonlTailer(session.path, {
      from: Math.max(0, from),
      tailN,
      filter: session.agent === "claude" ? isRenderableClaudeLine : undefined,
    }, event => {
      if (event.type === "stream-line") {
        send(socket, {
          ...event,
          sessionId,
          data: sanitizeTranscriptRaw(event.data, sessionId, event.index),
        });
      } else if (event.type === "stream-batch") {
        send(socket, {
          ...event,
          sessionId,
          lines: sanitizeTranscriptLines(sessionId, event.lines)
            .map(line => ({ index: line.index, data: line.raw })),
        });
      }
      else send(socket, { ...event, sessionId });
    });
    map.set(sessionId, tailer);
    try { await tailer.start(); } catch (error) { if (map.get(sessionId) === tailer) map.delete(sessionId); throw error; }
  }

  async function skills(cwd: string): Promise<{ name: string; path: string; agent: string }[]> {
    const roots = [join(cwd, ".claude", "skills"), join(home, ".claude", "skills"), join(cwd, ".agents", "skills"), join(home, ".agents", "skills")];
    const out: { name: string; path: string; agent: string }[] = [];
    for (const root of roots) try { for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isDirectory()) out.push({ name: entry.name, path: join(root, entry.name), agent: root.includes(".agents") ? "codex" : "claude" }); } catch { /* absent */ }
    return out;
  }
  async function cliInfo(sessionId: string, topic: string) {
    const session = await index.resolveLight(sessionId); if (!session) throw new RpcError(404, "Session not found");
    const allowed = new Set(["version", "doctor", "mcp", "plugin", "hooks", "agents", "memory"]); if (!allowed.has(topic)) throw new RpcError(400, "Unsupported CLI info topic");
    if (topic === "memory") throw new RpcError(501, `${session.agent} does not expose a stable memory-info CLI command`);
    if (session.agent === "codex" && ["plugin", "hooks", "agents"].includes(topic)) {
      throw new RpcError(501, `Codex does not expose a ${topic}-info CLI command`);
    }
    const binary = session.agent === "codex" ? await resolveCodexExecutable(options.codexBinary ?? "codex") : (options.claudeBinary ?? "claude");
    const argsByTopic: Record<string, string[]> = {
      version: ["--version"],
      doctor: ["doctor"],
      mcp: ["mcp", "list"],
      plugin: ["plugin", "list"],
      hooks: ["hooks", "list"],
      agents: ["agents"],
    };
    try {
      const { stdout, stderr } = await execFileAsync(binary, argsByTopic[topic]!, { cwd: session.cwd, timeout: 8000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
      const output = (stdout || stderr || "No output.").trim();
      return { title: `${session.agent} ${topic}`, markdown: `\`\`\`text\n${output.replaceAll("```", "'''")}\n\`\`\`` };
    } catch (error) { throw new RpcError(503, `${session.agent} ${topic} is unavailable: ${error instanceof Error ? error.message : "CLI failed"}`); }
  }

  function enqueueBulkRetitle(sessionId: string): void {
    if (deletedSessionIds.has(sessionId) || bulkRetitleQueued.has(sessionId)) return;
    bulkRetitleQueued.add(sessionId);
    bulkRetitleQueue.push(sessionId);
    if (bulkRetitleWork) return;
    bulkRetitleWork = (async () => {
      while (bulkRetitleQueue.length) {
        const id = bulkRetitleQueue.shift()!;
        if (!bulkRetitleQueued.delete(id) || deletedSessionIds.has(id)) continue;
        const session = index.get(id);
        if (!session) continue;
        const currentTitle = (await state.titles.get())[id];
        if (currentTitle?.source === "manual") continue;
        pubsub.push({ type: "session-retitling", kind: "session-retitling", id, inflight: true });
        try {
          const title = await autoTitle(index, state, id, true);
          const currentSession = index.get(id);
          if (deletedSessionIds.has(id) || !currentSession) {
            await state.titles.update(all => { delete all[id]; });
            continue;
          }
          if (title) await publishAutoTitle(currentSession, title);
        } catch (error) {
          app.log.warn({ sessionId: id, error }, "bulk automatic session title generation failed");
        } finally {
          pubsub.push({ type: "session-retitling", kind: "session-retitling", id, inflight: false });
        }
      }
    })().finally(() => {
      bulkRetitleWork = undefined;
    });
  }

  async function handleRpc(socket: WebSocket, request: RpcRequest): Promise<unknown> {
    const args = request;
    switch (request.type) {
      case "ping": send(socket, { type: "pong", seq: Number(args.seq ?? 0) + 1 }); return undefined;
      case "get-sessions": return sessionView();
      case "normalize-cwd": return { cwd: await normalizeCwd(args.cwd) };
      case "complete-path": {
        const value = expandHome(String(args.path ?? ""), home); const parent = dirname(value); const prefix = basename(value).toLocaleLowerCase();
        const actualParent = await realpath(parent); if (![home, ...extraRoots].some(root => isWithin(resolve(root), actualParent))) throw new RpcError(403, "Path is outside allowed roots");
        const paths = (await readdir(actualParent, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.toLocaleLowerCase().startsWith(prefix)).slice(0, 50).map(entry => join(actualParent, entry.name));
        return { paths };
      }
      case "read-local-file": return readLocalSource(String(args.path ?? ""), [...extraRoots], args.line === undefined ? undefined : Number(args.line));
      case "inspect-local-path": return inspectLocalPath(String(args.path ?? ""), [...extraRoots]);
      case "list-local-directory": return listLocalDirectory(String(args.path ?? ""), [...extraRoots]);
      case "reveal-local-path": {
        const target = await resolveLocalPath(String(args.path ?? ""), [...extraRoots]);
        await openLocalPath(target.path, target.kind);
        return { path: target.path, kind: target.kind };
      }
      case "new-session": return newSession(args);
      case "prompt": return promptSession(String(args.sessionId ?? ""), args);
      case "stop": return stopSession(String(args.sessionId ?? ""));
      case "kill": { const id = String(args.sessionId ?? ""); assertSessionId(id); const session = await index.resolveLight(id); if (!session) throw new RpcError(404, "Session not found"); if (session.agent === "codex") codex.kill(); else claude.kill(id); return {}; }
      case "compact-session": { const id = String(args.sessionId ?? ""); assertSessionId(id); const session = await index.resolveLight(id); if (!session) throw new RpcError(404, "Session not found"); if (session.agent === "codex") await codex.compact(id); else await claude.compact(id, session.cwd); return {}; }
      case "cli-info": return cliInfo(String(args.sessionId ?? ""), String(args.topic ?? "version"));
      case "get-codex-rate-limits": {
        const id = String(args.sessionId ?? "");
        assertSessionId(id);
        const session = await index.resolveLight(id);
        if (!session) throw new RpcError(404, "Session not found");
        if (session.agent !== "codex") throw new RpcError(400, "Rate limits are only available for Codex sessions");
        return codex.rateLimits();
      }
      case "get-background-tasks": {
        const id = String(args.sessionId ?? "");
        assertSessionId(id);
        const session = await index.resolveLight(id);
        if (!session) throw new RpcError(404, "Session not found");
        await ensureTaskHistory(session);
        return { tasks: backgroundTasksWire(state.tasks.get(id) ?? []) };
      }
      case "codex-goal-get": return { goal: await codex.goalGet(String(args.sessionId ?? "")) };
      case "codex-goal-set": return { goal: await codex.goalSet(String(args.sessionId ?? ""), {
        ...(typeof args.objective === "string" ? { objective: args.objective } : {}),
        ...(typeof args.status === "string" ? { status: args.status } : {}),
        ...(typeof args.tokenBudget === "number" ? { tokenBudget: args.tokenBudget } : {}),
      }) };
      case "codex-goal-clear": await codex.goalClear(String(args.sessionId ?? "")); return { goal: null };
      case "get-agent-capabilities": {
        const agent = args.agent === "codex" ? "codex" : args.agent === "claude" ? "claude" : null;
        if (!agent) throw new RpcError(400, "Unknown agent kind");
        const prefs = await state.prefs.get();
        if (agent === "claude") return claudeCapabilities(prefs);
        const suppliedCwd = settingValue(args.cwd, "Working directory", 4096);
        const cwd = suppliedCwd ? await normalizeCwd(suppliedCwd) : undefined;
        const capabilities = await codex.capabilities(cwd);
        return {
          ...capabilities,
          defaults: {
            ...capabilities.defaults,
            model: prefs.defaultCodexModel || capabilities.defaults.model,
            effort: prefs.defaultCodexEffort || capabilities.defaults.effort,
            serviceTier: prefs.defaultCodexServiceTier || capabilities.defaults.serviceTier,
            permissionMode: prefs.defaultCodexApprovalPreset || capabilities.defaults.permissionMode,
            sandboxMode: prefs.defaultCodexSandboxMode || capabilities.defaults.sandboxMode,
          },
        };
      }
      case "set-model": {
        const id = String(args.sessionId ?? ""); assertSessionId(id); const model = settingValue(args.model, "Model") ?? "";
        const session = await index.resolveLight(id); if (!session) throw new RpcError(404, "Session not found"); if (session.agent === "codex") await codex.updateSettings(id, { model: model || null, cwd: session.cwd });
        await state.settings.update(all => { const current = all[id] ?? {}; if (model) current.model = model; else delete current.model; all[id] = current; });
        pubsub.push({ type: "session-settings", kind: "session-settings", id, ...(await state.settings.get())[id] }); return { applies: session.agent === "claude" ? "next-process" : "immediately" };
      }
      case "set-effort": {
        const id = String(args.sessionId ?? ""); assertSessionId(id);
        const session = await index.resolveLight(id); if (!session) throw new RpcError(404, "Session not found");
        const effort = session.agent === "codex" ? codexReasoningEffort(args.effort) ?? "" : reasoningEffort(args.effort) ?? "";
        if (session.agent === "codex") await codex.updateSettings(id, { effort: effort || null, cwd: session.cwd });
        await state.settings.update(all => { const current = all[id] ?? {}; if (effort) current.effort = effort; else delete current.effort; all[id] = current; });
        pubsub.push({ type: "session-settings", kind: "session-settings", id, ...(await state.settings.get())[id] }); return { applies: session.agent === "claude" ? "next-process" : "immediately" };
      }
      case "set-service-tier": {
        const id = String(args.sessionId ?? ""); assertSessionId(id); const serviceTier = codexServiceTier(args.serviceTier) ?? "";
        const session = await index.resolveLight(id); if (!session) throw new RpcError(404, "Session not found");
        if (session.agent !== "codex") throw new RpcError(409, "Claude sessions do not use Codex service tiers");
        await codex.updateSettings(id, { serviceTier: serviceTier || null, cwd: session.cwd });
        await state.settings.update(all => {
          const current = all[id] ?? {};
          current.serviceTier = serviceTier || "standard";
          // Clear the broken representation written by older builds.
          if (current.effort === "fast") delete current.effort;
          all[id] = current;
        });
        pubsub.push({ type: "session-settings", kind: "session-settings", id, ...(await state.settings.get())[id] });
        return { applies: "next-turn" };
      }
      case "set-permission-mode": {
        const id = String(args.sessionId ?? ""); assertSessionId(id); const rawMode = settingValue(args.mode, "Permission mode");
        const session = await index.resolveLight(id); if (!session) throw new RpcError(404, "Session not found");
        const mode = session.agent === "codex" ? codexApproval(rawMode) ?? "" : claudePermission(rawMode) ?? "";
        const sandboxMode = session.agent === "codex" ? codexPresetSandbox(rawMode) : undefined;
        if (session.agent === "codex") {
          await codex.updateSettings(id, {
            approvalPolicy: mode || null,
            ...(sandboxMode ? { sandboxMode } : {}),
            cwd: session.cwd,
          });
        }
        await state.settings.update(all => {
          const current = all[id] ?? {};
          // Preserve the frontend preset key so the selected pill remains
          // stable; translate only at the app-server boundary.
          if (rawMode) current.permissionMode = rawMode;
          else delete current.permissionMode;
          if (sandboxMode) current.sandboxMode = sandboxMode;
          all[id] = current;
        });
        pubsub.push({ type: "session-settings", kind: "session-settings", id, ...(await state.settings.get())[id] }); return { applies: session.agent === "claude" ? "next-process" : "immediately" };
      }
      case "set-sandbox-mode": {
        const id = String(args.sessionId ?? ""); assertSessionId(id); const rawMode = settingValue(args.mode, "Sandbox mode");
        const session = await index.resolveLight(id); if (!session) throw new RpcError(404, "Session not found");
        if (session.agent !== "codex") throw new RpcError(409, "Claude permission modes do not use the Codex sandbox control");
        const mode = codexSandbox(rawMode) ?? "";
        await codex.updateSettings(id, { sandboxMode: mode || null, cwd: session.cwd });
        await state.settings.update(all => { const current = all[id] ?? {}; if (mode) current.sandboxMode = mode; else delete current.sandboxMode; all[id] = current; });
        pubsub.push({ type: "session-settings", kind: "session-settings", id, ...(await state.settings.get())[id] }); return { applies: "immediately" };
      }
      case "interaction-respond": {
        const id = String(args.sessionId ?? ""); const requestId = String(args.requestId ?? ""); const interaction = state.interactions.get(state.interactionKey(id, requestId));
        if (!interaction) throw new RpcError(409, "Interaction is no longer pending"); if (interaction.agent === "codex") codex.respond(id, requestId, args.answer); else claude.respond(id, requestId, args.answer); return {};
      }
      case "delete-sessions": {
        const result = await deleteSessions(index, claude, Array.isArray(args.sessionIds) ? args.sessionIds : [], id => codex.isActive(id));
        for (const id of result.deleted) {
          deletedSessionIds.add(id);
          bulkRetitleQueued.delete(id);
          for (const [key, created] of newSessionResults) {
            if (created.sessionId === id) newSessionResults.delete(key);
          }
        }
        const cleanupIssues = await state.cleanupSessions(result.deleted);
        if (cleanupIssues.length) {
          app.log.error({ cleanupIssues }, "Deleted sessions left state that will need cleanup retry");
        }
        return { deleted: result.deleted, failed: result.failed.map(item => ({ id: item.id, reason: item.message })) };
      }
      case "set-title": {
        const id = String(args.sessionId ?? "");
        assertSessionId(id);
        const session = await index.resolveLight(id);
        if (!session) throw new RpcError(404, "Session not found");
        const parsed = splitTitleEmoji(args.title);
        const title = parsed.title;
        return serializeTitleMutation(id, async () => {
          await state.titles.update(all => {
            if (title) {
              const topicSummary = all[id]?.topicSummary;
              all[id] = {
                title,
                source: "manual",
                ...(parsed.emoji ? { emoji: parsed.emoji } : {}),
                ...(topicSummary ? { topicSummary } : {}),
              };
            }
            else delete all[id];
          });
          const local = (await state.titles.get())[id];
          const resolvedTitle = resolveSessionTitle(session.agent, local, canonicalCodexTitles.get(id));
          pubsub.push({
            type: "session-renamed",
            kind: "session-renamed",
            id,
            title: resolvedTitle.title,
            titleSource: resolvedTitle.source,
            emoji: resolvedTitle.emoji ?? null,
          });
          return {
            title: resolvedTitle.title,
            titleSource: resolvedTitle.source,
            emoji: resolvedTitle.emoji ?? null,
          };
        });
      }
      case "get-title": {
        const id = String(args.sessionId ?? "");
        assertSessionId(id);
        const session = await index.resolveLight(id);
        if (!session) throw new RpcError(404, "Session not found");
        const local = (await state.titles.get())[id];
        const resolvedTitle = resolveSessionTitle(session.agent, local, canonicalCodexTitles.get(id));
        return {
          title: resolvedTitle.title,
          titleSource: resolvedTitle.source,
          emoji: resolvedTitle.emoji ?? null,
        };
      }
      case "mark-read": {
        const id = String(args.sessionId ?? ""); assertSessionId(id); const at = asString(args.at) ?? new Date().toISOString(); await state.reads.update(all => { all[id] = { at }; }); pubsub.push({ type: "session-read", kind: "session-read", id, at }); return { ok: true };
      }
      case "retitle-session": {
        const id = String(args.sessionId ?? "");
        assertSessionId(id);
        const session = await index.resolveLight(id);
        if (!session) throw new RpcError(404, "Session not found");
        pubsub.push({ type: "session-retitling", kind: "session-retitling", id, inflight: true });
        try {
          const title = await autoTitle(index, state, id, true);
          const currentSession = index.get(id);
          if (deletedSessionIds.has(id) || !currentSession) {
            await state.titles.update(all => { delete all[id]; });
            return { title: null, titleSource: null, emoji: null };
          }
          return title
            ? await publishAutoTitle(currentSession, title)
            : { title: null, titleSource: null, emoji: null };
        } finally {
          pubsub.push({ type: "session-retitling", kind: "session-retitling", id, inflight: false });
        }
      }
      case "retitle-all": {
        const titles = await state.titles.get(); let queued = 0; let skippedManual = 0;
        for (const session of index.list()) {
          if (titles[session.id]?.source === "manual") {
            skippedManual++;
            continue;
          }
          queued++;
          enqueueBulkRetitle(session.id);
        }
        return { queued, skippedManual };
      }
      case "get-user-messages": return getUserMessages(index, String(args.sessionId ?? ""));
      case "rewind": return rewindSession(index, claude, codex, String(args.sessionId ?? ""), String(args.messageUuid ?? ""));
      case "fork": return forkSession(index, claude, codex, String(args.sessionId ?? ""), String(args.messageUuid ?? ""));
      case "search-content": {
        searchControllers.get(socket)?.abort();
        const controller = new AbortController();
        searchControllers.set(socket, controller);
        try {
          return await searchSessions(index, String(args.query ?? ""), {
            signal: controller.signal,
            contentIndex: contentSearchIndex,
            onDiagnostic: diagnostic => app.log.info({ search: diagnostic }, "content search complete"),
          });
        } catch (error) {
          if ((error as { name?: unknown })?.name === "AbortError") throw new RpcError(499, "Search superseded");
          throw error;
        } finally {
          if (searchControllers.get(socket) === controller) searchControllers.delete(socket);
        }
      }
      case "read-tail": {
        const id = String(args.sessionId ?? ""); assertSessionId(id);
        const session = await index.resolveLight(id); if (!session) throw new RpcError(404, "Session not found");
        const lines = await readTail(session.path, Number(args.n ?? 200));
        const filtered = session.agent === "claude" ? preserveIndexes(lines, isRenderableClaudeLine) : lines;
        return sanitizeTranscriptLines(id, filtered);
      }
      case "read-range": {
        const id = String(args.sessionId ?? ""); assertSessionId(id);
        const session = await index.resolveLight(id); if (!session) throw new RpcError(404, "Session not found");
        const lines = await readRange(session.path, Number(args.from ?? 0), Number(args.to ?? Number.MAX_SAFE_INTEGER));
        const filtered = session.agent === "claude" ? preserveIndexes(lines, isRenderableClaudeLine) : lines;
        return sanitizeTranscriptLines(id, filtered);
      }
      case "get-prefs": return state.prefs.get();
      case "put-prefs": await state.prefs.put(normalizePrefs(args.prefs)); return undefined;
      case "get-me": return { home };
      case "get-session-skills": {
        const suppliedCwd = asString(args.cwd);
        if (suppliedCwd) return { skills: await skills(await normalizeCwd(suppliedCwd)) };
        const id = String(args.sessionId ?? "");
        assertSessionId(id);
        const session = await index.resolveLight(id);
        if (!session) throw new RpcError(404, "Session not found");
        return { skills: await skills(session.cwd) };
      }
      case "rephrase": throw new RpcError(501, "Rephrase is not available with the installed agent CLIs");
      case "subscribe": {
        if (args.channel === "global") {
          pubsub.addGlobal(socket, typeof args.notifSinceSeq === "number" ? args.notifSinceSeq : undefined);
          for (const [id, status] of state.status) send(socket, { type: "session-status", kind: "session-status", id, ...status });
          for (const [sessionId, retry] of state.capacityRetries) {
            send(socket, { type: "capacity-retry", kind: "capacity-retry", sessionId, ...retry });
          }
          for (const interaction of state.interactions.values()) send(socket, interactionAddedPush(interaction));
          for (const [sessionId, tasks] of state.tasks) send(socket, backgroundTasksPush(sessionId, tasks));
          for (const [id, settings] of Object.entries(await state.settings.get())) send(socket, { type: "session-settings", kind: "session-settings", id, ...settings });
        } else if (args.channel === "session") await subscribeSession(socket, String(args.sessionId ?? ""), Number(args.from ?? 0), args.tailN === undefined ? undefined : Number(args.tailN));
        else throw new RpcError(400, "Unknown subscription channel"); return {};
      }
      case "unsubscribe": {
        if (args.channel === "global") pubsub.remove(socket);
        else if (args.channel === "session") { const map = subscriptions.get(socket); const old = map?.get(String(args.sessionId)); map?.delete(String(args.sessionId)); if (old) void old.stop(); }
        return {};
      }
      default: throw new RpcError(400, `Unknown request type: ${request.type}`);
    }
  }

  app.get("/ws/main", { websocket: true }, (socket, request) => {
    if (!timingSafeToken(token, request.cookies?.[COOKIE_NAME])) { socket.close(1008, "Authentication required"); return; }
    if (!webSocketOriginAllowed(request.headers.origin, request.headers.host)) { socket.close(1008, "Origin not allowed"); return; }
    subscriptions.set(socket, new Map()); resetIdle(socket);
    socket.on("message", data => {
      resetIdle(socket); let rpc: RpcRequest;
      try { rpc = JSON.parse(String(data)) as RpcRequest; if (!rpc || typeof rpc.type !== "string") throw new Error(); }
      catch { send(socket, { type: "error", code: 400, message: "Invalid request" }); return; }
      void handleRpc(socket, rpc).then(result => {
        if (rpc.type !== "ping" && rpc.reqId) send(socket, { type: "result", reqId: rpc.reqId, ok: true, data: result });
      }).catch(error => send(socket, { type: "error", reqId: rpc.reqId, code: error instanceof RpcError ? error.code : 500, message: error instanceof Error ? error.message : "Request failed" }));
    });
    socket.on("close", () => void stopSocket(socket)); socket.on("error", () => void stopSocket(socket));
  });

  const status = (event: { id: string; status: "running" | "exited" | "failed"; webuiAlive: boolean; compacting?: boolean; lastBoundaryAt?: string }) => { state.status.set(event.id, event); pubsub.push({ type: "session-status", kind: "session-status", ...event }); if (event.lastBoundaryAt) pubsub.push({ type: "session-boundary", kind: "session-boundary", id: event.id, at: event.lastBoundaryAt }); };
  claude.on("status", event => {
    foreignClaudeSessions.delete(event.id);
    status(event);
    if (!event.webuiAlive) {
      const prior = state.tasks.get(event.id) ?? [];
      const tasks = failRunningClaudeBackgroundTasks(prior);
      if (tasks !== prior) {
        state.tasks.set(event.id, tasks);
        pubsub.push(backgroundTasksPush(event.id, tasks));
      }
    }
  });
  codex.on("status", event => {
    const previousStatus = state.status.get(event.id)?.status;
    if (event.status !== "running") state.capacityRetries.delete(event.id);
    // `startTurnNow` and the app-server both emit "running". Only the first
    // transition into a turn is a boundary; the duplicate must not settle
    // tasks that already started in the current turn.
    const crossedBoundary = event.status !== "running" || previousStatus !== "running";
    if (crossedBoundary) {
      const prior = state.tasks.get(event.id) ?? [];
      const tasks = settleRunningCodexBackgroundTasks(
        prior,
        event.status === "failed" ? "failed" : "completed",
        event.lastBoundaryAt ?? new Date().toISOString(),
      );
      if (tasks !== prior) {
        state.tasks.set(event.id, tasks);
        pubsub.push(backgroundTasksPush(event.id, tasks));
      }
    }
    status(event);
  });
  codex.on("capacity-retry", (event: {
    sessionId: string;
    turnId: string;
    attempt: number;
    maxAttempts: number;
    delayMs: number;
  }) => {
    const retryAt = new Date(Date.now() + event.delayMs).toISOString();
    const retry = {
      turnId: event.turnId,
      attempt: event.attempt,
      maxAttempts: event.maxAttempts,
      delayMs: event.delayMs,
      retryAt,
    };
    state.capacityRetries.set(event.sessionId, retry);
    pubsub.push({
      type: "capacity-retry",
      kind: "capacity-retry",
      sessionId: event.sessionId,
      ...retry,
    });
  });
  codex.on("turn-error", (event: { sessionId: string; turnId: string | null; message: string; details: string | null }) => {
    pubsub.push({ type: "session-error", kind: "session-error", ...event, agent: "codex" });
  });
  codex.on("thread-name", (event: { id: string; name: string | null }) => {
    void applyCanonicalCodexTitle(event.id, event.name);
  });
  for (const driver of [claude, codex]) {
    driver.on("interaction-added", interaction => pubsub.push(interactionAddedPush(interaction)));
    driver.on("interaction-removed", interaction => pubsub.push(interactionRemovedPush(interaction)));
  }
  codex.on("background", event => {
    const tasks = mergeCodexBackgroundTask(state.tasks.get(event.sessionId) ?? [], event.method, event.params);
    state.tasks.set(event.sessionId, tasks);
    pubsub.push(backgroundTasksPush(event.sessionId, tasks));
  });
  codex.on("steers-completed", event => {
    if (event.clientUuids.length) pubsub.push({ type: "codex-steers-settled", kind: "codex-steers-settled", sessionId: event.sessionId, clientUuids: event.clientUuids, status: event.status });
  });
  claude.on("wire", ({ sessionId, event }) => {
    if (!sessionId) return;
    const prior = state.tasks.get(sessionId) ?? [];
    const tasks = mergeClaudeBackgroundTasks(prior, event);
    if (tasks === prior) return;
    state.tasks.set(sessionId, tasks);
    pubsub.push(backgroundTasksPush(sessionId, tasks));
  });
  async function refreshForeignStatus(sessionId: string): Promise<void> {
    if (claude.isOwned(sessionId) || !foreignClaudeSessions.has(sessionId)) return;
    const session = index.get(sessionId);
    const running = session?.agent === "claude" ? await inferForeignClaudeTurn(session) : false;
    status({ id: sessionId, status: running ? "running" : "exited", webuiAlive: false });
  }
  function scheduleForeignStatus(sessionId: string, immediate = false): void {
    if (claude.isOwned(sessionId) || !foreignClaudeSessions.has(sessionId)) return;
    if (foreignStatusWork.has(sessionId)) {
      foreignStatusPending.add(sessionId);
      return;
    }
    if (foreignStatusTimers.has(sessionId)) return;
    const delay = immediate
      ? 0
      : Math.max(0, FOREIGN_STATUS_MIN_INTERVAL_MS - (Date.now() - (foreignStatusLastRead.get(sessionId) ?? 0)));
    const run = () => {
      foreignStatusTimers.delete(sessionId);
      if (foreignStatusWork.has(sessionId)) {
        foreignStatusPending.add(sessionId);
        return;
      }
      foreignStatusWork.add(sessionId);
      void refreshForeignStatus(sessionId).finally(() => {
        foreignStatusWork.delete(sessionId);
        if (!index.get(sessionId)) {
          foreignStatusPending.delete(sessionId);
          foreignStatusLastRead.delete(sessionId);
          return;
        }
        foreignStatusLastRead.set(sessionId, Date.now());
        if (foreignStatusPending.delete(sessionId)) scheduleForeignStatus(sessionId);
      });
    };
    if (!delay) run();
    else {
      const timer = setTimeout(run, delay);
      timer.unref?.();
      foreignStatusTimers.set(sessionId, timer);
    }
  }
  claudeProcesses.on("changed", (event: ForeignClaudeObservation) => {
    if (event.peer && claude.isOwned(event.sessionId)) return;
    const changed = event.peer ? !foreignClaudeSessions.has(event.sessionId) : foreignClaudeSessions.delete(event.sessionId);
    if (event.peer) foreignClaudeSessions.add(event.sessionId);
    if (!claude.isOwned(event.sessionId)) {
      if (event.peer) scheduleForeignStatus(event.sessionId, true);
      else status({ id: event.sessionId, status: "exited", webuiAlive: false });
    }
    if (changed) {
      const session = index.get(event.sessionId);
      pubsub.push(sessionTouchedPush(
        event.sessionId,
        session ? { ...session, peer: event.peer } : { peer: event.peer },
      ));
    }
  });
  function startAutoTitleWork(sessionId: string): void {
    if (autoTitleWork.has(sessionId) || !autoTitlePending.has(sessionId)) return;
    autoTitleWork.add(sessionId);
    void (async () => {
      while (true) {
        const trigger = autoTitlePending.get(sessionId);
        if (!trigger) return;
        autoTitlePending.delete(sessionId);
        const [prefs, titles] = await Promise.all([state.prefs.get(), state.titles.get()]);
        if (!prefs.autoTitleEnabled || titles[sessionId]?.source === "manual") {
          autoTitleTurns.delete(sessionId);
          autoTitleCycleRequests.delete(sessionId);
          continue;
        }
        const cycleRequests = appendIncrementalTitleRequests(
          autoTitleCycleRequests.get(sessionId) ?? [],
          trigger.requests,
        );
        autoTitleCycleRequests.set(sessionId, cycleRequests);
        const turns = (autoTitleTurns.get(sessionId) ?? 0) + trigger.turns;
        autoTitleTurns.set(sessionId, turns);
        const frequency = Math.max(1, Math.floor(prefs.autoTitleFrequency || 1));
        if (titles[sessionId] && turns < frequency) continue;
        pubsub.push({ type: "session-retitling", kind: "session-retitling", id: sessionId, inflight: true });
        try {
          // Load one bounded conversation-wide anchor on the first refresh in
          // this process. Later refreshes reuse it and add the completed cycle,
          // so the titler always sees the overall task without rescanning a
          // potentially large transcript every few turns.
          const currentSession = index.get(sessionId);
          let anchor = autoTitleAnchorRequests.get(sessionId);
          if (currentSession && (!anchor || currentSession.size < anchor.size)) {
            try {
              anchor = {
                requests: await sessionTitleRequests(currentSession.path, currentSession.agent),
                size: currentSession.size,
              };
              autoTitleAnchorRequests.set(sessionId, anchor);
            } catch (error) {
              if (anchor && currentSession.size < anchor.size) {
                anchor = undefined;
                autoTitleAnchorRequests.delete(sessionId);
              }
              app.log.warn({ sessionId, error }, "conversation-wide title context scan failed");
            }
          }
          if (anchor && cycleRequests.length) {
            anchor = {
              requests: appendConversationTitleRequests(anchor.requests, cycleRequests),
              size: currentSession?.size ?? anchor.size,
            };
            autoTitleAnchorRequests.set(sessionId, anchor);
          }
          const overallContext = anchor?.requests.length
            ? formatTitleRequestContext(anchor.requests, 3_800)
            : "";
          const cycleContext = cycleRequests.length
            ? formatIncrementalTitleContext(cycleRequests, 1_500)
            : "";
          const context = [overallContext, cycleContext].filter(Boolean).join("\n\n")
            || (currentSession
              ? await recentSessionTitleContext(currentSession.path, currentSession.agent)
              : "");
          const title = context
            ? await autoTitleFromText(index, state, sessionId, context)
            : await autoTitle(index, state, sessionId);
          autoTitleTurns.set(sessionId, 0);
          autoTitleCycleRequests.delete(sessionId);
          const session = index.get(sessionId);
          if (deletedSessionIds.has(sessionId) || !session) {
            await state.titles.update(all => { delete all[sessionId]; });
            continue;
          }
          if (title && session) await publishAutoTitle(session, title);
        } finally {
          pubsub.push({ type: "session-retitling", kind: "session-retitling", id: sessionId, inflight: false });
        }
      }
    })().catch(error => {
      app.log.warn({ sessionId, error }, "automatic session title generation failed");
    }).finally(() => {
      autoTitleWork.delete(sessionId);
      if (autoTitlePending.has(sessionId)) setImmediate(() => startAutoTitleWork(sessionId));
    });
  }
  function rememberAutoTitlePrompt(sessionId: string, promptText: string): void {
    const text = promptText.replace(/\s+/g, " ").trim().slice(0, 900);
    if (!text) return;
    const recent = recentAutoTitlePrompts.get(sessionId) ?? [];
    if (recent.at(-1) === text) return;
    recent.push(text);
    recentAutoTitlePrompts.set(sessionId, recent.slice(-6));
  }
  function autoTitlePromptRequests(sessionId: string): string[] {
    return [...(recentAutoTitlePrompts.get(sessionId) ?? [])];
  }
  function scheduleAutoTitle(sessionId: string, promptRequests: string[], completedTurns = 1): void {
    const queued = autoTitlePending.get(sessionId);
    autoTitlePending.set(sessionId, {
      requests: appendIncrementalTitleRequests(queued?.requests ?? [], promptRequests),
      turns: (queued?.turns ?? 0) + Math.max(1, completedTurns),
    });
    startAutoTitleWork(sessionId);
  }
  index.on("added", session => {
    deletedSessionIds.delete(session.id);
    trackSessionRoot(session);
    lastSizes.set(session.id, session.size);
    if (initialDiscoveryComplete) contentSearchIndex?.schedule(session);
    pubsub.push(sessionAddedPush({ ...session, peer: foreignClaudeSessions.has(session.id), ...state.status.get(session.id) }));
  });
  async function inspectNotificationAppend(session: SessionRecord): Promise<void> {
    const prior = lastSizes.get(session.id) ?? session.size;
    if (session.size < prior) { notificationTrailing.delete(session.id); lastSizes.set(session.id, session.size); }
    if (session.size <= prior) return;
    try {
      const length = Math.min(session.size - prior, NOTIFICATION_APPEND_CHUNK_BYTES);
      const bytes = Buffer.allocUnsafe(length);
      const handle = await open(session.path, "r");
      let offset = 0; let emptyReads = 0;
      try {
        while (offset < length && emptyReads < 3) {
          const result = await handle.read(bytes, offset, length - offset, prior + offset);
          if (result.bytesRead) { offset += result.bytesRead; emptyReads = 0; }
          else { emptyReads++; await new Promise(resolve => setTimeout(resolve, 20)); }
        }
      } finally { await handle.close(); }
      if (!offset) throw new Error("Session append was not readable yet");
      lastSizes.set(session.id, prior + offset);
      const appended = (notificationTrailing.get(session.id) ?? "") + bytes.subarray(0, offset).toString("utf8");
      const lastNewline = appended.lastIndexOf("\n");
      if (lastNewline < 0) {
        // A single giant tool-result record must not become one equally giant
        // in-memory notification buffer. Once its newline arrives, the invalid
        // suffix is discarded and following normal records are parsed again.
        notificationTrailing.set(
          session.id,
          appended.length <= NOTIFICATION_TRAILING_MAX_CHARS ? appended : "",
        );
        return;
      }
      notificationTrailing.set(session.id, appended.slice(lastNewline + 1));
      let completedTurns = 0;
      const completedPromptRequests: string[] = [];
      for (const line of appended.slice(0, lastNewline + 1).split(/\r?\n/)) {
        try {
          const record = asRecord(JSON.parse(line)); if (!record) continue; const payload = asRecord(record.payload);
          const promptText = titleRequestText(record, session.agent);
          if (promptText) rememberAutoTitlePrompt(session.id, promptText);
          if (session.agent === "codex") {
            const terminal = codexDurableTerminal(record);
            if (terminal) {
              codex.reconcileDurableTerminal(
                session.id,
                terminal.turnId,
                terminal.kind,
                terminal.timestamp,
              );
            }
          }
          if (session.agent === "claude") {
            const priorTasks = state.tasks.get(session.id) ?? [];
            const tasks = mergeClaudeBackgroundTasks(priorTasks, record);
            if (tasks !== priorTasks) {
              state.tasks.set(session.id, tasks);
              pubsub.push(backgroundTasksPush(session.id, tasks));
            }
          }
          const meaningfulEndTurn = isMeaningfulEndTurnRecord(record, session.agent);
          if (meaningfulEndTurn) {
            completedTurns++;
            // Capture exactly the request belonging to this completion. When
            // one append contains multiple turns, each boundary contributes
            // its own request to the next rolling-summary update.
            const request = autoTitlePromptRequests(session.id).at(-1);
            if (request && completedPromptRequests.at(-1) !== request) {
              completedPromptRequests.push(request);
            }
          }
          const uuid = asString(record.uuid) ?? asString(payload?.id) ?? `${session.id}:${record.timestamp}`; if (!meaningfulEndTurn || notificationUuids.seen(uuid)) continue;
          pubsub.notify({
            id: session.id,
            cwd: session.cwd,
            title: session.title ?? null,
            body: session.preview ?? "Turn completed",
            uuid,
            timestamp: asString(record.timestamp) ?? new Date().toISOString(),
            subagent: session.subagent,
          });
        } catch { /* isolate malformed or incomplete records */ }
      }
      if (completedTurns) {
        scheduleAutoTitle(
          session.id,
          completedPromptRequests,
          completedTurns,
        );
      }
    } catch {
      // Do not advance the watermark on a transient open/read failure.
      lastSizes.set(session.id, prior);
      throw new Error("Notification append read failed");
    }
  }
  function scheduleNotificationAppend(session: SessionRecord): void {
    if (index.get(session.id)?.path !== session.path) return;
    trackSessionRoot(session);
    // Publish the already-computed table patch once per filesystem event. Keep
    // this outside the retry worker: an unreadable network file must not turn
    // one append into a 10 Hz event storm.
    pubsub.push(sessionTouchedPush(session.id, {
      id: session.id,
      cwd: session.cwd,
      mtime: session.mtime,
      size: session.size,
      agent: session.agent,
      preview: session.preview,
      previewRole: session.previewRole,
      lastTurnAt: session.lastTurnAt,
      parentSessionId: session.parentSessionId,
      subagent: session.subagent,
    }));
    if (foreignClaudeSessions.has(session.id)) scheduleForeignStatus(session.id);
    notificationPending.set(session.id, session);
    if (notificationWork.has(session.id)) return;
    const current = (async () => {
      let failures = 0;
      while (true) {
        if (index.get(session.id)?.path !== session.path) return;
        const target = notificationPending.get(session.id);
        if (!target) return;
        notificationPending.delete(session.id);
        try {
          await inspectNotificationAppend(target);
          failures = 0;
        } catch {
          // Network filesystems can briefly report an append before those
          // bytes are readable. Retry with bounded exponential backoff, then
          // stop until chokidar/the poller supplies a fresh change event.
          if (index.get(session.id)?.path !== target.path) return;
          failures++;
          if (failures >= 5) return;
          notificationPending.set(session.id, target);
          await new Promise(resolve => setTimeout(resolve, Math.min(1600, 100 * (2 ** (failures - 1)))));
          continue;
        }
        if ((lastSizes.get(session.id) ?? target.size) < target.size) {
          notificationPending.set(session.id, target);
        }
        // Yield between 512 KiB chunks so one huge append cannot monopolize
        // Fastify's event loop or make the desktop UI feel frozen.
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    })();
    notificationWork.set(session.id, current);
    void current.finally(() => {
      if (notificationWork.get(session.id) === current) notificationWork.delete(session.id);
      const pending = notificationPending.get(session.id);
      if (pending) setImmediate(() => scheduleNotificationAppend(pending));
    }).catch(() => undefined);
  }
  index.on("removed", (session: SessionRecord) => {
    contentSearchIndex?.remove(session.path);
    untrackSessionRoot(session.id);
    lastSizes.delete(session.id);
    notificationTrailing.delete(session.id);
    notificationPending.delete(session.id);
    taskHistoryLoaded.delete(session.id);
    autoTitlePending.delete(session.id);
    autoTitleTurns.delete(session.id);
    autoTitleCycleRequests.delete(session.id);
    autoTitleAnchorRequests.delete(session.id);
    recentAutoTitlePrompts.delete(session.id);
    canonicalCodexTitles.delete(session.id);
    foreignClaudeSessions.delete(session.id);
    foreignStatusPending.delete(session.id);
    foreignStatusLastRead.delete(session.id);
    const foreignTimer = foreignStatusTimers.get(session.id);
    if (foreignTimer) clearTimeout(foreignTimer);
    foreignStatusTimers.delete(session.id);
    state.status.delete(session.id);
    state.tasks.delete(session.id);
    for (const [key, interaction] of state.interactions) {
      if (interaction.sessionId !== session.id) continue;
      state.interactions.delete(key);
      pubsub.push(interactionRemovedPush({
        sessionId: interaction.sessionId,
        requestId: interaction.requestId,
      }, "process_died"));
    }
    for (const map of subscriptions.values()) {
      const tailer = map.get(session.id);
      map.delete(session.id);
      if (tailer) void tailer.stop();
    }
  });
  index.on("touched", (session: SessionRecord) => {
    if (initialDiscoveryComplete) contentSearchIndex?.schedule(session);
    scheduleNotificationAppend(session);
  });
  let backgroundStartupTimer: NodeJS.Timeout | undefined;
  let backgroundStartupWork: Promise<void> | undefined;
  if (options.startWatchers === false) {
    // Tests and explicit one-shot callers need a complete deterministic
    // snapshot before buildApp resolves.
    await index.scan();
    for (const session of index.list()) {
      trackSessionRoot(session);
      lastSizes.set(session.id, session.size);
    }
    initialDiscoveryComplete = true;
    contentSearchIndex?.sync(index.list());
  } else {
    // A large first archive scan must never delay the listening socket. Start
    // the server and serve the SPA immediately; historical rows then arrive as
    // ordinary session-added pushes while one paced worker fills the durable
    // index. Starting the filesystem watcher first closes the add/change race.
    app.addHook("onListen", async () => {
      backgroundStartupTimer = setTimeout(() => {
        backgroundStartupTimer = undefined;
        if (closing) return;
        backgroundStartupWork = (async () => {
          await claudeProcesses.start();
          if (closing) return;
          await index.start();
          if (closing) return;
          try {
            await index.scan({ incremental: true });
          } finally {
            initialDiscoveryComplete = true;
            contentSearchIndex?.sync(index.list());
          }
        })().catch(error => {
          if (!closing) app.log.error({ err: error }, "Background session discovery failed");
        });
      }, 100);
      backgroundStartupTimer.unref?.();
    });
  }

  let staticReady = false;
  try {
    if ((await stat(frontendDist)).isDirectory()) {
      await app.register(fastifyStatic, {
        root: frontendDist,
        prefix: "/",
        index: false,
        wildcard: false,
        immutable: true,
        maxAge: "1y",
        setHeaders(response, filePath) {
          const name = basename(filePath);
          if (name === "manifest.webmanifest" || name === "sw.js") {
            response.header("Cache-Control", "private, no-cache");
          } else if (name === "clawd.svg" || name === "favicon-1780988963583-transparent.png") {
            response.header("Cache-Control", "private, max-age=86400");
          }
          if (name === "sw.js") response.header("Service-Worker-Allowed", "/");
        },
      });
      staticReady = true;
    }
  } catch { /* frontend is built later */ }
  if (staticReady) {
    app.get("/assets/*", async (request, reply) => {
      const path = rawPath(request); if (!/^\/assets\/[A-Za-z0-9._/-]+$/.test(path) || path.includes("..")) throw new RpcError(404, "Asset not found");
      return reply.header("Cache-Control", "public, max-age=31536000, immutable").sendFile(path.slice(1));
    });
  }
  app.get("/*", async (request, reply) => {
    const path = rawPath(request); if (path.startsWith("/api/") || path === "/api" || path.startsWith("/assets/")) return reply.code(404).send({ error: "Not found" });
    return spa(reply);
  });

  app.addHook("onClose", async () => {
    closing = true;
    if (backgroundStartupTimer) clearTimeout(backgroundStartupTimer);
    backgroundStartupTimer = undefined;
    for (const timer of foreignStatusTimers.values()) clearTimeout(timer);
    foreignStatusTimers.clear();
    for (const socket of subscriptions.keys()) await stopSocket(socket);
    await index.stop(); await claudeProcesses.stop();
    await backgroundStartupWork;
    // If close raced the first await inside background startup, that await may
    // have installed a watcher just after the first stop call.
    await index.stop(); await claudeProcesses.stop();
    // Closing the drivers first rejects an in-flight lazy title request
    // immediately instead of making shutdown wait for its RPC timeout.
    const titleWork = codexTitleListWork;
    claude.close(); codex.close();
    await titleWork;
    await contentSearchIndex?.close();
    await flushLineIndexPersistence();
  });
  return app;
}
