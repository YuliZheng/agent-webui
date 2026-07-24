import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { mkdir, open, readFile, realpath, readdir, stat, writeFile } from "node:fs/promises";
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
  flushLineIndexPersistence,
  JsonlTailer,
  readRange,
  readTail,
} from "./services/jsonl.js";
import { AppState, normalizePrefs } from "./services/state.js";
import { PubSub } from "./services/pubsub.js";
import { ClaudeDriver } from "./services/claude-driver.js";
import { CodexDriver } from "./services/codex-driver.js";
import { PreviewStore, readLocalSource, resolveLocalFile } from "./services/files.js";
import { autoTitle, autoTitleFromText, deleteSessions, forkSession, getUserMessages, markdownExport, rewindSession, searchSessions } from "./actions/sessions.js";
import { expandHome, isWithin, safeFilename } from "./util/paths.js";
import { resolveCodexExecutable } from "./util/executable.js";
import { isMeaningfulEndTurnRecord, NotificationDeduper } from "./services/notifications.js";
import {
  failRunningClaudeBackgroundTasks,
  mergeClaudeBackgroundTasks,
  mergeCodexBackgroundTask,
  type BackgroundTaskRecord,
} from "./services/background-tasks.js";
import { ClaudeProcessObserver, type ForeignClaudeObservation } from "./services/claude-process-observer.js";
import { sendJson } from "./services/ws-send.js";
import type { AgentCapabilities, AgentSelectOption, PrefsBlob } from "@agent-webui/shared";

const execFileAsync = promisify(execFile);

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

function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!); }
function safeBootJson(value: unknown): string { return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026"); }
export function interactionAddedPush(interaction: import("./services/state.js").Interaction) {
  return { type: "interaction-added", kind: "interaction-added", interaction } as const;
}
export const REQUEST_LOGGING_DISABLED = true;
function codexApproval(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (["untrusted", "on-request", "never"].includes(value)) return value;
  throw new RpcError(400, "Unsupported Codex approval preset");
}
function codexSandbox(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (["read-only", "workspace-write", "danger-full-access"].includes(value)) return value;
  throw new RpcError(400, "Unsupported Codex sandbox mode");
}
function claudePermission(value: string | undefined): string | undefined {
  if (!value) return undefined;
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
    models: ["sonnet", "opus", "haiku"].map(value => ({
      value,
      label: value[0]!.toUpperCase() + value.slice(1),
      supportedEfforts: CLAUDE_EFFORTS.map(option => ({ ...option })),
    })),
    permissionModes: CLAUDE_PERMISSIONS.map(option => ({ ...option })),
    sandboxModes: [],
    defaults: {
      model: prefs.defaultClaudeModel || null,
      effort: prefs.defaultClaudeEffort || null,
      permissionMode: prefs.defaultClaudePermissionMode || null,
      sandboxMode: null,
    },
  };
}
const ATTACHMENT_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]);
const NOTIFICATION_APPEND_CHUNK_BYTES = 512 * 1024;
const NOTIFICATION_TRAILING_MAX_CHARS = 512 * 1024;
const FOREIGN_STATUS_MIN_INTERVAL_MS = 750;

function isUserPromptAppend(record: Record<string, unknown>, agent: "claude" | "codex"): boolean {
  if (agent === "claude") return record.type === "user" && record.isMeta !== true && record.isSidechain !== true;
  const payload = asRecord(record.payload);
  const kind = asString(payload?.type) ?? asString(payload?.kind);
  return (record.type === "event_msg" && kind === "user_message")
    || (record.type === "response_item" && kind === "message" && payload?.role === "user");
}

function appendPromptText(record: Record<string, unknown>, agent: "claude" | "codex"): string {
  if (!isUserPromptAppend(record, agent)) return "";
  const textFromContent = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) return "";
    return value.flatMap(item => {
      const block = asRecord(item);
      const type = asString(block?.type);
      const text = asString(block?.text);
      return text && (!type || type === "text" || type === "input_text") ? [text] : [];
    }).join("\n");
  };
  if (agent === "claude") {
    const message = asRecord(record.message);
    return textFromContent(message?.content ?? record.content).trim();
  }
  const payload = asRecord(record.payload);
  return (
    asString(payload?.message)
    ?? asString(payload?.text)
    ?? textFromContent(payload?.content)
  ).trim();
}

