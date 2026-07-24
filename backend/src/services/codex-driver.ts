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
interface ThreadState { active: boolean; turnId?: string; steers: SteeredInput[]; cwd?: string; attached?: boolean }
interface PromptResult { sessionId: string; steered: boolean }
interface TurnReadyWaiter { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
export interface CodexTurnOptions {
  model?: string;
  effort?: string;
  approvalPolicy?: string;
  sandboxMode?: string;
  cwd?: string;
}
export interface CodexSettingsUpdate {
  model?: string | null;
  effort?: string | null;
  approvalPolicy?: string | null;
  sandboxMode?: string | null;
  cwd?: string;
}
export interface CodexThreadTurn {
  id: string;
  userText: string;
}

const FALLBACK_CODEX_MODELS: AgentModelOption[] = [
  {
    value: "gpt-5.6-sol",
    label: "GPT-5.6-Sol",
    description: "Fast local Codex model",
    defaultEffort: "low",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map(value => ({ value, label: value })),
  },
  {
    value: "gpt-5.6-terra",
    label: "GPT-5.6-Terra",
    description: "General-purpose local Codex model",
    defaultEffort: "medium",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map(value => ({ value, label: value })),
  },
  {
    value: "gpt-5.6-luna",
    label: "GPT-5.6-Luna",
    description: "Deep reasoning local Codex model",
    defaultEffort: "medium",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"].map(value => ({ value, label: value })),
  },
  ...["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"].map(value => ({
    value,
    label: value,
    supportedEfforts: ["low", "medium", "high", "xhigh"].map(effort => ({ value: effort, label: effort })),
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

function answerStrings(value: unknown): string[] {
  const wrapped = asRecord(value);
  const source = wrapped && Object.hasOwn(wrapped, "answers") ? wrapped.answers : value;
  const values = Array.isArray(source) ? source : source === undefined || source === null ? [] : [source];
  return values.flatMap(item => typeof item === "string" ? [item] : typeof item === "number" || typeof item === "boolean" ? [String(item)] : []);
}

function userInputResult(params: Record<string, unknown> | null, answer: unknown): { answers: Record<string, { answers: string[] }> } {
  const questions = Array.isArray(params?.questions) ? params.questions : [];
  const answerRecord = asRecord(answer);
  const supplied = asRecord(answerRecord?.answers) ?? answerRecord;
  const entries: Array<[string, { answers: string[] }]> = [];
  let usedScalar = false;

  questions.forEach((raw, index) => {
    const question = asRecord(raw);
    const id = asString(question?.id);
    if (!id) return;
    let value: unknown;
    if (supplied) {
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

export class CodexDriver extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private inbound = new Map<string, { rpcId: string | number; sessionId: string; method: string; params: Record<string, unknown> | null }>();
  private threads = new Map<string, ThreadState>();
  private clientIds = new Map<string, PromptResult>();
  private clientRequests = new Map<string, Promise<PromptResult>>();
  private startingTurns = new Map<string, Promise<unknown>>();
  private turnReadyWaiters = new Map<string, TurnReadyWaiter[]>();
  private starting?: Promise<void>;
  private resolvedBinary?: Promise<string>;
  private capabilitiesCache?: { expiresAt: number; value: AgentCapabilities };
  private capabilitiesRequest?: Promise<AgentCapabilities>;

  constructor(private binary: string, private state: AppState) { super(); }

  isActive(id: string): boolean { return this.threads.get(id)?.active === true; }

  private async ensure(): Promise<void> {
    if (this.child?.exitCode === null) return;
    if (this.starting) return this.starting;
    this.resolvedBinary ??= resolveCodexExecutable(this.binary);
    const binary = await this.resolvedBinary;
    if (this.child?.exitCode === null) return;
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      const child = spawn(binary, ["app-server", "--listen", "stdio://"], { shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, AGENT_WEBUI: "1" } });
      this.child = child;
      child.stdout.on("data", chunk => this.stdout(String(chunk)));
      child.stderr.on("data", chunk => this.emit("stderr", String(chunk).slice(-4096)));
      child.on("error", error => { reject(error); this.failed(error); });
      child.on("exit", (code, signal) => this.failed(new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})`)));
      this.rawRequest("initialize", { clientInfo: { name: "agent-webui", version: "0.1.0" }, capabilities: {} })
        .then(() => { this.send({ method: "initialized", params: {} }); resolve(); }, reject);
    }).finally(() => { this.starting = undefined; });
    return this.starting;
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
    this.buffer += chunk;
    if (this.buffer.length > 16 * 1024 * 1024) { this.buffer = ""; this.child?.kill(); return; }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim(); this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try { const msg = asRecord(JSON.parse(line)); if (msg) this.message(msg); } catch { this.emit("error", "Malformed Codex app-server record"); }
    }
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
    const state = this.threads.get(sessionId) ?? { active: false, steers: [] };
    this.threads.set(sessionId, state);
    if (method === "turn/started") {
      state.active = true; state.turnId = asString(asRecord(params?.turn)?.id) ?? asString(params?.turnId);
      if (state.turnId) this.resolveTurnReady(sessionId);
      this.emit("status", { id: sessionId, status: "running", webuiAlive: true, lastBoundaryAt: new Date().toISOString() });
    } else if (method === "turn/completed") {
      const turn = asRecord(params?.turn); const status = asString(turn?.status) ?? asString(params?.status);
      state.active = false; state.turnId = undefined;
      this.rejectTurnReady(sessionId, new RpcError(409, "Codex turn completed before reporting its ID"));
      this.emit("status", { id: sessionId, status: status === "failed" ? "failed" : "exited", webuiAlive: true, lastBoundaryAt: new Date().toISOString() });
      const steers = state.steers.splice(0);
      if (status === "interrupted" && steers.length) {
        // Codex steers are not durable. Resend only after an authoritative interrupted completion.
        const text = steers.map(item => item.text).filter(Boolean).join("\n\n");
        const images = steers.flatMap(item => item.images);
        void this.startTurn(sessionId, text, { cwd: state.cwd }, images).catch(error => this.emit("error", { sessionId, error }));
      } else if (status !== "interrupted" && status !== "failed") {
        this.emit("steers-completed", { sessionId, clientUuids: steers.flatMap(item => item.clientUuid ? [item.clientUuid] : []), status });
      }
    } else if (/(?:task|command).*(?:started|completed|finished|failed|cancelled|canceled|error)/i.test(method)) {
      this.emit("background", { sessionId, method, params });
    }
    this.emit("notification", { method, params });
  }

  async newSession(cwd: string, prompt: string, options: CodexTurnOptions = {}, images: string[] = []): Promise<{ sessionId: string }> {
    const result = asRecord(await this.request("thread/start", {
      cwd,
      ...(options.model ? { model: options.model } : {}),
      ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
      ...(options.sandboxMode ? { sandbox: options.sandboxMode } : {}),
    }));
    const thread = asRecord(result?.thread);
    const id = asString(thread?.id) ?? asString(result?.threadId) ?? asString(result?.id);
    if (!id) throw new RpcError(502, "Codex did not return a thread ID");
    this.threads.set(id, { active: false, steers: [], cwd, attached: true });
    if (prompt || images.length) await this.startTurn(id, prompt, { ...options, cwd }, images);
    return { sessionId: id };
  }

  async resume(sessionId: string): Promise<void> {
    if (this.threads.get(sessionId)?.attached) return;
    const result = asRecord(await this.request("thread/resume", { threadId: sessionId }));
    const thread = asRecord(result?.thread);
    const existing = this.threads.get(sessionId) ?? { active: false, steers: [] };
    existing.cwd ??= asString(thread?.cwd);
    existing.attached = true; this.threads.set(sessionId, existing);
  }

  private startTurn(sessionId: string, prompt: string, options: CodexTurnOptions = {}, images: string[] = [], clientUserMessageId?: string): Promise<unknown> {
    const existing = this.startingTurns.get(sessionId);
    if (existing) return existing;
    const operation = this.startTurnNow(sessionId, prompt, options, images, clientUserMessageId);
    this.startingTurns.set(sessionId, operation);
    void operation.finally(() => { if (this.startingTurns.get(sessionId) === operation) this.startingTurns.delete(sessionId); }).catch(() => undefined);
    return operation;
  }

  private async startTurnNow(sessionId: string, prompt: string, options: CodexTurnOptions = {}, images: string[] = [], clientUserMessageId?: string): Promise<unknown> {
    const state = this.threads.get(sessionId) ?? { active: false, steers: [] };
    state.cwd ??= options.cwd;
    state.active = true; this.threads.set(sessionId, state);
    this.emit("status", { id: sessionId, status: "running", webuiAlive: true, lastBoundaryAt: new Date().toISOString() });
    const input = [...images.map(path => ({ type: "localImage", path })), ...(prompt ? [{ type: "text", text: prompt, text_elements: [] }] : [])];
    try {
      const result = await this.request("turn/start", {
        threadId: sessionId,
        input,
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
        ...(options.sandboxMode ? { sandboxPolicy: this.sandboxPolicy(options.sandboxMode, options.cwd ?? state.cwd) } : {}),
        ...(clientUserMessageId ? { clientUserMessageId } : {}),
      });
      state.turnId = asString(asRecord(asRecord(result)?.turn)?.id) ?? asString(asRecord(result)?.turnId) ?? state.turnId;
      if (state.turnId) this.resolveTurnReady(sessionId);
      return result;
    }
    catch (error) { state.active = false; throw error; }
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
    models = rows.flatMap(raw => {
      const value = asRecord(raw);
      const id = asString(value?.id) ?? asString(value?.model) ?? asString(value?.slug);
      if (!id || value?.hidden === true || value?.visibility === "hide") return [];
      const efforts = Array.isArray(value?.supportedReasoningEfforts)
        ? value.supportedReasoningEfforts
        : Array.isArray(value?.supported_reasoning_efforts) ? value.supported_reasoning_efforts : [];
      const supportedEfforts = efforts.flatMap(rawEffort => {
        const effort = asRecord(rawEffort);
        const effortValue = typeof rawEffort === "string"
          ? rawEffort
          : asString(effort?.reasoningEffort) ?? asString(effort?.reasoning_effort) ?? asString(effort?.value);
        return effortValue ? [{
          value: effortValue,
          label: effortValue,
          description: asString(effort?.description) ?? null,
        }] : [];
      });
      return [{
        value: id,
        label: asString(value?.displayName) ?? asString(value?.display_name) ?? id,
        description: asString(value?.description) ?? null,
        supportedEfforts,
        defaultEffort: asString(value?.defaultReasoningEffort) ?? asString(value?.default_reasoning_effort) ?? null,
        isDefault: value?.isDefault === true || value?.is_default === true,
      }];
    });

    // Reading the local model cache above is intentionally sufficient for the
    // selector: merely opening a dropdown must not launch the relatively heavy
    // app-server. Config defaults are queried only when a daemon already exists.
    if (this.child?.exitCode === null) try {
      const result = asRecord(await this.request("config/read", { ...(cwd ? { cwd } : {}), includeLayers: false }));
      config = asRecord(result?.config) ?? result;
    } catch { /* optional on older app-server versions */ }

    if (!models.length) models = FALLBACK_CODEX_MODELS.map(model => ({ ...model, supportedEfforts: model.supportedEfforts.map(effort => ({ ...effort })) }));
    const configuredModel = asString(config?.model);
    const defaultModel = configuredModel ?? models.find(model => model.isDefault)?.value ?? null;
    const selectedModel = models.find(model => model.value === defaultModel);
    const defaultEffort = asString(config?.model_reasoning_effort) ?? asString(config?.modelReasoningEffort) ?? selectedModel?.defaultEffort ?? null;
    return {
      agent: "codex",
      models,
      permissionModes: CODEX_APPROVALS.map(option => ({ ...option })),
      sandboxModes: CODEX_SANDBOXES.map(option => ({ ...option })),
      defaults: {
        model: defaultModel,
        effort: defaultEffort,
        permissionMode: asString(config?.approval_policy) ?? asString(config?.approvalPolicy) ?? null,
        sandboxMode: asString(config?.sandbox_mode) ?? asString(config?.sandboxMode) ?? null,
      },
    };
  }

  async stop(sessionId: string): Promise<void> {
    const state = this.threads.get(sessionId);
    if (!state?.active) throw new RpcError(409, "Codex turn is not active");
    if (!state.turnId) throw new RpcError(409, "Codex has not reported the active turn ID yet");
    await this.request("turn/interrupt", { threadId: sessionId, turnId: state.turnId });
  }
  async updateSettings(sessionId: string, values: CodexSettingsUpdate): Promise<void> {
    await this.resume(sessionId);
    const { sandboxMode, cwd, ...settings } = values;
    const payload: Record<string, unknown> = { threadId: sessionId, ...settings };
    if (sandboxMode !== undefined) payload.sandboxPolicy = sandboxMode === null ? null : this.sandboxPolicy(sandboxMode, cwd ?? this.threads.get(sessionId)?.cwd);
    await this.request("thread/settings/update", payload);
  }
  async compact(sessionId: string): Promise<void> { await this.request("thread/compact/start", { threadId: sessionId }); }
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
  async fork(sessionId: string, lastTurnId?: string): Promise<unknown> {
    const response = await this.request("thread/fork", {
      threadId: sessionId,
      ...(lastTurnId ? { lastTurnId } : {}),
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
    let result: unknown = answer;
    if (pending.method === "item/tool/requestUserInput") {
      result = userInputResult(pending.params, answer);
    } else if (pending.method === "mcpServer/elicitation/request") {
      if (typeof answer === "boolean") result = { action: answer ? "accept" : "decline", content: null, _meta: null };
      else { const value = asRecord(answer); result = { action: asString(value?.action) ?? "accept", content: value?.content ?? value ?? null, _meta: value?._meta ?? null }; }
    } else if (pending.method === "item/permissions/requestApproval") {
      if (typeof answer === "boolean") {
        const requested = asRecord(pending.params?.permissions); const permissions: Record<string, unknown> = {};
        if (answer && requested?.network) permissions.network = requested.network;
        if (answer && requested?.fileSystem) permissions.fileSystem = requested.fileSystem;
        result = { permissions, scope: "turn" };
      }
    } else if (typeof answer === "boolean") result = { decision: answer ? "accept" : "decline" };
    this.send({ jsonrpc: "2.0", id: pending.rpcId, result });
    this.emit("interaction-removed", { sessionId, requestId });
  }

  private failed(error: Error): void {
    this.child = undefined;
    this.clientIds.clear();
    this.clientRequests.clear();
    this.startingTurns.clear();
    for (const [sessionId] of this.turnReadyWaiters) this.rejectTurnReady(sessionId, new RpcError(503, error.message));
    for (const [id, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(new RpcError(503, error.message)); this.pending.delete(id); }
    // Intentionally do not resend steers after daemon failure: user-visible chips remain retryable.
    for (const [id, state] of this.threads) {
      const wasActive = state.active; state.active = false; state.attached = false; state.steers = [];
      if (wasActive) this.emit("status", { id, status: "failed", webuiAlive: false });
    }
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
}
