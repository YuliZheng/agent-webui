import type { MessageDisplayStyle, PrefsBlob } from "./prefs.js";

export type AgentKind = "claude" | "codex";
export type ProcessStatus = "running" | "exited" | "failed";
export type ColorPreference = "light" | "dark" | "system";
export type { MessageDisplayStyle } from "./prefs.js";

// Keep browser preflight and backend enforcement on one contract. The decoded
// byte ceiling leaves room for base64/JSON overhead under the 64 MiB WebSocket
// frame limit.
export const MAX_CLAUDE_PROMPT_ATTACHMENTS = 8;
export const MAX_CODEX_PROMPT_ATTACHMENTS = 32;
export const MAX_PROMPT_ATTACHMENT_BYTES = 40 * 1024 * 1024;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface SessionListItem {
  id: string;
  cwd: string;
  mtime: string;
  size: number;
  agent: AgentKind;
  peer?: boolean;
  /** True for Codex worker threads spawned as subagents, not ordinary forks. */
  subagent?: boolean;
  title?: string | null;
  titleSource?: "auto" | "manual" | null;
  titleEmoji?: string | null;
  parentSessionId?: string | null;
  status?: ProcessStatus | null;
  preview?: string | null;
  previewRole?: "user" | "assistant" | null;
  lastTurnAt?: string | null;
  lastBoundaryAt?: string | null;
  readAt?: string | null;
  /** Server-authoritative unread assistant-turn count for this session. */
  unreadCount?: number;
}

export interface IndexedRawLine {
  index: number;
  raw: string;
}

/** Wire representation used by stream-line/stream-batch pushes. */
export interface StreamWireLine {
  index: number;
  data: string;
}

export interface UserMessageInfo {
  uuid: string;
  parentUuid: string | null;
  type: string;
  text: string;
}

export interface RewindResponse {
  removedRecords: number;
  truncatedBytes: number;
  prefillText: string;
}

export interface ForkResponse {
  newSessionId: string;
  prefillText: string;
}

export type ClaudePermissionMode =
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "manual"
  | "dontAsk"
  | "plan"
  | (string & {});

export type CodexApprovalPreset =
  | "untrusted"
  | "on-request"
  | "never"
  | (string & {});

export type CodexSandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access"
  | (string & {});

export interface AgentSelectOption {
  value: string;
  label: string;
  description?: string | null;
}

export interface AgentModelOption extends AgentSelectOption {
  supportedEfforts: AgentSelectOption[];
  /** Service-tier ids accepted by Codex app-server for this model. */
  serviceTiers?: AgentSelectOption[];
  defaultEffort?: string | null;
  defaultServiceTier?: string | null;
  isDefault?: boolean;
}

export interface AgentCapabilities {
  agent: AgentKind;
  models: AgentModelOption[];
  permissionModes: AgentSelectOption[];
  sandboxModes: AgentSelectOption[];
  defaults: {
    model?: string | null;
    effort?: string | null;
    serviceTier?: string | null;
    permissionMode?: string | null;
    sandboxMode?: string | null;
  };
}

export interface CodexThreadUsageGroup {
  model: string | null;
  reasoningEffort: string | null;
  speed: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  netNewInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  /** Estimated ChatGPT usage credits, expressed in millionths of one credit. */
  estimatedUsageCreditsMicros: number;
}

export interface CodexThreadUsage {
  threadId: string;
  /** Estimated ChatGPT usage credits, expressed in millionths of one credit. */
  estimatedUsageCreditsMicros: number;
  /** Estimated API-equivalent cost, expressed in millionths of one US dollar. */
  estimatedUsageUsdMicros: number | null;
  groups: CodexThreadUsageGroup[];
}

export interface CodexAccountUsageDailyBucket {
  /** UTC calendar date reported by Codex, normally YYYY-MM-DD. */
  startDate: string;
  tokens: number;
}

export interface CodexUsageOverview {
  threadUsage: CodexThreadUsage | null;
  dailyUsageBuckets: CodexAccountUsageDailyBucket[];
  accountLifetimeTokens: number | null;
}

export interface SessionSettings {
  sessionId: string;
  model: string | null;
  effort: string | null;
  serviceTier: string | null;
  permissionMode: string | null;
  sandboxMode: string | null;
}

