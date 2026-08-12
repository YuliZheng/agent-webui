import type {
  AgentCapabilities,
  AgentKind,
  CliInfoResult,
  CliInfoTopic,
  CodexGoal,
  CodexGoalStatus,
  CodexRateLimits,
  ForkResponse,
  RewindResponse,
  SessionListItem,
  UserMessageInfo,
} from "@claude-webui/shared/api";
import { DEFAULT_FORWARDED_SLASH_COMMANDS as DEFAULT_SLASH_COMMANDS } from "@claude-webui/shared/api";
import { request, WsError } from "./ws.js";
import type { ContextUsage } from "../util/local-commands.js";

// A cold Codex send can legitimately perform initialize + thread/resume +
// turn/start serially (each has a 20s backend ceiling), with a short active-turn
// readiness wait in between. Keep the browser deadline above that full chain;
// otherwise the UI can report failure while the backend accepts the prompt a
// few seconds later.
const PROMPT_TIMEOUT_MS = 90_000;
const CODEX_GOAL_TIMEOUT_MS = 60_000;
// Long timeout for new-session: agent spawn + first-turn setup can take a
// while on a cold start; a truly stuck socket is caught independently by the
// WS pong timeout (~15-24s → reconnect), so the long ceiling only ever
// applies when the backend is genuinely still working.
const NEW_SESSION_TIMEOUT_MS = 200_000;

export interface OutgoingImage { mime: string; data: string /* base64 */ }

