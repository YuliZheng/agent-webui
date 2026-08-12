import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { asRecord, asString, RpcError } from "../types.js";
import type { AppState, Interaction } from "./state.js";
import { resolveCodexExecutable } from "../util/executable.js";
import type { AgentCapabilities, AgentModelOption, AgentSelectOption } from "@agent-webui/shared";

interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
interface SteeredInput { text: string; images: string[]; clientUuid?: string }
interface CapacityRetryError { turnId: string; message: string; details: string | null }
interface CapacityRetryState {
  attempts: number;
  hadActivity: boolean;
  options: CodexTurnOptions;
  supersededTurnIds: Set<string>;
  terminalError?: CapacityRetryError;
  timer?: NodeJS.Timeout;
}
interface ThreadState {
  active: boolean;
  turnId?: string;
  steers: SteeredInput[];
  cwd?: string;
  attached?: boolean;
  modelProvider?: string;
  capacityRetry?: CapacityRetryState;
}
interface PromptResult { sessionId: string; steered: boolean }
interface TurnReadyWaiter { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

export const DEFAULT_CODEX_APP_SERVER_MAX_RECORD_BYTES = 128 * 1024 * 1024;
const MIN_CODEX_APP_SERVER_MAX_RECORD_BYTES = 1024 * 1024;

function configuredMaxRecordBytes(): number {
  const raw = process.env.AGENT_WEBUI_CODEX_MAX_RECORD_BYTES?.trim();
  if (!raw) return DEFAULT_CODEX_APP_SERVER_MAX_RECORD_BYTES;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= MIN_CODEX_APP_SERVER_MAX_RECORD_BYTES
    ? value
    : DEFAULT_CODEX_APP_SERVER_MAX_RECORD_BYTES;
}

function mebibytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1);
}

export interface CodexTurnOptions {
  model?: string;
  effort?: string;
  serviceTier?: string | null;
  approvalPolicy?: string;
  sandboxMode?: string;
  cwd?: string;
}
export interface CodexSettingsUpdate {
  model?: string | null;
  effort?: string | null;
  serviceTier?: string | null;
  approvalPolicy?: string | null;
  sandboxMode?: string | null;
  cwd?: string;
}
export interface CodexThreadTurn {
  id: string;
  userText: string;
}
export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}
export interface CodexRateLimits {
  planType: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
}

const FAST_SERVICE_TIERS: AgentSelectOption[] = [{
  value: "priority",
  label: "Fast",
  description: "1.5x speed, increased usage",
}];
const fastServiceTiers = (): AgentSelectOption[] => FAST_SERVICE_TIERS.map(tier => ({ ...tier }));
function normalizedServiceTierId(value: unknown): string | undefined {
  const tier = asString(value);
  return tier === "fast" ? "priority" : tier;
}

export const CODEX_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
const reasoningEfforts = (values: readonly string[]): AgentSelectOption[] =>
  values.map(value => ({ value, label: value }));
const GPT_56_ULTRA_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
const GPT_56_MAX_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const GPT_XHIGH_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
const DEEPSEEK_MODELS = new Set(["deepseek-v4-pro", "deepseek-v4-flash"]);
const DEEPSEEK_EFFORTS = new Set(["low", "high", "max"]);

function modelProviderFor(model: string | undefined): string | undefined {
  return model && DEEPSEEK_MODELS.has(model) ? "deepseek" : undefined;
}

function crossesDeepSeekProvider(current: string | undefined, model: string | undefined): boolean {
  if (!current || !model) return false;
  const next = modelProviderFor(model);
  return current === "deepseek" ? next !== "deepseek" : next === "deepseek";
}

function deepSeekEffort(provider: string | undefined, effort: string | undefined): string | undefined {
  if (provider !== "deepseek") return effort;
  return effort && DEEPSEEK_EFFORTS.has(effort) ? effort : "high";
}

const FALLBACK_CODEX_MODELS: AgentModelOption[] = [
  {
    value: "gpt-5.6-sol",
    label: "GPT-5.6-Sol",
    description: "Fast local Codex model",
    defaultEffort: "low",
    supportedEfforts: reasoningEfforts(GPT_56_ULTRA_EFFORTS),
    serviceTiers: fastServiceTiers(),
  },
  {
    value: "gpt-5.6-terra",
    label: "GPT-5.6-Terra",
    description: "General-purpose local Codex model",
    defaultEffort: "medium",
    supportedEfforts: reasoningEfforts(GPT_56_ULTRA_EFFORTS),
    serviceTiers: fastServiceTiers(),
  },
  {
    value: "gpt-5.6-luna",
    label: "GPT-5.6-Luna",
    description: "Deep reasoning local Codex model",
    defaultEffort: "medium",
    supportedEfforts: reasoningEfforts(GPT_56_MAX_EFFORTS),
    serviceTiers: fastServiceTiers(),
  },
  ...["gpt-5.5", "gpt-5.4"].map(value => ({
    value,
    label: value,
    supportedEfforts: reasoningEfforts(GPT_XHIGH_EFFORTS),
    serviceTiers: fastServiceTiers(),
  })),
  ...["gpt-5.4-mini", "gpt-5.3-codex-spark"].map(value => ({
    value,
    label: value,
    supportedEfforts: reasoningEfforts(GPT_XHIGH_EFFORTS),
    serviceTiers: [],
  })),
];

const CODEX_APPROVALS: AgentSelectOption[] = [
  { value: "untrusted", label: "Ask for untrusted commands", description: "Runs known-safe commands; asks for commands outside the trusted set." },
  { value: "on-request", label: "Ask when requested", description: "The agent decides when an approval is required." },
  { value: "never", label: "Never ask", description: "Never pauses for approval; sandbox restrictions still apply." },
];

const CODEX_SANDBOXES: AgentSelectOption[] = [
  { value: "read-only", label: "Read only", description: "Can inspect files but cannot write them." },
  { value: "workspace-write", label: "Workspace write", description: "Can write inside the current workspace." },
  { value: "danger-full-access", label: "Full access", description: "No filesystem sandbox. Combine with Never ask for YOLO mode." },
];
// Capacity windows commonly last longer than one request round-trip. A fixed
// 500 ms loop burns every retry inside the same outage; exponential spacing
// gives the upstream route a full minute to recover while remaining bounded.
const CAPACITY_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;
const CAPACITY_RETRY_INITIAL_CONTEXT = {
  "agent-webui.capacity-retry": {
    kind: "application",
    value: "The immediately preceding user request failed before producing any response because the selected model was overloaded. Retry that same request now without asking the user to repeat it.",
  },
} as const;
const CAPACITY_RETRY_CONTINUATION_CONTEXT = {
  "agent-webui.capacity-retry": {
    kind: "application",
    value: "The immediately preceding turn was interrupted by model overload after partial progress. Continue from the existing assistant messages and tool results. Do not repeat completed tool calls or text already shown to the user; finish the remaining work and provide the final response.",
  },
} as const;