export type BackgroundTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface BackgroundTask {
  id: string;
  /** Optional because get-background-tasks already scopes results by session. */
  sessionId?: string;
  status: BackgroundTaskStatus;
  title: string;
  description?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  progress?: number | null;
  output?: string | null;
  error?: string | null;
}

export interface CliInfoResult {
  title: string;
  markdown: string;
}

export type InteractionKind = "permission" | "question";

interface InteractionBase {
  sessionId: string;
  requestId: string;
  agent: AgentKind;
  kind: InteractionKind;
  createdAt: string;
  toolUseId?: string | null;
}

export interface PermissionInteraction extends InteractionBase {
  kind: "permission";
  toolName: string;
  input: unknown;
  command?: string | null;
  description?: string | null;
  choices?: string[];
}

export interface AskUserQuestionOption {
  label: string;
  description?: string | null;
}

export interface AskUserQuestionItem {
  id?: string;
  header?: string;
  question: string;
  multiSelect?: boolean;
  options?: AskUserQuestionOption[];
}

export interface QuestionInteraction extends InteractionBase {
  kind: "question";
  questions: AskUserQuestionItem[];
}

export type Interaction = PermissionInteraction | QuestionInteraction;
export type InteractionAnswer = JsonValue;

export type CodexGoalStatus = "active" | "complete" | "blocked";

/**
 * The app-server goal surface is optional and evolves independently from the
 * rollout format. Unknown server fields stay at the driver boundary; these are
 * the fields the WebUI consumes.
 */