export async function listSessions(): Promise<SessionListItem[]> {
  // Session list refreshes must not depend on the WebSocket. Mobile Safari can
  // resume from lock screen with a half-dead WS that still looks OPEN, leaving
  // the homepage frozen until a full reload. The REST route uses the same
  // backend action as `get-sessions` but rides a fresh HTTP request, so
  // resume/focus retries can refresh the sidebar immediately.
  const res = await fetch("/api/sessions", {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) {
    let message = `list sessions failed: ${res.status}`;
    try {
      const body = await res.json() as { message?: unknown };
      if (typeof body.message === "string" && body.message) message = body.message;
    } catch { /* ignore */ }
    throw new Error(message);
  }
  return res.json() as Promise<SessionListItem[]>;
}

function slashCommandName(prompt: string): string {
  if (!prompt.startsWith("/")) return "";
  const token = prompt.slice(1).split(/\s+/, 1)[0] ?? "";
  // Path-like strings such as /home/me are ordinary prompts, not commands.
  if (!token || token.includes("/")) return "";
  return token.toLowerCase();
}

export function isForwardedSlashCommand(
  prompt: string,
  extraCommands: readonly string[] = [],
): boolean {
  const name = slashCommandName(prompt);
  if (!name) return false;
  const allowed = new Set<string>([
    ...DEFAULT_SLASH_COMMANDS,
    ...extraCommands,
  ].map((s) => s.toLowerCase()));
  return allowed.has(name);
}

// Claude SDK parses any user message whose first character is `/` as a
// slash command (claude.ai/docs concepts/slash-commands). Hitting an
// unknown one (e.g. "/cd" pasted from our own setup docs) just produces a
// silent "Unknown command" system entry and no assistant turn — the user
// sees their bubble flash and disappear with no reply. Webui doesn't
// surface those commands as a UI affordance, and the user is almost
// always typing conversational text that just happened to start with `/`,
// so prepend a single space. Slack-originated prompts skip this layer
// entirely (slack-poller → submitPrompt directly), so a Slack reply that
// genuinely intends a slash command is preserved.
//
// Exception: a small allowlist of real built-ins (e.g. `/compact`) is
// forwarded verbatim so they actually execute. We also strip a trailing
// space — the slash menu inserts "/<name> " — since a bare command sent
// with trailing whitespace can fail to be recognized.
function escapeSlashCommand(prompt: string, extraCommands: readonly string[] = []): string {
  if (!prompt.startsWith("/")) return prompt;
  if (isForwardedSlashCommand(prompt, extraCommands)) return prompt.trimEnd();
  return ` ${prompt}`;
}

// Canonicalize a user-supplied cwd via the backend (expand ~, resolve
// symlinks). Used before creating a pending draft so the draft's cwd matches
// the fully-resolved cwd the watcher reports for the spawned session — the
// equality the draft→real reconciliation in live.ts depends on.
export async function normalizeCwd(cwd: string): Promise<string> {
  const r = await request<{ cwd: string }>("normalize-cwd", { cwd });
  return r.cwd;
}

// Live directory completion for the new-session cwd field. Returns matching
// sub-directories of the typed parent, in the same leading form the user
// typed (~, /abs, relative). Best-effort: backend returns [] on fs errors.
export async function completePath(input: string): Promise<string[]> {
  const r = await request<{ paths: string[] }>("complete-path", { path: input });
  return r?.paths ?? [];
}

export async function newSession(req: {
  cwd: string;
  prompt: string;
  images?: OutgoingImage[];
  slashCommands?: readonly string[];
  clientUuid?: string;
  agent?: "claude" | "codex";
  // Pre-spawn model / permission / effort picks from the draft pill row.
  // Applied by the backend at spawn time and persisted as session override.
  model?: string;
  permissionMode?: string;
  effort?: string;
  serviceTier?: string;
}, onDispatched?: () => void): Promise<{ sessionId: string }> {
  const payload: Record<string, unknown> = {
    cwd: req.cwd,
    prompt: escapeSlashCommand(req.prompt, req.slashCommands),
    images: req.images ?? [],
  };
  if (req.clientUuid) payload.clientUuid = req.clientUuid;
  if (req.agent) payload.agent = req.agent;
  if (req.model) payload.model = req.model;
  if (req.permissionMode) payload.permissionMode = req.permissionMode;
  if (req.effort) payload.effort = req.effort;
  // An explicit empty value means Fast off, distinct from an omitted value
  // which inherits the Settings default for a new Codex session.
  if (req.serviceTier !== undefined) payload.serviceTier = req.serviceTier;
  return request<{ sessionId: string }>(
    "new-session",
    payload,
    onDispatched
      ? {
          timeoutMs: NEW_SESSION_TIMEOUT_MS,
          onSent: onDispatched,
          ...(req.clientUuid ? { retryOnReconnect: true } : {}),
        }
      : {
          timeoutMs: NEW_SESSION_TIMEOUT_MS,
          ...(req.clientUuid ? { retryOnReconnect: true } : {}),
        },
  );
}

export async function sendPrompt(
  id: string,
  prompt: string,
  images?: OutgoingImage[],
  clientUuid?: string,
  slashCommands?: readonly string[],
  onDispatched?: () => void,
): Promise<void> {
  const params: Record<string, unknown> = { sessionId: id, prompt: escapeSlashCommand(prompt, slashCommands), images: images ?? [] };
  // Idempotency: bridges WS-flap retries so the backend can dedupe a
  // resend whose original arrived but whose ack we lost. Without this, a
  // mobile suspend mid-send would queue→retry→retry until claude finishes,
  // and each retry that wins the race spawns a duplicate turn.
  if (clientUuid) params.clientUuid = clientUuid;
  await request(
    "prompt",
    params,
    onDispatched
      ? {
          timeoutMs: PROMPT_TIMEOUT_MS,
          onSent: onDispatched,
          ...(clientUuid ? { retryOnReconnect: true } : {}),
        }
      : {
          timeoutMs: PROMPT_TIMEOUT_MS,
          ...(clientUuid ? { retryOnReconnect: true } : {}),
        },
  );
}

export async function stopSession(id: string): Promise<void> {
  await request("stop", { sessionId: id });
}

// Fire-and-forget cross-device read watermark. `at` is the session's
// lastTurnAt at read time. We don't await success: a failed RPC just means the
// watermark lags on the server, which the next list-load reconciles. The
// backend broadcasts `session-read` to every other connected device.
export function markReadRemote(id: string, at: string): void {
  if (!id || !at) return;
  void request("mark-read", { sessionId: id, at }).catch(() => { /* best-effort */ });
}

export async function compactSession(id: string): Promise<void> {
  await request("compact-session", { sessionId: id }, { timeoutMs: 12_000 });
}

export type { CodexGoal, CodexGoalStatus };

export async function getSessionGoal(id: string): Promise<CodexGoal | null> {
  const r = await request<{ goal: CodexGoal | null }>(
    "codex-goal-get",
    { sessionId: id },
    { timeoutMs: CODEX_GOAL_TIMEOUT_MS },
  );
  return r.goal;
}

export async function setSessionGoal(
  id: string,
  params: { objective?: string | null; status?: CodexGoalStatus | null; tokenBudget?: number | null },
): Promise<CodexGoal> {
  const r = await request<{ goal: CodexGoal }>(
    "codex-goal-set",
    { sessionId: id, ...params },
    { timeoutMs: CODEX_GOAL_TIMEOUT_MS },
  );
  return r.goal;
}

export async function clearSessionGoal(id: string): Promise<void> {
  await request(
    "codex-goal-clear",
    { sessionId: id },
    { timeoutMs: CODEX_GOAL_TIMEOUT_MS },
  );
}

// SIGTERM the long-lived webui-spawned claude for this session. Unlike
// stopSession (which sends an interrupt control_request and keeps the
// process alive), this kills it outright. Backend 404s if no webui-owned
// process is alive.
export async function killSession(id: string): Promise<void> {
  await request("kill", { sessionId: id });
}

// Per-session pill-row RPCs. Empty string means "clear override and fall
// back to global default".
export async function setSessionModel(id: string, model: string): Promise<void> {
  await request("set-model", { sessionId: id, model });
}

export async function setSessionPermissionMode(id: string, mode: string): Promise<void> {
  await request("set-permission-mode", { sessionId: id, mode });
}

export async function setSessionEffort(id: string, effort: string): Promise<void> {
  await request("set-effort", { sessionId: id, effort });
}

export async function setSessionServiceTier(id: string, serviceTier: "" | "priority"): Promise<"next-turn"> {
  const result = await request<{ applies: "next-turn" }>("set-service-tier", { sessionId: id, serviceTier });
  return result.applies;
}

export async function getAgentCapabilities(agent: AgentKind, cwd?: string): Promise<AgentCapabilities> {
  return request<AgentCapabilities>("get-agent-capabilities", {
    agent,
    ...(cwd ? { cwd } : {}),
  });
}

// Read-only CLI info (/mcp, /status, /doctor, …). Backend may invoke the CLI,
// which can take ~10s — give it a generous budget.
export async function getCliInfo(id: string, topic: CliInfoTopic): Promise<CliInfoResult> {
  return request<CliInfoResult>("cli-info", { sessionId: id, topic }, { timeoutMs: 30_000 });
}

export async function getCodexRateLimits(id: string): Promise<CodexRateLimits> {
  return request<CodexRateLimits>("get-codex-rate-limits", { sessionId: id }, { timeoutMs: 30_000 });
}

export interface DeleteSessionsResult {
  deleted: string[];
  failed: { id: string; reason: string }[];
}

// 60s timeout: per-id work is parallelized backend-side, but findJsonlPath
// walks every project dir on (potentially slow network) storage, so
// bulk-purging a couple-dozen hidden sessions can edge past the 15s default.
export async function deleteSessions(sessionIds: string[]): Promise<DeleteSessionsResult> {
  return request<DeleteSessionsResult>("delete-sessions", { sessionIds }, { timeoutMs: 60_000 });
}

export async function setSessionTitle(id: string, title: string): Promise<{
  title: string | null;
  titleSource: "auto" | "manual" | null;
  emoji: string | null;
}> {
  return request<{
    title: string | null;
    titleSource: "auto" | "manual" | null;
    emoji: string | null;
  }>("set-title", { sessionId: id, title });
}

// Force the auto-titler to re-run for this session, ignoring any manual lock.
// 60s timeout — the model call + transcript build can take a few seconds on
// a long jsonl, and we don't want to abort too eagerly.
export async function retitleSession(id: string): Promise<{
  title: string | null;
  titleSource: "auto" | "manual" | null;
  emoji: string | null;
}> {
  return request<{
    title: string | null;
    titleSource: "auto" | "manual" | null;
    emoji: string | null;
  }>("retitle-session", { sessionId: id }, { timeoutMs: 60_000 });
}

// Kick off bulk re-title of every auto-managed session. Returns immediately
// with the queue counts; actual titler calls run in the background and the
// sidebar lights up each row's spinner via session-retitling broadcasts as
// they progress.
export async function retitleAll(): Promise<{ queued: number; skippedManual: number }> {
  return request<{ queued: number; skippedManual: number }>("retitle-all", {}, { timeoutMs: 30_000 });
}

export async function listUserMessages(id: string): Promise<UserMessageInfo[]> {
  return request<UserMessageInfo[]>("get-user-messages", { sessionId: id });
}

export async function rewindSession(id: string, messageUuid: string): Promise<RewindResponse> {
  return request<RewindResponse>("rewind", { sessionId: id, messageUuid });
}

export async function forkSession(id: string, messageUuid: string): Promise<ForkResponse> {
  return request<ForkResponse>("fork", { sessionId: id, messageUuid });
}

export interface RephraseResponse { originalText: string; rephrasedText: string; model: string }

// Server-side rewrite of the last user prompt for a session via Haiku. Used
// by AssistantBlock's "Auto-rephrase" button when the previous turn came back
// as a Usage Policy refusal. 25s budget: Anthropic's 20s timeout + 5s slack.
const REPHRASE_TIMEOUT_MS = 25_000;
export async function rephrasePrompt(sessionId: string): Promise<RephraseResponse> {
  return request<RephraseResponse>("rephrase", { sessionId }, { timeoutMs: REPHRASE_TIMEOUT_MS });
}

export interface ContentMatch {
  id: string;
  score: number;
  lastMatchUuid: string | null;
  lastMatchIndex: number | null;
}

export async function searchContent(query: string): Promise<ContentMatch[]> {
  const r = await request<{ matches: ContentMatch[] }>("search-content", { query });
  return r?.matches ?? [];
}

export interface LineEntry { index: number; raw: string }
export interface TailResponse {
  totalLines: number;
  fromIndex: number;
  lines: LineEntry[];
  /** Absent on older servers; automatic gap repair must stay disabled there. */
  supportsCompactRange?: boolean;
}
export interface RangeResponse { totalLines: number; lines: LineEntry[] }
export type SessionTailPriority = "interactive" | "background";
export interface SessionRangeOptions { mode?: "compact" }
export interface FullContextUsageResponse extends ContextUsage {
  completeHistoryScan: true;
  recordsScanned: number;
  oversizedRecords: number;
  compactionCount: number;
}

const SESSION_TAIL_TIMEOUT_MS = 8_000;

// Fast initial-load: returns just the last `n` lines of a session jsonl.
// Used on first visit to avoid streaming every line of long conversations
// over WebSocket before paint.
export async function readSessionTail(
  id: string,
  n: number,
  priority: SessionTailPriority = "interactive",
): Promise<TailResponse> {
  const q = new URLSearchParams({ n: String(n), priority });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SESSION_TAIL_TIMEOUT_MS);
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/tail?${q.toString()}`, {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`read tail failed: ${res.status}`);
    return res.json() as Promise<TailResponse>;
  } finally {
    clearTimeout(timeout);
  }
}

// Used by "Load earlier" to fetch a contiguous older index range.
export async function readSessionRange(
  id: string,
  from: number,
  to: number,
  options: SessionRangeOptions = {},
): Promise<RangeResponse> {
  const q = new URLSearchParams({ from: String(from), to: String(to) });
  if (options.mode) q.set("mode", options.mode);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SESSION_TAIL_TIMEOUT_MS);
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/range?${q.toString()}`, {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`read range failed: ${res.status}`);
    return res.json() as Promise<RangeResponse>;
  } finally {
    clearTimeout(timeout);
  }
}

// Full-rollout, server-side streaming attribution. The response stays tiny:
// the backend returns only aggregate source rows, never the transcript.
export async function readFullCodexContextUsage(
  id: string,
  autoCompactLimit: number | null,
): Promise<FullContextUsageResponse> {
  const query = new URLSearchParams();
  if (autoCompactLimit !== null) query.set("autoCompactLimit", String(autoCompactLimit));
  const suffix = query.size ? `?${query.toString()}` : "";
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/context-usage${suffix}`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`context usage scan failed: ${res.status}`);
  return res.json() as Promise<FullContextUsageResponse>;
}

// Hit the backend's manual rescan endpoint. Pull-to-refresh on the sidebar
// fires this so the foreign-claude-scanner and responding-tracker re-walk
// state from disk, catching anything chokidar dropped.
export async function refreshBackend(): Promise<{ sessions: SessionListItem[] }> {
  const r = await fetch("/api/refresh", { method: "POST", credentials: "include" });
  if (!r.ok) throw new Error(`refresh failed: ${r.status}`);
  return r.json() as Promise<{ sessions: SessionListItem[] }>;
}

export { WsError as HttpError };