function codexErrorInfoKind(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  return record ? Object.keys(record)[0] : undefined;
}

function isCapacityError(error: Record<string, unknown> | null): boolean {
  const kind = codexErrorInfoKind(error?.codexErrorInfo ?? error?.codex_error_info);
  if (kind === "serverOverloaded") return true;
  const message = asString(error?.message) ?? "";
  return /(?:selected model is at capacity|server (?:is )?overloaded)/i.test(message);
}

function answerStrings(value: unknown): string[] {
  const wrapped = asRecord(value);
  const source = wrapped && Object.hasOwn(wrapped, "answers") ? wrapped.answers : value;
  const values = Array.isArray(source) ? source : source === undefined || source === null ? [] : [source];
  return values.flatMap(item => {
    if (typeof item === "string") return [item];
    if (typeof item === "number" || typeof item === "boolean") return [String(item)];
    const record = asRecord(item);
    const otherText = asString(record?.otherText)?.trim();
    const selectedLabel = asString(record?.selectedLabel);
    return otherText ? [otherText] : selectedLabel ? [selectedLabel] : [];
  });
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rateLimitWindow(value: unknown): CodexRateLimitWindow | null {
  const window = asRecord(value);
  if (!window) return null;
  const usedPercent = finiteNumber(window.usedPercent ?? window.used_percent);
  if (usedPercent === null) return null;
  return {
    usedPercent,
    windowDurationMins: finiteNumber(window.windowDurationMins ?? window.window_duration_mins),
    resetsAt: finiteNumber(window.resetsAt ?? window.resets_at),
  };
}

function userInputResult(params: Record<string, unknown> | null, answer: unknown): { answers: Record<string, { answers: string[] }> } {
  const questions = Array.isArray(params?.questions) ? params.questions : [];
  const answerRecord = asRecord(answer);
  const ordered =
    answerRecord?.kind === "ask-answers" && Array.isArray(answerRecord.answers)
      ? answerRecord.answers
      : null;
  const supplied = asRecord(answerRecord?.answers) ?? answerRecord;
  const entries: Array<[string, { answers: string[] }]> = [];
  let usedScalar = false;

  questions.forEach((raw, index) => {
    const question = asRecord(raw);
    const id = asString(question?.id);
    if (!id) return;
    let value: unknown;
    if (ordered) {
      value = ordered[index];
    } else if (supplied) {
      const header = asString(question?.header);
      if (Object.hasOwn(supplied, id)) value = supplied[id];
      else if (header && Object.hasOwn(supplied, header)) value = supplied[header];
      else value = supplied[`question-${index + 1}`];
    } else if (!usedScalar) {
      value = answer;
      usedScalar = true;
    }
    entries.push([id, { answers: answerStrings(value) }]);
  });

  return { answers: Object.fromEntries(entries) };
}

function normalizedInteractionAnswer(answer: unknown): {
  accepted: boolean | null;
  content: unknown;
} {
  const value = asRecord(answer);
  const kind = asString(value?.kind);
  if (kind === "allow") {
    return { accepted: true, content: value?.updatedInput ?? null };
  }
  if (kind === "deny") {
    return { accepted: false, content: asString(value?.message) ?? null };
  }
  if (typeof answer === "boolean") {
    return { accepted: answer, content: null };
  }
  return { accepted: null, content: answer };
}

export class CodexDriver extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private initializedChild?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private bufferBytes = 0;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private inbound = new Map<string, { rpcId: string | number; sessionId: string; method: string; params: Record<string, unknown> | null }>();
  private threads = new Map<string, ThreadState>();
  private clientIds = new Map<string, PromptResult>();
  private clientRequests = new Map<string, Promise<PromptResult>>();
  private resumingThreads = new Map<string, Promise<void>>();
  private startingTurns = new Map<string, Promise<unknown>>();
  private turnReadyWaiters = new Map<string, TurnReadyWaiter[]>();
  private starting?: Promise<void>;
  private resolvedBinary?: Promise<string>;
  private capabilitiesCache?: { expiresAt: number; value: AgentCapabilities };
  private capabilitiesRequest?: Promise<AgentCapabilities>;

  constructor(
    private binary: string,
    private state: AppState,
    private spawnProcess: typeof spawn = spawn,
    private maxRecordBytes = configuredMaxRecordBytes(),
  ) { super(); }

  isActive(id: string): boolean { return this.threads.get(id)?.active === true; }

  /**
   * Reconcile a durable rollout boundary when app-server omitted the matching
   * turn/completed notification. Strict turn matching prevents a delayed
   * watcher append from clearing a newer active turn.
   */
  reconcileDurableTerminal(
    sessionId: string,
    turnId: string,
    kind: "completed" | "interrupted",
    timestamp?: string,
  ): boolean {
    const state = this.threads.get(sessionId);
    if (!state?.active || !state.turnId || state.turnId !== turnId) return false;
    if (kind === "completed" && this.scheduleCapacityRetry(sessionId, state, turnId)) return true;
    this.finishTurn(sessionId, state, kind, timestamp);
    return true;
  }

  private async ensure(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.child?.exitCode === null && this.initializedChild === this.child) return;
    this.resolvedBinary ??= resolveCodexExecutable(this.binary);
    const binary = await this.resolvedBinary;
    if (this.starting) return this.starting;
    if (this.child?.exitCode === null && this.initializedChild === this.child) return;
    const operation = new Promise<void>((resolve, reject) => {
      const child = this.spawnProcess(binary, ["app-server", "--listen", "stdio://"], { shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, AGENT_WEBUI: "1" } });
      this.child = child;
      this.initializedChild = undefined;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => { if (this.child === child) this.stdout(String(chunk)); });
      child.stderr.on("data", chunk => { if (this.child === child) this.emit("stderr", String(chunk).slice(-4096)); });
      child.on("error", error => {
        reject(error);
        this.failed(error, child);
      });
      child.on("exit", (code, signal) => this.failed(new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})`), child));
      this.rawRequest("initialize", {
        clientInfo: { name: "agent-webui", title: "Agent WebUI", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      })
        .then(() => {
          if (this.child !== child || child.exitCode !== null) {
            reject(new RpcError(503, "Codex app-server exited during initialization"));
            return;
          }
          try {
            this.send({ method: "initialized", params: {} });
            this.initializedChild = child;
            resolve();
          } catch (error) {
            const cause = error instanceof Error ? error : new Error(String(error));
            reject(cause);
            this.failed(cause, child);
            if (child.exitCode === null) child.kill("SIGTERM");
          }
        }, error => {
          reject(error);
          this.failed(error instanceof Error ? error : new Error(String(error)), child);
          if (child.exitCode === null) child.kill("SIGTERM");
        });
    });
    let wrapped!: Promise<void>;
    wrapped = operation.finally(() => {
      if (this.starting === wrapped) this.starting = undefined;
    });
    this.starting = wrapped;
    return wrapped;
  }

  private send(value: unknown): void {
    if (!this.child?.stdin.writable) throw new RpcError(503, "Codex app-server is unavailable");
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private rawRequest(method: string, params: unknown, timeout = 20_000): Promise<unknown> {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RpcError(504, `Codex ${method} timed out`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  async request(method: string, params: unknown): Promise<unknown> { await this.ensure(); return this.rawRequest(method, params); }

  private stdout(chunk: string): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf("\n", offset);
      const end = newline >= 0 ? newline : chunk.length;
      const fragment = chunk.slice(offset, end);
      this.buffer += fragment;
      this.bufferBytes += Buffer.byteLength(fragment, "utf8");
      if (this.bufferBytes > this.maxRecordBytes) {
        this.failOversizedRecord();
        return;
      }
      if (newline < 0) return;
      const line = this.buffer.trim();
      this.buffer = "";
      this.bufferBytes = 0;
      offset = newline + 1;
      if (!line) continue;
      try { const msg = asRecord(JSON.parse(line)); if (msg) this.message(msg); } catch { this.emit("driver-error", "Malformed Codex app-server record"); }
    }
  }

  private failOversizedRecord(): void {
    const child = this.child;
    const message = `Codex app-server response exceeded the ${mebibytes(this.maxRecordBytes)} MiB safety limit (${mebibytes(this.bufferBytes)} MiB received without a record boundary). This session is too large to resume with the current limit. Start a new session or raise AGENT_WEBUI_CODEX_MAX_RECORD_BYTES and restart Agent WebUI.`;
    this.emit("driver-error", message);
    this.failed(new Error(message), child);
    if (child?.exitCode === null) child.kill("SIGTERM");
  }

  private message(msg: Record<string, unknown>): void {
    if ((typeof msg.id === "number") && ("result" in msg || "error" in msg)) {
      const pending = this.pending.get(msg.id); if (!pending) return;
      this.pending.delete(msg.id); clearTimeout(pending.timer);
      const error = asRecord(msg.error);
      if (error) {
        const code = Number(error.code);
        pending.reject(new RpcError(code === -32601 ? 501 : 502, asString(error.message) ?? "Codex RPC failed"));
      } else pending.resolve(msg.result);
      return;
    }
    const method = asString(msg.method);
    const params = asRecord(msg.params);
    if (!method) return;
    if (msg.id !== undefined) { this.inboundRequest(msg.id as string | number, method, params); return; }
    this.notification(method, params);
  }

  private threadId(params: Record<string, unknown> | null): string | undefined {
    const thread = asRecord(params?.thread);
    return asString(params?.threadId) ?? asString(params?.thread_id) ?? asString(thread?.id);
  }

  private inboundRequest(id: string | number, method: string, params: Record<string, unknown> | null): void {
    const supported = new Set([
      "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval",
      "item/tool/requestUserInput", "mcpServer/elicitation/request",
    ]);
    if (!supported.has(method)) {
      this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unsupported server request" } }); return;
    }
    const sessionId = this.threadId(params);
    if (!sessionId) { this.send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Missing thread ID" } }); return; }
    const threadState = this.threads.get(sessionId);
    if (threadState?.capacityRetry) threadState.capacityRetry.hadActivity = true;
    const requestId = `codex-${String(id)}`;
    const isQuestion = method === "item/tool/requestUserInput" || method === "mcpServer/elicitation/request";
    const questions = Array.isArray(params?.questions) ? params.questions : [];
    const firstQuestion = asRecord(questions[0]); const firstOptions = Array.isArray(firstQuestion?.options) ? firstQuestion.options : [];
    const interaction: Interaction = {
      sessionId, requestId, kind: isQuestion ? "question" : "permission",
      toolName: method, input: params, toolUseId: asString(params?.itemId) ?? asString(params?.callId) ?? null,
      command: asString(params?.command) ?? null, description: asString(params?.reason) ?? null,
      questions, title: isQuestion ? asString(firstQuestion?.header) ?? (method.startsWith("mcpServer") ? "MCP server question" : "Codex question") : "Codex approval required",
      message: isQuestion ? asString(firstQuestion?.question) ?? asString(params?.message) ?? "Codex needs an answer" : asString(params?.reason) ?? asString(params?.command) ?? "Codex is waiting for your response",
      options: firstOptions.flatMap(option => { const item = asRecord(option); const label = asString(item?.label); return label ? [{ label, value: label }] : []; }),
      createdAt: new Date().toISOString(), agent: "codex",
    };
    this.inbound.set(requestId, { rpcId: id, sessionId, method, params });
    this.state.interactions.set(this.state.interactionKey(sessionId, requestId), interaction);
    this.emit("interaction-added", interaction);
  }

  private notification(method: string, params: Record<string, unknown> | null): void {
    const sessionId = this.threadId(params);
    if (!sessionId) { this.emit("notification", { method, params }); return; }
    if (method === "thread/name/updated") {
      this.emit("thread-name", {
        id: sessionId,
        name: (asString(params?.threadName) ?? asString(params?.name) ?? "").trim() || null,
      });
      this.emit("notification", { method, params });
      return;
    }
    const state = this.threads.get(sessionId) ?? { active: false, steers: [] };
    this.threads.set(sessionId, state);
    if (state.capacityRetry && (method === "item/started" || method === "item/completed")) {
      const itemType = asString(asRecord(params?.item)?.type);
      if (itemType !== "userMessage" && itemType !== "reasoning") state.capacityRetry.hadActivity = true;
    } else if (
      state.capacityRetry
      && (
        method === "turn/diff/updated"
        || (method.startsWith("item/") && !method.startsWith("item/reasoning/"))
      )
    ) {
      state.capacityRetry.hadActivity = true;
    }
    if (method === "turn/started") {
      state.active = true; state.turnId = asString(asRecord(params?.turn)?.id) ?? asString(params?.turnId);
      if (state.turnId) this.resolveTurnReady(sessionId);
      this.emit("status", { id: sessionId, status: "running", webuiAlive: true, lastBoundaryAt: new Date().toISOString() });
    } else if (method === "error") {
      const error = asRecord(params?.error);
      const turnId = asString(params?.turnId) ?? asString(params?.turn_id);
      if (
        params?.willRetry === false
        && turnId
        && turnId === state.turnId
        && state.capacityRetry
        && isCapacityError(error)
      ) {
        state.capacityRetry.terminalError = {
          turnId,
          message: asString(error?.message) ?? "Selected model is at capacity.",
          details: asString(error?.additionalDetails ?? error?.additional_details) ?? null,
        };
      }
    } else if (method === "turn/completed") {
      const turn = asRecord(params?.turn); const status = asString(turn?.status) ?? asString(params?.status);
      const turnId = asString(turn?.id) ?? asString(params?.turnId) ?? asString(params?.turn_id);
      const error = asRecord(turn?.error) ?? asRecord(params?.error);
      if (
        turnId
        && state.capacityRetry?.supersededTurnIds.has(turnId)
        && state.turnId !== turnId
      ) {
        this.emit("notification", { method, params });
        return;
      }
      if (
        status === "failed"
        && turnId
        && state.capacityRetry
        && isCapacityError(error)
      ) {
        state.capacityRetry.terminalError = {
          turnId,
          message: asString(error?.message) ?? "Selected model is at capacity.",
          details: asString(error?.additionalDetails ?? error?.additional_details) ?? null,
        };
      }
      if (turnId && this.scheduleCapacityRetry(sessionId, state, turnId)) {
        this.emit("notification", { method, params });
        return;
      }
      this.finishTurn(sessionId, state, status);
      if (status === "failed") {
        this.emit("turn-error", {
          sessionId,
          turnId: turnId ?? null,
          message: asString(error?.message) ?? "Codex turn failed before producing a reply.",
          details: asString(error?.additionalDetails) ?? null,
        });
      }
    } else if (
      /(?:started|completed|finished|failed|cancelled|canceled|error)/i.test(method)
      && /(?:task|command|collab.*agent|subagent|agent.*tool)/i.test(
        `${method} ${asString(asRecord(params?.item)?.type) ?? ""} ${asString(asRecord(params?.task)?.type) ?? ""}`,
      )
    ) {
      this.emit("background", { sessionId, method, params });
    }
    this.emit("notification", { method, params });
  }

  async newSession(cwd: string, prompt: string, options: CodexTurnOptions = {}, images: string[] = []): Promise<{ sessionId: string }> {
    const modelProvider = modelProviderFor(options.model);
    const effort = deepSeekEffort(modelProvider, options.effort);
    const result = asRecord(await this.request("thread/start", {
      cwd,
      ...(options.model ? { model: options.model } : {}),
      ...(modelProvider ? { modelProvider } : {}),
      ...(effort ? { effort } : {}),
      ...(modelProvider === "deepseek"
        ? { serviceTier: null }
        : options.serviceTier !== undefined ? { serviceTier: options.serviceTier } : {}),
      ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
      ...(options.sandboxMode ? { sandbox: options.sandboxMode } : {}),
    }));
    const thread = asRecord(result?.thread);
    const id = asString(thread?.id) ?? asString(result?.threadId) ?? asString(result?.id);
    if (!id) throw new RpcError(502, "Codex did not return a thread ID");
    this.threads.set(id, {
      active: false,
      steers: [],
      cwd,
      attached: true,
      modelProvider: asString(result?.modelProvider) ?? asString(thread?.modelProvider) ?? modelProvider,
    });
    if (prompt || images.length) await this.startTurn(id, prompt, { ...options, cwd }, images);
    return { sessionId: id };
  }

  async resume(sessionId: string): Promise<void> {
    if (this.threads.get(sessionId)?.attached) return;
    const inflight = this.resumingThreads.get(sessionId);
    if (inflight) return inflight;
    const operation = this.resumeOnce(sessionId);
    this.resumingThreads.set(sessionId, operation);
    try {
      await operation;
    } finally {
      if (this.resumingThreads.get(sessionId) === operation) {
        this.resumingThreads.delete(sessionId);
      }
    }
  }

  private async resumeOnce(sessionId: string): Promise<void> {
    const result = asRecord(await this.request("thread/resume", { threadId: sessionId }));
    const thread = asRecord(result?.thread);
    const existing = this.threads.get(sessionId) ?? { active: false, steers: [] };
    existing.cwd ??= asString(thread?.cwd);
    existing.modelProvider ??= asString(result?.modelProvider) ?? asString(thread?.modelProvider);
    existing.attached = true; this.threads.set(sessionId, existing);
  }

  private startTurn(
    sessionId: string,
    prompt: string,
    options: CodexTurnOptions = {},
    images: string[] = [],
    clientUserMessageId?: string,
    capacityRetry = false,
  ): Promise<unknown> {
    const existing = this.startingTurns.get(sessionId);
    if (existing) return existing;
    const operation = this.startTurnNow(sessionId, prompt, options, images, clientUserMessageId, capacityRetry);
    this.startingTurns.set(sessionId, operation);
    void operation.finally(() => { if (this.startingTurns.get(sessionId) === operation) this.startingTurns.delete(sessionId); }).catch(() => undefined);
    return operation;
  }

  private async startTurnNow(
    sessionId: string,
    prompt: string,
    options: CodexTurnOptions = {},
    images: string[] = [],
    clientUserMessageId?: string,
    capacityRetry = false,
  ): Promise<unknown> {
    const state = this.threads.get(sessionId) ?? { active: false, steers: [] };
    if (crossesDeepSeekProvider(state.modelProvider, options.model)) {
      throw new RpcError(409, "Codex model providers cannot be changed inside an existing session; create a new session with the requested model");
    }
    state.cwd ??= options.cwd;
    const modelProvider = state.modelProvider ?? modelProviderFor(options.model);
    const effort = deepSeekEffort(modelProvider, options.effort);
    const continueFromProgress = capacityRetry && state.capacityRetry?.hadActivity === true;
    if (capacityRetry) {
      if (state.capacityRetry) {
        state.capacityRetry.hadActivity = false;
        state.capacityRetry.terminalError = undefined;
      }
    } else {
      if (state.capacityRetry?.timer) clearTimeout(state.capacityRetry.timer);
      state.capacityRetry = {
        attempts: 0,
        hadActivity: false,
        options: { ...options },
        supersededTurnIds: new Set(),
      };
    }
    state.active = true; this.threads.set(sessionId, state);
    this.emit("status", { id: sessionId, status: "running", webuiAlive: true, lastBoundaryAt: new Date().toISOString() });
    const input = [...images.map(path => ({ type: "localImage", path })), ...(prompt ? [{ type: "text", text: prompt, text_elements: [] }] : [])];
    try {
      const result = await this.request("turn/start", {
        threadId: sessionId,
        input,
        ...(options.model ? { model: options.model } : {}),
        ...(effort ? { effort } : {}),
        ...(modelProvider === "deepseek"
          ? { serviceTier: null }
          : options.serviceTier !== undefined ? { serviceTier: options.serviceTier } : {}),
        ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
        ...(options.sandboxMode ? { sandboxPolicy: this.sandboxPolicy(options.sandboxMode, options.cwd ?? state.cwd) } : {}),
        ...(clientUserMessageId ? { clientUserMessageId } : {}),
        ...(capacityRetry ? {
          additionalContext: continueFromProgress
            ? CAPACITY_RETRY_CONTINUATION_CONTEXT
            : CAPACITY_RETRY_INITIAL_CONTEXT,
        } : {}),
      });
      state.turnId = asString(asRecord(asRecord(result)?.turn)?.id) ?? asString(asRecord(result)?.turnId) ?? state.turnId;
      if (state.turnId) this.resolveTurnReady(sessionId);
      return result;
    }
    catch (error) {
      this.finishTurn(sessionId, state, "failed");
      throw error;
    }
  }

  async prompt(sessionId: string, prompt: string, options: CodexTurnOptions = {}, images: string[] = [], clientUuid?: string): Promise<PromptResult> {
    const clientKey = clientUuid ? `${sessionId}:${clientUuid}` : undefined;
    if (clientKey) {
      const prior = this.clientIds.get(clientKey);
      if (prior) return prior;
      const inflight = this.clientRequests.get(clientKey);
      if (inflight) return inflight;
    }
    const operation = this.promptOnce(sessionId, prompt, options, images, clientUuid);
    if (clientKey) this.clientRequests.set(clientKey, operation);
    try {
      const result = await operation;
      if (clientKey) {
        this.clientIds.set(clientKey, result);
        if (this.clientIds.size > 1000) this.clientIds.delete(this.clientIds.keys().next().value!);
      }
      return result;
    } finally {
      if (clientKey && this.clientRequests.get(clientKey) === operation) this.clientRequests.delete(clientKey);
    }
  }

  private async promptOnce(sessionId: string, prompt: string, options: CodexTurnOptions, images: string[], clientUuid: string | undefined): Promise<PromptResult> {
    await this.resume(sessionId);
    let state = this.threads.get(sessionId)!;
    state.cwd ??= options.cwd;
    if (state.active && !state.turnId) {
      const starting = this.startingTurns.get(sessionId);
      if (starting) await starting;
      state = this.threads.get(sessionId)!;
      if (state.active && !state.turnId) await this.waitForTurnReady(sessionId);
      state = this.threads.get(sessionId)!;
    }
    let result: { sessionId: string; steered: boolean };
    if (state.active) {
      if (!state.turnId) throw new RpcError(409, "Codex has not reported the active turn ID yet");
      const steered = { text: prompt, images: [...images], ...(clientUuid ? { clientUuid } : {}) };
      state.steers.push(steered);
      const input = [...images.map(path => ({ type: "localImage", path })), ...(prompt ? [{ type: "text", text: prompt, text_elements: [] }] : [])];
      try { await this.request("turn/steer", { threadId: sessionId, expectedTurnId: state.turnId, input, ...(clientUuid ? { clientUserMessageId: clientUuid } : {}) }); }
      catch (error) { if (this.child?.exitCode === null) { const index = state.steers.lastIndexOf(steered); if (index >= 0) state.steers.splice(index, 1); } throw error; }
      result = { sessionId, steered: true };
    } else {
      await this.startTurn(sessionId, prompt, options, images, clientUuid);
      result = { sessionId, steered: false };
    }
    return result;
  }

  private sandboxPolicy(mode: string, cwd?: string): Record<string, unknown> {
    if (mode === "danger-full-access") return { type: "dangerFullAccess" };
    if (mode === "read-only") return { type: "readOnly", networkAccess: false };
    if (mode === "workspace-write") {
      return {
        type: "workspaceWrite",
        writableRoots: cwd ? [cwd] : [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    }
    throw new RpcError(400, `Unsupported Codex sandbox mode: ${mode}`);
  }

  async capabilities(cwd?: string): Promise<AgentCapabilities> {
    const now = Date.now();
    if (this.capabilitiesCache && this.capabilitiesCache.expiresAt > now) return this.capabilitiesCache.value;
    if (this.capabilitiesRequest) return this.capabilitiesRequest;
    this.capabilitiesRequest = this.readCapabilities(cwd)
      .then(value => {
        this.capabilitiesCache = { expiresAt: Date.now() + 2 * 60_000, value };
        return value;
      })
      .finally(() => { this.capabilitiesRequest = undefined; });
    return this.capabilitiesRequest;
  }

  async rateLimits(): Promise<CodexRateLimits> {
    const response = asRecord(await this.request("account/rateLimits/read", undefined));
    const byLimitId = asRecord(response?.rateLimitsByLimitId ?? response?.rate_limits_by_limit_id);
    const snapshot =
      asRecord(byLimitId?.codex) ??
      asRecord(response?.rateLimits ?? response?.rate_limits);
    if (!snapshot) throw new RpcError(502, "Codex did not return account rate limits");
    return {
      planType: asString(snapshot.planType ?? snapshot.plan_type) ?? null,
      primary: rateLimitWindow(snapshot.primary),
      secondary: rateLimitWindow(snapshot.secondary),
    };
  }

  private async readCapabilities(cwd?: string): Promise<AgentCapabilities> {
    let models: AgentModelOption[] = [];
    let config: Record<string, unknown> | null = null;
    let rows: unknown[] = [];
    try {
      const root = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
      const parsed: unknown = JSON.parse(await readFile(join(root, "models_cache.json"), "utf8"));
      const cached = asRecord(parsed);
      if (Array.isArray(parsed)) rows.push(...parsed);
      else if (Array.isArray(cached?.models)) rows.push(...cached.models);
      else if (Array.isArray(cached?.data)) rows.push(...cached.data);
    } catch { /* cache is optional */ }
    if (!rows.length) try {
      let cursor: string | undefined;
      for (let page = 0; page < 8; page++) {
        const result = asRecord(await this.request("model/list", {
          limit: 100,
          includeHidden: false,
          ...(cursor ? { cursor } : {}),
        }));
        if (Array.isArray(result?.data)) rows.push(...result.data);
        cursor = asString(result?.nextCursor) ?? asString(result?.next_cursor);
        if (!cursor) break;
      }
    } catch { /* older app-server: use the locally accurate fallback below */ }
    // Codex supports a user-supplied model catalog in addition to its built-in
    // cache. DeepSeek's official Codex setup writes this conventional path.
    // Merge it so the WebUI picker sees custom provider models without hiding
    // the OpenAI models already present in models_cache.json.
    try {
      const root = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
      const parsed: unknown = JSON.parse(await readFile(join(root, "models.json"), "utf8"));
      const catalog = asRecord(parsed);
      if (Array.isArray(parsed)) rows.push(...parsed);
      else if (Array.isArray(catalog?.models)) rows.push(...catalog.models);
      else if (Array.isArray(catalog?.data)) rows.push(...catalog.data);
    } catch { /* custom catalog is optional */ }
    models = rows.flatMap(raw => {
      const value = asRecord(raw);
      const id = asString(value?.id) ?? asString(value?.model) ?? asString(value?.slug);
      if (!id || value?.hidden === true || value?.visibility === "hide") return [];
      const efforts = Array.isArray(value?.supportedReasoningEfforts)
        ? value.supportedReasoningEfforts
        : Array.isArray(value?.supported_reasoning_efforts)
          ? value.supported_reasoning_efforts
          : Array.isArray(value?.supportedReasoningLevels)
            ? value.supportedReasoningLevels
            : Array.isArray(value?.supported_reasoning_levels) ? value.supported_reasoning_levels : [];
      const supportedEfforts = efforts.flatMap(rawEffort => {
        const effort = asRecord(rawEffort);
        const effortValue = typeof rawEffort === "string"
          ? rawEffort
          : asString(effort?.effort) ?? asString(effort?.reasoningEffort) ?? asString(effort?.reasoning_effort) ?? asString(effort?.value);
        return effortValue ? [{
          value: effortValue,
          label: effortValue,
          description: asString(effort?.description) ?? null,
        }] : [];
      });
      const rawServiceTiers = Array.isArray(value?.serviceTiers)
        ? value.serviceTiers
        : Array.isArray(value?.service_tiers) ? value.service_tiers : [];
      const serviceTiers = rawServiceTiers.flatMap<AgentSelectOption>(rawTier => {
        const tier = asRecord(rawTier);
        const tierId = normalizedServiceTierId(
          typeof rawTier === "string"
            ? rawTier
            : tier?.id ?? tier?.value ?? tier?.serviceTier ?? tier?.service_tier,
        );
        if (!tierId) return [];
        return [{
          value: tierId,
          label: asString(tier?.name) ?? asString(tier?.label) ?? (tierId === "priority" ? "Fast" : tierId),
          description: asString(tier?.description) ?? null,
        }];
      });
      const legacySpeedTiers = Array.isArray(value?.additionalSpeedTiers)
        ? value.additionalSpeedTiers
        : Array.isArray(value?.additional_speed_tiers) ? value.additional_speed_tiers : [];
      if (
        !serviceTiers.some(tier => tier.value === "priority")
        && legacySpeedTiers.some(rawTier => {
          const tier = asRecord(rawTier);
          return normalizedServiceTierId(typeof rawTier === "string" ? rawTier : tier?.id ?? tier?.value) === "priority";
        })
      ) {
        serviceTiers.push(...fastServiceTiers());
      }
      return [{
        value: id,
        label: asString(value?.displayName) ?? asString(value?.display_name) ?? id,
        description: asString(value?.description) ?? null,
        supportedEfforts,
        serviceTiers,
        defaultEffort:
          asString(value?.defaultReasoningEffort) ??
          asString(value?.default_reasoning_effort) ??
          asString(value?.defaultReasoningLevel) ??
          asString(value?.default_reasoning_level) ??
          null,
        defaultServiceTier: normalizedServiceTierId(value?.defaultServiceTier ?? value?.default_service_tier) ?? null,
        isDefault: value?.isDefault === true || value?.is_default === true,
      }];
    });
    models = [...new Map(models.map(model => [model.value, model])).values()];

    // Reading the local model cache above is intentionally sufficient for the
    // selector: merely opening a dropdown must not launch the relatively heavy
    // app-server. Config defaults are queried only when a daemon already exists.
    if (this.child?.exitCode === null) try {
      const result = asRecord(await this.request("config/read", { ...(cwd ? { cwd } : {}), includeLayers: false }));
      config = asRecord(result?.config) ?? result;
    } catch { /* optional on older app-server versions */ }

    if (!models.length) models = FALLBACK_CODEX_MODELS.map(model => ({
      ...model,
      supportedEfforts: model.supportedEfforts.map(effort => ({ ...effort })),
      serviceTiers: model.serviceTiers?.map(tier => ({ ...tier })),
    }));
    const configuredModel = asString(config?.model);
    const defaultModel = configuredModel ?? models.find(model => model.isDefault)?.value ?? null;
    const selectedModel = models.find(model => model.value === defaultModel);
    const defaultEffort = asString(config?.model_reasoning_effort) ?? asString(config?.modelReasoningEffort) ?? selectedModel?.defaultEffort ?? null;
    const defaultServiceTier = normalizedServiceTierId(config?.service_tier ?? config?.serviceTier) ?? selectedModel?.defaultServiceTier ?? null;
    return {
      agent: "codex",
      models,
      permissionModes: CODEX_APPROVALS.map(option => ({ ...option })),
      sandboxModes: CODEX_SANDBOXES.map(option => ({ ...option })),
      defaults: {
        model: defaultModel,
        effort: defaultEffort,
        serviceTier: defaultServiceTier,
        permissionMode: asString(config?.approval_policy) ?? asString(config?.approvalPolicy) ?? null,
        sandboxMode: asString(config?.sandbox_mode) ?? asString(config?.sandboxMode) ?? null,
      },
    };
  }

  async stop(sessionId: string): Promise<void> {
    const state = this.threads.get(sessionId);
    if (!state?.active) throw new RpcError(409, "Codex turn is not active");
    if (!state.turnId && state.capacityRetry?.timer) {
      clearTimeout(state.capacityRetry.timer);
      state.capacityRetry.timer = undefined;
      this.finishTurn(sessionId, state, "interrupted");
      return;
    }
    if (!state.turnId) throw new RpcError(409, "Codex has not reported the active turn ID yet");
    await this.request("turn/interrupt", { threadId: sessionId, turnId: state.turnId });
  }
  async updateSettings(sessionId: string, values: CodexSettingsUpdate): Promise<void> {
    await this.resume(sessionId);
    const currentProvider = this.threads.get(sessionId)?.modelProvider;
    if (crossesDeepSeekProvider(currentProvider, values.model ?? undefined)) {
      throw new RpcError(409, "Codex model providers cannot be changed inside an existing session; create a new session with the requested model");
    }
    const { sandboxMode, cwd, ...settings } = values;
    const payload: Record<string, unknown> = { threadId: sessionId, ...settings };
    if (sandboxMode !== undefined) payload.sandboxPolicy = sandboxMode === null ? null : this.sandboxPolicy(sandboxMode, cwd ?? this.threads.get(sessionId)?.cwd);
    await this.request("thread/settings/update", payload);
  }
  async compact(sessionId: string): Promise<void> { await this.request("thread/compact/start", { threadId: sessionId }); }
  async threadNames(): Promise<Map<string, string | null>> {
    const names = new Map<string, string | null>();
    const collect = async (archived: boolean): Promise<void> => {
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      for (let page = 0; page < 100; page++) {
        const response = asRecord(await this.request("thread/list", {
          limit: 100,
          archived,
          useStateDbOnly: true,
          ...(cursor ? { cursor } : {}),
        }));
        for (const rawThread of Array.isArray(response?.data) ? response.data : []) {
          const thread = asRecord(rawThread);
          const id = asString(thread?.id);
          const name = asString(thread?.name)?.replace(/\s+/g, " ").trim();
          if (id) names.set(id, name || null);
        }
        const next = asString(response?.nextCursor) ?? asString(response?.next_cursor);
        if (!next || seenCursors.has(next)) break;
        seenCursors.add(next);
        cursor = next;
      }
    };

    await collect(false);
    // Archived threads are a separate app-server listing. Failure here should
    // not discard the live thread names already collected from older servers.
    await collect(true).catch(() => undefined);
    return names;
  }
  async threadName(sessionId: string): Promise<string | null> {
    const response = asRecord(await this.request("thread/read", {
      threadId: sessionId,
      includeTurns: false,
    }));
    const thread = asRecord(response?.thread);
    return (asString(thread?.name) ?? "").replace(/\s+/g, " ").trim() || null;
  }
  async setThreadName(sessionId: string, name: string): Promise<void> {
    const normalized = name.replace(/\s+/g, " ").trim().slice(0, 120);
    if (!normalized) throw new RpcError(400, "Thread name cannot be empty");
    await this.request("thread/name/set", { threadId: sessionId, name: normalized });
  }
  async threadTurns(sessionId: string): Promise<CodexThreadTurn[]> {
    const response = asRecord(await this.request("thread/read", { threadId: sessionId, includeTurns: true }));
    const thread = asRecord(response?.thread);
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    return turns.flatMap(rawTurn => {
      const turn = asRecord(rawTurn);
      const id = asString(turn?.id);
      if (!id) return [];
      const items = Array.isArray(turn?.items) ? turn.items : [];
      const userText = items.flatMap(rawItem => {
        const item = asRecord(rawItem);
        const type = asString(item?.type);
        if (type !== "userMessage" && type !== "user_message") return [];
        const content = Array.isArray(item?.content) ? item.content : [];
        const text = content.flatMap(rawContent => {
          if (typeof rawContent === "string") return [rawContent];
          const value = asRecord(rawContent);
          return (value?.type === "text" || value?.type === "input_text") && typeof value.text === "string"
            ? [value.text]
            : [];
        }).join("\n").trim();
        return text ? [text] : [];
      }).join("\n").trim();
      return [{ id, userText }];
    });
  }
  async fork(
    sessionId: string,
    boundary: { beforeTurnId?: string; lastTurnId?: string } = {},
  ): Promise<unknown> {
    const response = await this.request("thread/fork", {
      threadId: sessionId,
      ...(boundary.beforeTurnId ? { beforeTurnId: boundary.beforeTurnId } : {}),
      ...(boundary.lastTurnId ? { lastTurnId: boundary.lastTurnId } : {}),
      // A WebUI branch must have an on-disk rollout so it remains discoverable
      // and can continue to use the same raw-JSONL streaming path as every
      // other Codex session.
      ephemeral: false,
    });
    const result = asRecord(response);
    const thread = asRecord(result?.thread);
    const id = asString(thread?.id) ?? asString(result?.threadId) ?? asString(result?.thread_id);
    if (id) {
      const source = this.threads.get(sessionId);
      this.threads.set(id, {
        active: false,
        steers: [],
        cwd: asString(thread?.cwd) ?? asString(result?.cwd) ?? source?.cwd,
        attached: true,
      });
    }
    return response;
  }
  async rollback(sessionId: string, turns = 1): Promise<unknown> { return this.request("thread/rollback", { threadId: sessionId, numTurns: turns }); }
  async goalGet(sessionId: string): Promise<unknown> { return asRecord(await this.request("thread/goal/get", { threadId: sessionId }))?.goal ?? null; }
  async goalSet(sessionId: string, fields: { objective?: string; status?: string; tokenBudget?: number }): Promise<unknown> { return asRecord(await this.request("thread/goal/set", { threadId: sessionId, ...fields }))?.goal ?? null; }
  async goalClear(sessionId: string): Promise<unknown> { return this.request("thread/goal/clear", { threadId: sessionId }); }

  respond(sessionId: string, requestId: string, answer: unknown): void {
    const pending = this.inbound.get(requestId);
    if (!pending || pending.sessionId !== sessionId) throw new RpcError(409, "Interaction is no longer pending");
    this.inbound.delete(requestId); this.state.interactions.delete(this.state.interactionKey(sessionId, requestId));
    const normalized = normalizedInteractionAnswer(answer);
    let result: unknown = normalized.accepted ?? answer;
    if (pending.method === "item/tool/requestUserInput") {
      result = userInputResult(pending.params, answer);
    } else if (pending.method === "mcpServer/elicitation/request") {
      if (normalized.accepted !== null) {
        result = {
          action: normalized.accepted ? "accept" : "decline",
          content: normalized.accepted ? normalized.content : null,
          _meta: null,
        };
      } else {
        const value = asRecord(answer);
        result = { action: asString(value?.action) ?? "accept", content: value?.content ?? value ?? null, _meta: value?._meta ?? null };
      }
    } else if (pending.method === "item/permissions/requestApproval") {
      if (normalized.accepted !== null) {
        const requested = asRecord(pending.params?.permissions); const permissions: Record<string, unknown> = {};
        if (normalized.accepted && requested?.network) permissions.network = requested.network;
        if (normalized.accepted && requested?.fileSystem) permissions.fileSystem = requested.fileSystem;
        result = { permissions, scope: "turn" };
      }
    } else if (normalized.accepted !== null) {
      result = { decision: normalized.accepted ? "accept" : "decline" };
    }
    this.send({ jsonrpc: "2.0", id: pending.rpcId, result });
    this.emit("interaction-removed", { sessionId, requestId });
  }

  private failed(error: Error, child?: ChildProcessWithoutNullStreams): void {
    if (child && this.child !== child) return;
    this.child = undefined;
    this.initializedChild = undefined;
    this.buffer = "";
    this.bufferBytes = 0;
    this.clientIds.clear();
    this.clientRequests.clear();
    this.resumingThreads.clear();
    this.startingTurns.clear();
    for (const [sessionId] of this.turnReadyWaiters) this.rejectTurnReady(sessionId, new RpcError(503, error.message));
    for (const [id, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(new RpcError(503, error.message)); this.pending.delete(id); }
    // Intentionally do not resend steers after daemon failure: user-visible chips remain retryable.
    for (const [id, state] of this.threads) {
      if (state.capacityRetry?.timer) clearTimeout(state.capacityRetry.timer);
      const wasActive = state.active; state.active = false; state.attached = false; state.steers = [];
      state.capacityRetry = undefined;
      if (wasActive) this.emit("status", { id, status: "failed", webuiAlive: false });
    }
  }
  kill(): void {
    const child = this.child;
    if (!child || child.exitCode !== null) throw new RpcError(409, "Codex app-server is not running");
    let signaled = false;
    try {
      signaled = child.kill("SIGTERM");
    } catch (error) {
      throw new RpcError(503, `Failed to terminate Codex app-server: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!signaled) throw new RpcError(503, "Failed to terminate Codex app-server");
    // Invalidate synchronously so a prompt arriving before the OS exit event
    // cannot write to the process we just asked to terminate. ensure() will
    // lazily spawn a fresh app-server on the next request.
    this.failed(new Error("Codex app-server terminated by user"), child);
  }
  close(): void { this.child?.kill("SIGTERM"); }

  private waitForTurnReady(sessionId: string, timeout = 5000): Promise<void> {
    if (this.threads.get(sessionId)?.turnId) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter: TurnReadyWaiter = { resolve, reject, timer: setTimeout(() => {
        const list = this.turnReadyWaiters.get(sessionId) ?? [];
        this.turnReadyWaiters.set(sessionId, list.filter(item => item !== waiter));
        reject(new RpcError(409, "Codex has not reported the active turn ID yet"));
      }, timeout) };
      this.turnReadyWaiters.set(sessionId, [...(this.turnReadyWaiters.get(sessionId) ?? []), waiter]);
    });
  }

  private resolveTurnReady(sessionId: string): void {
    const waiters = this.turnReadyWaiters.get(sessionId) ?? [];
    this.turnReadyWaiters.delete(sessionId);
    for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.resolve(); }
  }

  private rejectTurnReady(sessionId: string, error: Error): void {
    const waiters = this.turnReadyWaiters.get(sessionId) ?? [];
    this.turnReadyWaiters.delete(sessionId);
    for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(error); }
  }

  private finishTurn(sessionId: string, state: ThreadState, status?: string, timestamp?: string): void {
    if (state.capacityRetry?.timer) clearTimeout(state.capacityRetry.timer);
    state.capacityRetry = undefined;
    state.active = false; state.turnId = undefined;
    this.rejectTurnReady(sessionId, new RpcError(409, "Codex turn completed before reporting its ID"));
    this.emit("status", {
      id: sessionId,
      status: status === "failed" ? "failed" : "exited",
      webuiAlive: true,
      lastBoundaryAt: timestamp ?? new Date().toISOString(),
    });
    const steers = state.steers.splice(0);
    if (status === "interrupted" && steers.length) {
      // Codex steers are not durable. Resend only after an authoritative interrupted completion.
      const text = steers.map(item => item.text).filter(Boolean).join("\n\n");
      const images = steers.flatMap(item => item.images);
      void this.startTurn(sessionId, text, { cwd: state.cwd }, images).catch(error => this.emit("driver-error", { sessionId, error }));
    } else if (status !== "interrupted" && status !== "failed") {
      this.emit("steers-completed", {
        sessionId,
        clientUuids: steers.flatMap(item => item.clientUuid ? [item.clientUuid] : []),
        status,
      });
    }
  }

  private scheduleCapacityRetry(sessionId: string, state: ThreadState, turnId: string): boolean {
    const retry = state.capacityRetry;
    const error = retry?.terminalError;
    if (
      !retry
      || !error
      || error.turnId !== turnId
      || state.turnId !== turnId
      || retry.timer
      || retry.attempts >= CAPACITY_RETRY_DELAYS_MS.length
    ) return false;

    const delay = CAPACITY_RETRY_DELAYS_MS[retry.attempts]!;
    retry.attempts += 1;
    retry.supersededTurnIds.add(turnId);
    state.turnId = undefined;
    retry.timer = setTimeout(() => {
      retry.timer = undefined;
      void (async () => {
        const starting = this.startingTurns.get(sessionId);
        if (starting) await starting;
        if (!state.active || state.capacityRetry !== retry || state.turnId) return;
        await this.startTurn(sessionId, "", retry.options, [], undefined, true);
      })().catch(startError => {
        if (!state.active || state.capacityRetry !== retry) return;
        const message = startError instanceof Error ? startError.message : String(startError);
        this.finishTurn(sessionId, state, "failed");
        this.emit("turn-error", {
          sessionId,
          turnId: null,
          message: `Codex capacity retry failed: ${message}`,
          details: null,
        });
      });
    }, delay);
    retry.timer.unref?.();
    this.emit("capacity-retry", {
      sessionId,
      turnId,
      attempt: retry.attempts,
      maxAttempts: CAPACITY_RETRY_DELAYS_MS.length,
      delayMs: delay,
    });
    return true;
  }
}