export interface CodexGoal {
  objective: string;
  status: CodexGoalStatus;
  tokenBudget?: number | null;
  tokensUsed?: number | null;
  elapsedMs?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface CodexGoalInput {
  objective: string;
  status?: CodexGoalStatus;
  tokenBudget?: number | null;
}

export interface PromptImageInput {
  name?: string;
  type: string;
  /** A matching base64 data URL, for example data:image/png;base64,... */
  data: string;
}

export interface LocalFilePayload {
  path: string;
  name: string;
  content: string;
  size: number;
  line?: number | null;
  language?: string | null;
  truncated?: boolean;
}

export interface SessionSkill {
  name: string;
  description?: string | null;
  path?: string | null;
  source?: "user" | "project" | "plugin" | "system" | string;
  agent?: AgentKind | (string & {});
}

export interface SearchContentMatch {
  id: string;
  score: number;
  lastMatchUuid: string | null;
  /** Original physical JSONL line index of the latest matching record. */
  lastMatchIndex: number | null;
}

export interface DeleteSessionsResult {
  deleted: string[];
  failed: Array<{ id: string; message: string }>;
}

export interface RpcRequestPayloads {
  ping: { seq: number };
  "get-sessions": Record<string, never>;
  "normalize-cwd": { cwd: string };
  "complete-path": { path: string };
  "read-local-file": { path: string; line?: number };
  "reveal-local-path": { path: string };
  "new-session": {
    cwd: string;
    prompt: string;
    images?: PromptImageInput[];
    agent: AgentKind;
    model?: string;
    effort?: string;
    serviceTier?: string;
    permissionMode?: string;
    sandboxMode?: string;
    clientUuid?: string;
  };
  prompt: {
    sessionId: string;
    prompt: string;
    images?: PromptImageInput[];
    clientUuid?: string;
  };
  stop: { sessionId: string };
  kill: { sessionId: string };
  "compact-session": { sessionId: string };
  "cli-info": { sessionId: string; topic: string };
  "get-background-tasks": { sessionId: string };
  "codex-goal-get": { sessionId: string };
  "codex-goal-set": { sessionId: string } & CodexGoalInput;
  "codex-goal-clear": { sessionId: string };
  "get-agent-capabilities": { agent: AgentKind; cwd?: string };
  "set-model": { sessionId: string; model: string };
  "set-effort": { sessionId: string; effort: string };
  "set-service-tier": { sessionId: string; serviceTier: string };
  "set-permission-mode": { sessionId: string; mode: string };
  "set-sandbox-mode": { sessionId: string; mode: string };
  "interaction-respond": {
    sessionId: string;
    requestId: string;
    answer: InteractionAnswer;
  };
  "delete-sessions": { sessionIds: string[] };
  "set-title": { sessionId: string; title: string };
  "get-title": { sessionId: string };
  "mark-read": { sessionId: string; at: string };
  "retitle-session": { sessionId: string };
  "retitle-all": Record<string, never>;
  "get-user-messages": { sessionId: string };
  rewind: { sessionId: string; messageUuid: string };
  fork: { sessionId: string; messageUuid: string };
  "search-content": { query: string };
  "read-tail": { sessionId: string; n?: number };
  "read-range": { sessionId: string; from: number; to: number };
  "get-prefs": Record<string, never>;
  "put-prefs": { prefs: PrefsBlob };
  "get-me": Record<string, never>;
  "get-session-skills": {
    sessionId: string;
    cwd?: string;
    agent: AgentKind;
  };
  rephrase: {
    sessionId: string;
    text: string;
    instruction?: string;
  };
  subscribe:
    | { channel: "global"; notifSinceSeq?: number }
    | { channel: "session"; sessionId: string; from: number; tailN?: number };
  unsubscribe:
    | { channel: "global" }
    | { channel: "session"; sessionId: string };
}

export interface RpcResponsePayloads {
  ping: { seq: number };
  "get-sessions": SessionListItem[];
  "normalize-cwd": { cwd: string };
  "complete-path": { paths: string[] };
  "read-local-file": LocalFilePayload;
  "reveal-local-path": { path: string; kind: "file" | "directory" };
  "new-session": { sessionId: string };
  prompt:
    | { sessionId: string; queued: boolean; steered?: never }
    | { sessionId: string; steered: boolean; queued?: never };
  stop: { ok: true };
  kill: Record<string, never>;
  "compact-session": Record<string, never>;
  "cli-info": CliInfoResult;
  "get-background-tasks": { tasks: BackgroundTask[] };
  "codex-goal-get": { goal: CodexGoal | null };
  "codex-goal-set": { goal: CodexGoal };
  "codex-goal-clear": { goal: null };
  "get-agent-capabilities": AgentCapabilities;
  "set-model": { applies: "immediately" | "next-process" };
  "set-effort": { applies: "immediately" | "next-process" };
  "set-service-tier": { applies: "next-turn" };
  "set-permission-mode": { applies: "immediately" | "next-process" };
  "set-sandbox-mode": { applies: "immediately" | "next-process" };
  "interaction-respond": Record<string, never>;
  "delete-sessions": DeleteSessionsResult;
  "set-title": { title: string | null; titleSource: "auto" | "manual" | null; emoji: string | null };
  "get-title": { title: string | null; titleSource: "auto" | "manual" | null; emoji: string | null };
  "mark-read": { ok: true };
  "retitle-session": { title: string | null; titleSource: "auto" | "manual" | null; emoji: string | null };
  "retitle-all": { queued: number; skippedManual: number };
  "get-user-messages": UserMessageInfo[];
  rewind: RewindResponse;
  fork: ForkResponse;
  "search-content": { matches: SearchContentMatch[] };
  "read-tail": IndexedRawLine[];
  "read-range": IndexedRawLine[];
  "get-prefs": PrefsBlob;
  "put-prefs": undefined;
  "get-me": { home: string };
  "get-session-skills": { skills: SessionSkill[] };
  rephrase: { text: string };
  subscribe: undefined;
  unsubscribe: undefined;
}

export type RpcMethod = keyof RpcRequestPayloads;

export type RpcRequest<K extends RpcMethod = RpcMethod> =
  K extends RpcMethod
    ? { type: K; reqId: string } & RpcRequestPayloads[K]
    : never;

export interface RpcSuccess<T = unknown> {
  type: "result";
  reqId: string;
  ok: true;
  data?: T;
}

export interface RpcError {
  type: "error";
  reqId?: string;
  code: number;
  message: string;
}

export type RpcResponse<T = unknown> = RpcSuccess<T> | RpcError;

const RPC_METHODS: ReadonlySet<string> = new Set<RpcMethod>([
  "ping",
  "get-sessions",
  "normalize-cwd",
  "complete-path",
  "read-local-file",
  "reveal-local-path",
  "new-session",
  "prompt",
  "stop",
  "kill",
  "compact-session",
  "cli-info",
  "get-background-tasks",
  "codex-goal-get",
  "codex-goal-set",
  "codex-goal-clear",
  "get-agent-capabilities",
  "set-model",
  "set-effort",
  "set-service-tier",
  "set-permission-mode",
  "set-sandbox-mode",
  "interaction-respond",
  "delete-sessions",
  "set-title",
  "get-title",
  "mark-read",
  "retitle-session",
  "retitle-all",
  "get-user-messages",
  "rewind",
  "fork",
  "search-content",
  "read-tail",
  "read-range",
  "get-prefs",
  "put-prefs",
  "get-me",
  "get-session-skills",
  "rephrase",
  "subscribe",
  "unsubscribe",
]);

export const SESSION_ID_PATTERN = /^[0-9A-Za-z_-]+$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAgentKind(value: unknown): value is AgentKind {
  return value === "claude" || value === "codex";
}

export function isProcessStatus(value: unknown): value is ProcessStatus {
  return value === "running" || value === "exited" || value === "failed";
}

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

export function isIndexedRawLine(value: unknown): value is IndexedRawLine {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.index) &&
    (value.index as number) >= 0 &&
    typeof value.raw === "string"
  );
}