export function decodeAttachmentPayload(raw: unknown): { name?: string; type: string; data: string; bytes: Buffer } {
  const item = asRecord(raw); const declared = asString(item?.type) ?? asString(item?.mediaType); const url = asString(item?.data);
  if (!declared || !url || !ATTACHMENT_TYPES.has(declared)) throw new RpcError(415, "Only PNG, JPEG, GIF, WebP, and PDF attachments are supported");
  const comma = url.indexOf(","); const header = comma >= 0 ? url.slice(0, comma) : ""; const data = comma >= 0 ? url.slice(comma + 1) : "";
  if (header !== `data:${declared};base64` || !data || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new RpcError(400, "Attachment must be a matching base64 data URL");
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new RpcError(413, "Attachment exceeds 10 MiB");
  return { name: asString(item?.name), type: declared, data, bytes };
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
  const pubsub = new PubSub();
  const claude = new ClaudeDriver(options.claudeBinary ?? "claude", options.claudeSessionsDir ?? join(home, ".claude", "sessions"), state);
  const claudeProcesses = new ClaudeProcessObserver(options.claudeSessionsDir ?? join(home, ".claude", "sessions"));
  const codex = new CodexDriver(options.codexBinary ?? "codex", state);
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
  const autoTitlePending = new Map<string, { text: string; turns: number; initial: boolean }>();
  const autoTitleTurns = new Map<string, number>();
  const foreignStatusWork = new Set<string>();
  const foreignStatusPending = new Set<string>();
  const foreignStatusLastRead = new Map<string, number>();
  const foreignStatusTimers = new Map<string, NodeJS.Timeout>();
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

  const sessionView = async () => {
    const [titles, reads] = await Promise.all([state.titles.get(), state.reads.get()]);
    return index.list().map(session => ({
      ...session, path: undefined, title: titles[session.id]?.title ?? null, titleSource: titles[session.id]?.source ?? null,
      titleEmoji: titles[session.id]?.emoji ?? null, readAt: reads[session.id]?.at ?? null,
      peer: foreignClaudeSessions.has(session.id), ...state.status.get(session.id),
    }));
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
    pubsub.push({ type: "background-tasks", kind: "background-tasks", sessionId: session.id, tasks });
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

  app.addHook("onRequest", async (request, reply) => {
    const path = rawPath(request);
    const capability = /^(?:\/preview\/[0-9a-f]{8}-[0-9a-f-]{27}\/index\.html)$/i.test(path);
    const bind = request.method === "GET" && path === "/api/auth/bind";
    const rootBind = request.method === "GET" && path === "/" && typeof (request.query as Record<string, unknown>)?.token === "string";
    if (capability || bind || rootBind || path === "/ws/main") return;
    if (!timingSafeToken(token, requestToken(request))) await reply.code(401).send({ error: "Authentication required" });
  });

  app.setErrorHandler((error, _request, reply) => {
    if (reply.sent) return;
    const code = error instanceof RpcError ? error.code : ((error as { statusCode?: number }).statusCode ?? 500);
    void reply.code(code >= 400 && code <= 599 ? code : 500).send({ error: error instanceof Error ? error.message : "Internal server error" });
  });

  let indexCache: { mtime: number; html: string } | undefined;
  async function spa(reply: FastifyReply): Promise<void> {
    const path = join(frontendDist, "index.html");
    try {
      const info = await stat(path);
      if (!indexCache || indexCache.mtime !== info.mtimeMs) indexCache = { mtime: info.mtimeMs, html: await readFile(path, "utf8") };
      reply.header("Cache-Control", "no-cache").type("text/html; charset=utf-8").send(indexCache.html);
    } catch { reply.code(503).type("text/html").send("<!doctype html><title>Agent WebUI</title><p>Frontend build is unavailable. Run npm run build.</p>"); }
  }

  app.get("/", async (request, reply) => {
    const supplied = (request.query as Record<string, unknown>)?.token;
    if (supplied !== undefined) {
      if (!timingSafeToken(token, supplied)) return reply.code(401).send({ error: "Invalid token" });
      setTokenCookie(reply, token); reply.redirect("/"); return;
    }
    if (!timingSafeToken(token, requestToken(request))) return reply.code(401).send({ error: "Authentication required" });
    await spa(reply);
  });
  app.get("/api/auth/bind", async (request, reply) => {
    const supplied = (request.query as Record<string, unknown>)?.token;
    if (!timingSafeToken(token, supplied)) return reply.code(401).send({ error: "Invalid token" });
    setTokenCookie(reply, token); return { ok: true };
  });
  app.get("/api/me", async () => ({ home }));
  app.get("/api/me/avatar", async (_request, reply) => {
    try { return reply.type("image/png").send(await readFile(join(stateDir, "me-avatar.png"))); }
    catch {
      const initials = escapeHtml(basename(home).slice(0, 2).toUpperCase());
      return reply.type("image/svg+xml").header("Cache-Control", "private, max-age=3600").send(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="8" fill="#1aad19"/><text x="48" y="61" text-anchor="middle" font-family="sans-serif" font-size="36" fill="#07180d">${initials}</text></svg>`);
    }
  });
  app.get("/api/sessions", sessionView);
  app.get("/api/sessions/:id/tail", async request => {
    const { id } = request.params as { id: string }; assertSessionId(id); const session = await index.resolve(id); if (!session) throw new RpcError(404, "Session not found");
    return readTail(session.path, Number((request.query as Record<string, unknown>).n ?? 200));
  });
  app.get("/api/sessions/:id/range", async request => {
    const { id } = request.params as { id: string }; assertSessionId(id); const session = await index.resolve(id); if (!session) throw new RpcError(404, "Session not found");
    const query = request.query as Record<string, unknown>; return readRange(session.path, Number(query.from ?? 0), query.to === undefined ? undefined : Number(query.to));
  });

  const objectBody = (request: FastifyRequest) => asRecord(request.body) ?? {};
  async function attachments(value: unknown, agent: "claude" | "codex"): Promise<unknown[]> {
    if (!Array.isArray(value)) return [];
    if (value.length > 8) throw new RpcError(413, "Too many attachments");
    const validated: unknown[] = []; let totalBytes = 0; let codexDirectory: string | undefined;
    for (const raw of value) {
      const decoded = decodeAttachmentPayload(raw); totalBytes += decoded.bytes.length; if (totalBytes > 40 * 1024 * 1024) throw new RpcError(413, "Attachments exceed the 40 MiB request limit");
      if (agent === "claude") validated.push({ name: decoded.name, type: decoded.type, data: decoded.data });
      else {
        if (!decoded.type.startsWith("image/")) throw new RpcError(501, "This Codex app-server accepts local images but not PDF inputs");
        const extension = decoded.type === "image/png" ? ".png" : decoded.type === "image/webp" ? ".webp" : decoded.type === "image/gif" ? ".gif" : ".jpg";
        if (!codexDirectory) { const root = join(stateDir, "attachments"); await mkdir(root, { recursive: true, mode: 0o700 }); codexDirectory = join(root, crypto.randomUUID()); await mkdir(codexDirectory, { mode: 0o700 }); const [actualRoot, actualDir] = await Promise.all([realpath(root), realpath(codexDirectory)]); if (!isWithin(actualRoot, actualDir)) throw new RpcError(403, "Unsafe attachment directory"); }
        const path = join(codexDirectory, `${crypto.randomUUID()}${extension}`);
        await writeFile(path, decoded.bytes, { mode: 0o600 }); validated.push(await realpath(path));
      }
    }
    return validated;
  }
  async function normalizeCwd(input: unknown): Promise<string> {
    if (typeof input !== "string" || input.includes("\0")) throw new RpcError(400, "Invalid working directory");
    let actual: string; try { actual = await realpath(resolve(expandHome(input, home))); } catch { throw new RpcError(404, "Working directory does not exist"); }
    const info = await stat(actual); if (!info.isDirectory()) throw new RpcError(400, "Working directory is not a directory");
    explicitRoots.add(actual);
    extraRoots.add(actual);
    return actual;
  }
  async function newSession(args: Record<string, unknown>) {
    const cwd = await normalizeCwd(args.cwd); const prompt = asString(args.prompt) ?? ""; const agent = args.agent === "codex" ? "codex" : "claude";
    const files = await attachments(args.images, agent);
    const prefs = await state.prefs.get();
    if (agent === "codex") {
      return codex.newSession(cwd, prompt, {
        model: settingValue(args.model, "Model") ?? settingValue(prefs.defaultCodexModel, "Model"),
        effort: reasoningEffort(args.effort) ?? reasoningEffort(prefs.defaultCodexEffort),
        approvalPolicy: codexApproval(settingValue(args.permissionMode, "Codex approval") ?? prefs.defaultCodexApprovalPreset),
        sandboxMode: codexSandbox(settingValue(args.sandboxMode, "Codex sandbox") ?? prefs.defaultCodexSandboxMode),
        cwd,
      }, files as string[]);
    }
    if (!prompt && !files.length) throw new RpcError(400, "Claude requires a prompt or attachment when materializing a session");
    return claude.newSession(cwd, prompt, {
      model: settingValue(args.model, "Model") ?? settingValue(prefs.defaultClaudeModel, "Model"),
      effort: reasoningEffort(args.effort) ?? reasoningEffort(prefs.defaultClaudeEffort),
      permissionMode: claudePermission(settingValue(args.permissionMode, "Claude permission") ?? prefs.defaultClaudePermissionMode),
      images: files,
    });
  }
  async function promptSession(id: string, args: Record<string, unknown>) {
    assertSessionId(id); const session = await index.resolve(id); if (!session) throw new RpcError(404, "Session not found");
    const prompt = asString(args.prompt) ?? ""; const files = await attachments(args.images, session.agent); if (!prompt.trim() && !files.length) throw new RpcError(400, "Prompt is empty");
    const settings = (await state.settings.get())[id]; const prefs = await state.prefs.get();
    return session.agent === "codex"
      ? codex.prompt(id, prompt, {
        model: settingValue(args.model, "Model") ?? settings?.model ?? prefs.defaultCodexModel,
        effort: reasoningEffort(args.effort) ?? settings?.effort ?? prefs.defaultCodexEffort,
        approvalPolicy: codexApproval(settingValue(args.permissionMode, "Codex approval") ?? settings?.permissionMode ?? prefs.defaultCodexApprovalPreset),
        sandboxMode: codexSandbox(settingValue(args.sandboxMode, "Codex sandbox") ?? settings?.sandboxMode ?? prefs.defaultCodexSandboxMode),
        cwd: session.cwd,
      }, files as string[], asString(args.clientUuid))
      : claude.prompt(id, session.cwd, prompt, {
        model: settingValue(args.model, "Model") ?? settings?.model ?? prefs.defaultClaudeModel,
        effort: reasoningEffort(args.effort) ?? settings?.effort ?? prefs.defaultClaudeEffort,
        permissionMode: claudePermission(settingValue(args.permissionMode, "Claude permission") ?? settings?.permissionMode ?? prefs.defaultClaudePermissionMode),
        clientUuid: asString(args.clientUuid),
        images: files,
      });
  }
  async function stopSession(id: string) {
    assertSessionId(id); const session = await index.resolve(id); if (!session) throw new RpcError(404, "Session not found");
    if (session.agent === "codex") await codex.stop(id); else claude.stop(id); return { ok: true };
  }
  app.post("/api/sessions/new", async request => newSession(objectBody(request)));
  app.post("/api/sessions/:id/prompt", async request => promptSession((request.params as { id: string }).id, objectBody(request)));
  app.post("/api/sessions/:id/stop", async request => stopSession((request.params as { id: string }).id));
  app.get("/api/preferences", async () => state.prefs.get());
  app.put("/api/preferences", async request => { await state.prefs.put(normalizePrefs(request.body)); return { ok: true }; });
  app.post("/api/refresh", async () => { await index.scan(); return { sessions: await sessionView() }; });
  app.get("/api/sessions/:id/export", async (request, reply) => {
    const id = (request.params as { id: string }).id; const markdown = await markdownExport(index, id);
    reply.header("Content-Disposition", `attachment; filename="${id}.md"`).type("text/markdown; charset=utf-8").send(markdown);
  });
  app.get("/api/local-file", async request => {
    const query = request.query as Record<string, unknown>; return readLocalSource(String(query.path ?? ""), [...extraRoots], query.line === undefined ? undefined : Number(query.line));
  });
  app.get("/local-file", async (request, reply) => {
    const query = request.query as Record<string, unknown>; const source = await readLocalSource(String(query.path ?? ""), [...extraRoots], query.line === undefined ? undefined : Number(query.line));
    reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'").type("text/html").send(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(String(source.name))}</title><style>body{margin:0;font:14px/1.55 ui-monospace,monospace;background:#1f1f1f;color:#eee}pre{padding:16px;white-space:pre-wrap}</style><pre id="source"></pre><script>document.getElementById('source').textContent=${safeBootJson(source.content)}</script>`);
  });
  async function imagePath(sessionId: string, filename: unknown): Promise<string> {
    assertSessionId(sessionId); safeFilename(filename); const session = await index.resolve(sessionId); if (!session) throw new RpcError(404, "Session not found");
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
  app.get("/api/codex-image", async (request, reply) => {
    const query = request.query as Record<string, unknown>; const path = String(query.path ?? "");
    const source = await resolveLocalFile(path, [...extraRoots]);
    if (!/\.(png|jpe?g|gif|webp)$/i.test(source.path)) throw new RpcError(415, "Unsupported image type");
    if (source.size > 20 * 1024 * 1024) throw new RpcError(413, "Image is too large");
    const mime = /\.png$/i.test(source.path) ? "image/png" : /\.gif$/i.test(source.path) ? "image/gif" : /\.webp$/i.test(source.path) ? "image/webp" : "image/jpeg";
    return reply.type(mime).send(await readFile(source.path));
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
    assertSessionId(sessionId); const session = await index.resolve(sessionId); if (!session) throw new RpcError(404, "Session not found");
    let map = subscriptions.get(socket); if (!map) { map = new Map(); subscriptions.set(socket, map); }
    const previous = map.get(sessionId); map.delete(sessionId); if (previous) void previous.stop();
    const tailer = new JsonlTailer(session.path, { from: Math.max(0, from), tailN }, event => {
      if (event.type === "stream-line") send(socket, { ...event, sessionId });
      else if (event.type === "stream-batch") send(socket, { ...event, sessionId, lines: event.lines.map(line => ({ index: line.index, data: line.raw })) });
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
    const session = await index.resolve(sessionId); if (!session) throw new RpcError(404, "Session not found");
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
      case "new-session": return newSession(args);
      case "prompt": return promptSession(String(args.sessionId ?? ""), args);
      case "stop": return stopSession(String(args.sessionId ?? ""));
      case "kill": { const id = String(args.sessionId ?? ""); assertSessionId(id); const session = await index.resolve(id); if (!session) throw new RpcError(404, "Session not found"); if (session.agent === "codex") throw new RpcError(501, "A shared Codex app-server cannot be killed per session"); claude.kill(id); return {}; }
      case "compact-session": { const id = String(args.sessionId ?? ""); assertSessionId(id); const session = await index.resolve(id); if (!session) throw new RpcError(404, "Session not found"); if (session.agent === "codex") await codex.compact(id); else await claude.compact(id, session.cwd); return {}; }
      case "cli-info": return cliInfo(String(args.sessionId ?? ""), String(args.topic ?? "version"));
      case "get-background-tasks": {
        const id = String(args.sessionId ?? "");
        assertSessionId(id);
        const session = await index.resolve(id);
        if (!session) throw new RpcError(404, "Session not found");
        await ensureTaskHistory(session);
        return { tasks: state.tasks.get(id) ?? [] };
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
            permissionMode: prefs.defaultCodexApprovalPreset || capabilities.defaults.permissionMode,
            sandboxMode: prefs.defaultCodexSandboxMode || capabilities.defaults.sandboxMode,
          },
        };
      }
      case "set-model": {
        const id = String(args.sessionId ?? ""); assertSessionId(id); const model = settingValue(args.model, "Model") ?? "";
        const session = await index.resolve(id); if (!session) throw new RpcError(404, "Session not found"); if (session.agent === "codex") await codex.updateSettings(id, { model: model || null, cwd: session.cwd });
        await state.settings.update(all => { const current = all[id] ?? {}; if (model) current.model = model; else delete current.model; all[id] = current; });
        pubsub.push({ type: "session-settings", kind: "session-settings", id, ...(await state.settings.get())[id] }); return { applies: session.agent === "claude" ? "next-process" : "immediately" };
      }
      case "set-effort": {
        const id = String(args.sessionId ?? ""); assertSessionId(id); const effort = reasoningEffort(args.effort) ?? "";
        const session = await index.resolve(id); if (!session) throw new RpcError(404, "Session not found"); if (session.agent === "codex") await codex.updateSettings(id, { effort: effort || null, cwd: session.cwd });
        await state.settings.update(all => { const current = all[id] ?? {}; if (effort) current.effort = effort; else delete current.effort; all[id] = current; });
        pubsub.push({ type: "session-settings", kind: "session-settings", id, ...(await state.settings.get())[id] }); return { applies: session.agent === "claude" ? "next-process" : "immediately" };
      }
      case "set-permission-mode": {
        const id = String(args.sessionId ?? ""); assertSessionId(id); const rawMode = settingValue(args.mode, "Permission mode");
        const session = await index.resolve(id); if (!session) throw new RpcError(404, "Session not found");
        const mode = session.agent === "codex" ? codexApproval(rawMode) ?? "" : claudePermission(rawMode) ?? "";
        if (session.agent === "codex") await codex.updateSettings(id, { approvalPolicy: mode || null, cwd: session.cwd });
        await state.settings.update(all => { const current = all[id] ?? {}; if (mode) current.permissionMode = mode; else delete current.permissionMode; all[id] = current; });
        pubsub.push({ type: "session-settings", kind: "session-settings", id, ...(await state.settings.get())[id] }); return { applies: session.agent === "claude" ? "next-process" : "immediately" };
      }
      case "set-sandbox-mode": {
        const id = String(args.sessionId ?? ""); assertSessionId(id); const rawMode = settingValue(args.mode, "Sandbox mode");
        const session = await index.resolve(id); if (!session) throw new RpcError(404, "Session not found");
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
      case "delete-sessions": return deleteSessions(index, claude, Array.isArray(args.sessionIds) ? args.sessionIds : [], id => codex.isActive(id));
      case "set-title": {
        const id = String(args.sessionId ?? ""); assertSessionId(id); if (!await index.resolve(id)) throw new RpcError(404, "Session not found"); const title = String(args.title ?? "").trim().slice(0, 120);
        await state.titles.update(all => { if (title) all[id] = { title, source: "manual" }; else delete all[id]; }); pubsub.push({ type: "session-renamed", kind: "session-renamed", id, title: title || null }); return { title: title || null };
      }
      case "get-title": { const title = (await state.titles.get())[String(args.sessionId ?? "")]?.title ?? null; return { title }; }
      case "mark-read": {
        const id = String(args.sessionId ?? ""); assertSessionId(id); const at = asString(args.at) ?? new Date().toISOString(); await state.reads.update(all => { all[id] = { at }; }); pubsub.push({ type: "session-read", kind: "session-read", id, at }); return { ok: true };
      }
      case "retitle-session": { const id = String(args.sessionId ?? ""); pubsub.push({ type: "session-retitling", kind: "session-retitling", id, inflight: true }); try { return { title: await autoTitle(index, state, id, true) }; } finally { pubsub.push({ type: "session-retitling", kind: "session-retitling", id, inflight: false }); } }
      case "retitle-all": {
        const titles = await state.titles.get(); let queued = 0; let skippedManual = 0;
        for (const session of index.list()) if (titles[session.id]?.source === "manual") skippedManual++; else { queued++; void autoTitle(index, state, session.id, true).then(title => pubsub.push({ type: "session-renamed", kind: "session-renamed", id: session.id, title })); }
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
          return await searchSessions(index, String(args.query ?? ""), { signal: controller.signal });
        } catch (error) {
          if ((error as { name?: unknown })?.name === "AbortError") throw new RpcError(499, "Search superseded");
          throw error;
        } finally {
          if (searchControllers.get(socket) === controller) searchControllers.delete(socket);
        }
      }
      case "read-tail": { const id = String(args.sessionId ?? ""); assertSessionId(id); const session = await index.resolve(id); if (!session) throw new RpcError(404, "Session not found"); return readTail(session.path, Number(args.n ?? 200)); }
      case "read-range": { const id = String(args.sessionId ?? ""); assertSessionId(id); const session = await index.resolve(id); if (!session) throw new RpcError(404, "Session not found"); return readRange(session.path, Number(args.from ?? 0), Number(args.to ?? Number.MAX_SAFE_INTEGER)); }
      case "get-prefs": return state.prefs.get();
      case "put-prefs": await state.prefs.put(normalizePrefs(args.prefs)); return undefined;
      case "get-me": return { home };
      case "get-session-skills": {
        const suppliedCwd = asString(args.cwd);
        if (suppliedCwd) return { skills: await skills(await normalizeCwd(suppliedCwd)) };
        const id = String(args.sessionId ?? "");
        assertSessionId(id);
        const session = await index.resolve(id);
        if (!session) throw new RpcError(404, "Session not found");
        return { skills: await skills(session.cwd) };
      }
      case "rephrase": { const text = asString(args.text) ?? asString(args.input) ?? ""; return { text: text.trim().replace(/[ \t]+/g, " ") }; }
      case "subscribe": {
        if (args.channel === "global") {
          pubsub.addGlobal(socket, typeof args.notifSinceSeq === "number" ? args.notifSinceSeq : undefined);
          for (const [id, status] of state.status) send(socket, { type: "session-status", kind: "session-status", id, ...status });
          for (const interaction of state.interactions.values()) send(socket, interactionAddedPush(interaction));
          for (const [sessionId, tasks] of state.tasks) send(socket, { type: "background-tasks", kind: "background-tasks", sessionId, tasks });
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
        pubsub.push({ type: "background-tasks", kind: "background-tasks", sessionId: event.id, tasks });
      }
    }
  });
  codex.on("status", status);
  for (const driver of [claude, codex]) {
    driver.on("interaction-added", interaction => pubsub.push(interactionAddedPush(interaction)));
    driver.on("interaction-removed", interaction => pubsub.push({ type: "interaction-removed", kind: "interaction-removed", ...interaction }));
  }
  codex.on("background", event => {
    const tasks = mergeCodexBackgroundTask(state.tasks.get(event.sessionId) ?? [], event.method, event.params);
    state.tasks.set(event.sessionId, tasks);
    pubsub.push({ type: "background-tasks", kind: "background-tasks", sessionId: event.sessionId, tasks });
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
    pubsub.push({ type: "background-tasks", kind: "background-tasks", sessionId, tasks });
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
      pubsub.push({
        type: "session-touched",
        kind: "session-touched",
        id: event.sessionId,
        ...(session ? { session: { ...session, path: undefined, peer: event.peer } } : { session: { peer: event.peer } }),
      });
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
        if (!prefs.autoTitleEnabled || titles[sessionId]?.source === "manual") continue;
        const turns = (autoTitleTurns.get(sessionId) ?? 0) + trigger.turns;
        autoTitleTurns.set(sessionId, turns);
        const frequency = Math.max(1, Math.floor(prefs.autoTitleFrequency || 1));
        if (trigger.initial && titles[sessionId]) continue;
        if (titles[sessionId] && turns < frequency) continue;
        // Automatic titles consume the already-observed prompt text. They must
        // never rebuild/read the whole transcript on a live append.
        const title = await autoTitleFromText(index, state, sessionId, trigger.text);
        autoTitleTurns.set(sessionId, 0);
        if (title) pubsub.push({ type: "session-renamed", kind: "session-renamed", id: sessionId, title });
      }
    })().catch(() => undefined).finally(() => {
      autoTitleWork.delete(sessionId);
      if (autoTitlePending.has(sessionId)) setImmediate(() => startAutoTitleWork(sessionId));
    });
  }
  function scheduleAutoTitle(sessionId: string, promptText: string, initial = false): void {
    const text = promptText.trim();
    if (!text) return;
    const queued = autoTitlePending.get(sessionId);
    autoTitlePending.set(sessionId, {
      text,
      turns: (queued?.turns ?? 0) + (initial ? 0 : 1),
      initial: (queued?.initial ?? false) || initial,
    });
    startAutoTitleWork(sessionId);
  }
  index.on("added", session => {
    trackSessionRoot(session);
    lastSizes.set(session.id, session.size);
    pubsub.push({ type: "session-added", kind: "session-added", session: { ...session, path: undefined, peer: foreignClaudeSessions.has(session.id), ...state.status.get(session.id) } });
    if (initialDiscoveryComplete) scheduleAutoTitle(session.id, session.preview ?? "", true);
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
      const userPrompts: string[] = [];
      for (const line of appended.slice(0, lastNewline + 1).split(/\r?\n/)) {
        try {
          const record = asRecord(JSON.parse(line)); if (!record) continue; const payload = asRecord(record.payload);
          const promptText = appendPromptText(record, session.agent);
          if (promptText) userPrompts.push(promptText);
          if (session.agent === "claude") {
            const priorTasks = state.tasks.get(session.id) ?? [];
            const tasks = mergeClaudeBackgroundTasks(priorTasks, record);
            if (tasks !== priorTasks) {
              state.tasks.set(session.id, tasks);
              pubsub.push({ type: "background-tasks", kind: "background-tasks", sessionId: session.id, tasks });
            }
          }
          const uuid = asString(record.uuid) ?? asString(payload?.id) ?? `${session.id}:${record.timestamp}`; if (!isMeaningfulEndTurnRecord(record, session.agent) || notificationUuids.seen(uuid)) continue;
          pubsub.notify({ id: session.id, cwd: session.cwd, title: session.title ?? null, body: session.preview ?? "Turn completed", uuid, timestamp: asString(record.timestamp) ?? new Date().toISOString() });
        } catch { /* isolate malformed or incomplete records */ }
      }
      for (const promptText of userPrompts) scheduleAutoTitle(session.id, promptText);
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
    pubsub.push({
      type: "session-touched",
      kind: "session-touched",
      id: session.id,
      session: {
        id: session.id,
        cwd: session.cwd,
        mtime: session.mtime,
        size: session.size,
        agent: session.agent,
        preview: session.preview,
        lastTurnAt: session.lastTurnAt,
        parentSessionId: session.parentSessionId,
      },
    });
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
    untrackSessionRoot(session.id);
    lastSizes.delete(session.id);
    notificationTrailing.delete(session.id);
    notificationPending.delete(session.id);
    taskHistoryLoaded.delete(session.id);
    autoTitlePending.delete(session.id);
    autoTitleTurns.delete(session.id);
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
      pubsub.push({
        type: "interaction-removed",
        kind: "interaction-removed",
        sessionId: interaction.sessionId,
        requestId: interaction.requestId,
      });
    }
    for (const map of subscriptions.values()) {
      const tailer = map.get(session.id);
      map.delete(session.id);
      if (tailer) void tailer.stop();
    }
  });
  index.on("touched", scheduleNotificationAppend);
  let backgroundStartupTimer: NodeJS.Timeout | undefined;
  let backgroundStartupWork: Promise<void> | undefined;
  let closing = false;
  if (options.startWatchers === false) {
    // Tests and explicit one-shot callers need a complete deterministic
    // snapshot before buildApp resolves.
    await index.scan();
    for (const session of index.list()) {
      trackSessionRoot(session);
      lastSizes.set(session.id, session.size);
    }
    initialDiscoveryComplete = true;
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
          await index.start();
          if (closing) return;
          await claudeProcesses.start();
          if (closing) return;
          try {
            await index.scan({ incremental: true });
          } finally {
            initialDiscoveryComplete = true;
          }
        })().catch(error => {
          if (!closing) app.log.error({ err: error }, "Background session discovery failed");
        });
      }, 100);
      backgroundStartupTimer.unref?.();
    });
  }

  let staticReady = false;
  try { if ((await stat(frontendDist)).isDirectory()) { await app.register(fastifyStatic, { root: frontendDist, prefix: "/", index: false, wildcard: false, immutable: true, maxAge: "1y" }); staticReady = true; } } catch { /* frontend is built later */ }
  if (staticReady) app.get("/assets/*", async (request, reply) => {
    const path = rawPath(request); if (!/^\/assets\/[A-Za-z0-9._/-]+$/.test(path) || path.includes("..")) throw new RpcError(404, "Asset not found");
    return reply.header("Cache-Control", "public, max-age=31536000, immutable").sendFile(path.slice(1));
  });
  app.get("/*", async (request, reply) => {
    const path = rawPath(request); if (path.startsWith("/api/") || path === "/api" || path.startsWith("/assets/")) return reply.code(404).send({ error: "Not found" });
    await spa(reply);
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
    claude.close(); codex.close();
    await flushLineIndexPersistence();
  });
  return app;
}