export function isStreamWireLine(value: unknown): value is StreamWireLine {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.index) &&
    (value.index as number) >= 0 &&
    typeof value.data === "string"
  );
}

function isNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

export function isSessionListItem(value: unknown): value is SessionListItem {
  if (!isRecord(value)) return false;
  if (
    !isSessionId(value.id) ||
    typeof value.cwd !== "string" ||
    typeof value.mtime !== "string" ||
    typeof value.size !== "number" ||
    !Number.isFinite(value.size) ||
    value.size < 0 ||
    !isAgentKind(value.agent)
  ) {
    return false;
  }
  if (value.peer !== undefined && typeof value.peer !== "boolean") return false;
  if (value.subagent !== undefined && typeof value.subagent !== "boolean") return false;
  if (!isNullableString(value.title)) return false;
  if (
    value.titleSource !== undefined &&
    value.titleSource !== null &&
    value.titleSource !== "auto" &&
    value.titleSource !== "manual"
  ) {
    return false;
  }
  if (!isNullableString(value.titleEmoji)) return false;
  if (!isNullableString(value.parentSessionId)) return false;
  if (
    value.status !== undefined &&
    value.status !== null &&
    !isProcessStatus(value.status)
  ) {
    return false;
  }
  return (
    isNullableString(value.preview) &&
    (value.previewRole === undefined || value.previewRole === null || value.previewRole === "user" || value.previewRole === "assistant") &&
    isNullableString(value.lastTurnAt) &&
    isNullableString(value.lastBoundaryAt) &&
    isNullableString(value.readAt) &&
    (value.unreadCount === undefined || (
      typeof value.unreadCount === "number"
      && Number.isSafeInteger(value.unreadCount)
      && value.unreadCount >= 0
    ))
  );
}

export function isRpcMethod(value: unknown): value is RpcMethod {
  return typeof value === "string" && RPC_METHODS.has(value);
}

/**
 * Validates the common envelope only. Method-specific validation belongs next
 * to the backend handler so unknown methods can still receive a structured 400.
 */
export function isRpcRequestEnvelope(
  value: unknown,
): value is { type: string; reqId: string; [key: string]: unknown } {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    value.type.length > 0 &&
    typeof value.reqId === "string" &&
    value.reqId.length > 0
  );
}

export function isRpcResponse(value: unknown): value is RpcResponse {
  if (!isRecord(value)) return false;
  if (value.type === "result") {
    return value.ok === true && typeof value.reqId === "string";
  }
  if (value.type === "error") {
    return (
      (value.reqId === undefined || typeof value.reqId === "string") &&
      Number.isInteger(value.code) &&
      typeof value.message === "string"
    );
  }
  return false;
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isRecord(value)) {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

export function isCodexGoalInput(value: unknown): value is CodexGoalInput {
  if (!isRecord(value) || typeof value.objective !== "string") return false;
  if (
    value.status !== undefined &&
    value.status !== "active" &&
    value.status !== "complete" &&
    value.status !== "blocked"
  ) {
    return false;
  }
  return (
    value.tokenBudget === undefined ||
    value.tokenBudget === null ||
    (Number.isSafeInteger(value.tokenBudget) && (value.tokenBudget as number) > 0)
  );
}
