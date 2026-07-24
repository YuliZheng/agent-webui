import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { asRecord, asString, RpcError } from "../types.js";
import type { AppState, Interaction } from "./state.js";

interface OwnedClaude {
  child: ChildProcessWithoutNullStreams;
  sessionId?: string;
  cwd: string;
  buffer: string;
  active: boolean;
  compacting: boolean;
  normalSignal?: boolean;
  initResolve?: (id: string) => void;
  initReject?: (error: Error) => void;
  interactions: Set<string>;
}

export interface ClaudePromptOptions { model?: string; effort?: string; permissionMode?: string; images?: unknown[] }

export function claudeSpawnArgs(
  resumeId: string | undefined,
  model: string | undefined,
  permissionMode: string | undefined,
): string[] {
  const args = ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-prompt-tool", "stdio"];
  if (resumeId) args.push("--resume", resumeId);
  if (model) args.push("--model", model);
  if (permissionMode) args.push("--permission-mode", permissionMode);
  return args;
}

export function claudeExitStatus(
  code: number | null,
  signal: NodeJS.Signals | null,
  normalSignal = false,
): "exited" | "failed" {
  return normalSignal || signal !== null || code === null || [0, 130, 137, 143].includes(code)
    ? "exited"
    : "failed";
}

export class ClaudeDriver extends EventEmitter {
  private owned = new Map<string, OwnedClaude>();
  private all = new Set<OwnedClaude>();
  private clientIds = new Map<string, string>();
  private clientRequests = new Map<string, Promise<{ sessionId: string; queued: boolean }>>();
  private startingSessions = new Map<string, Promise<{ process: OwnedClaude; sessionId: Promise<string> }>>();
  constructor(private binary: string, private sessionsDir: string, private state: AppState) { super(); }

  isOwned(id: string): boolean { return this.owned.has(id); }
  isActive(id: string): boolean { return this.owned.get(id)?.active === true; }

  private async foreignAttachment(sessionId: string): Promise<boolean> {
    let files: string[];
    try { files = await readdir(this.sessionsDir); } catch { return false; }
    for (const name of files) {
      if (!name.endsWith(".json")) continue;
      try {
        const value = asRecord(JSON.parse(await readFile(join(this.sessionsDir, name), "utf8")));
        const id = asString(value?.sessionId) ?? asString(value?.session_id);
        const pid = typeof value?.pid === "number" ? value.pid : Number(value?.pid);
        if (id !== sessionId || !Number.isSafeInteger(pid) || pid <= 0) continue;
        try { process.kill(pid, 0); } catch { continue; }
        if (this.owned.get(sessionId)?.child.pid === pid) continue;
        // On Linux, reject a stale registration if its recorded /proc start tick differs.
        if (process.platform !== "win32" && value?.startTime !== undefined) {
          try {
            const statLine = await readFile(`/proc/${pid}/stat`, "utf8");
            const actual = statLine.slice(statLine.lastIndexOf(")") + 2).split(" ")[19];
            if (String(value.startTime) !== actual) continue;
          } catch { continue; }
        }
        return true;
      } catch { /* ignore malformed registration */ }
    }
    return false;
  }

  async assertMutable(sessionId: string): Promise<void> {
    if (!this.isOwned(sessionId) && await this.foreignAttachment(sessionId)) throw new RpcError(409, "Session is attached to a foreign Claude process; explicit takeover is required");
  }

  private effective(value: string | undefined): string | undefined { return value?.trim() || undefined; }

  async start(cwd: string, resumeId: string | undefined, options: ClaudePromptOptions = {}): Promise<{ process: OwnedClaude; sessionId: Promise<string> }> {
    if (resumeId) {
      const existing = this.owned.get(resumeId);
      if (existing && existing.child.exitCode === null) return { process: existing, sessionId: Promise.resolve(resumeId) };
      const starting = this.startingSessions.get(resumeId);
      if (starting) return starting;
      const operation = this.startProcess(cwd, resumeId, options);
      this.startingSessions.set(resumeId, operation);
      try { return await operation; }
      finally { if (this.startingSessions.get(resumeId) === operation) this.startingSessions.delete(resumeId); }
    }
    return this.startProcess(cwd, undefined, options);
  }

  private async startProcess(cwd: string, resumeId: string | undefined, options: ClaudePromptOptions): Promise<{ process: OwnedClaude; sessionId: Promise<string> }> {
    if (resumeId) await this.assertMutable(resumeId);
    const settings = resumeId ? (await this.state.settings.get())[resumeId] : undefined;
    const prefs = await this.state.prefs.get();
    const model = this.effective(options.model) ?? this.effective(settings?.model) ?? this.effective(prefs.defaultClaudeModel as string | undefined);
    const permission = this.effective(options.permissionMode) ?? this.effective(settings?.permissionMode) ?? this.effective(prefs.defaultClaudePermissionMode as string | undefined);
    const args = claudeSpawnArgs(resumeId, model, permission);
    const child = spawn(this.binary, args, {
      cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      env: { ...process.env, AGENT_WEBUI: "1", ...(resumeId ? { AGENT_WEBUI_RESUME_SESSION_ID: resumeId } : {}) },
    });
    const processState: OwnedClaude = { child, sessionId: resumeId, cwd, buffer: "", active: false, compacting: false, interactions: new Set() };
    this.all.add(processState);
    if (resumeId) this.owned.set(resumeId, processState);
    const sessionId = new Promise<string>((resolve, reject) => {
      if (resumeId) resolve(resumeId);
      else { processState.initResolve = resolve; processState.initReject = reject; }
    });
    child.stdout.on("data", chunk => this.stdout(processState, String(chunk)));
    child.stderr.on("data", chunk => this.emit("stderr", { sessionId: processState.sessionId, text: String(chunk).slice(-4096) }));
    child.on("error", error => processState.initReject?.(error));
    child.on("exit", (code, signal) => this.exited(processState, code, signal));
    return { process: processState, sessionId };
  }

  private stdout(proc: OwnedClaude, chunk: string): void {
    proc.buffer += chunk;
    let newline: number;
    while ((newline = proc.buffer.indexOf("\n")) >= 0) {
      const line = proc.buffer.slice(0, newline).trim(); proc.buffer = proc.buffer.slice(newline + 1);
      if (!line) continue;
      let event: Record<string, unknown> | null = null;
      try { event = asRecord(JSON.parse(line)); } catch { this.emit("error", { sessionId: proc.sessionId, message: "Malformed Claude stream record" }); }
      if (event) this.handle(proc, event);
    }
    if (proc.buffer.length > 4 * 1024 * 1024) {
      proc.buffer = "";
      this.emit("error", { sessionId: proc.sessionId, message: "Claude produced an oversized unframed response; stream buffer was reset" });
    }
  }

  private setActive(proc: OwnedClaude, active: boolean): void {
    if (proc.active === active) return;
    proc.active = active;
    const at = new Date().toISOString();
    if (proc.sessionId) this.emit("status", { id: proc.sessionId, status: active ? "running" : "exited", webuiAlive: true, compacting: proc.compacting, lastBoundaryAt: at });
  }

  private handle(proc: OwnedClaude, event: Record<string, unknown>): void {
    const subtype = asString(event.subtype);
    if (event.type === "system" && subtype === "init") {
      const id = asString(event.session_id) ?? asString(event.sessionId);
      if (id && /^[0-9A-Za-z_-]+$/.test(id)) {
        proc.sessionId = id; this.owned.set(id, proc); proc.initResolve?.(id); proc.initResolve = undefined;
        this.emit("init", { id, model: event.model, permissionMode: event.permissionMode ?? event.permission_mode });
      }
      this.setActive(proc, true);
    } else if (event.type === "assistant") this.setActive(proc, true);
    else if (event.type === "result") this.setActive(proc, false);
    else if (event.type === "system" && subtype === "status") {
      proc.compacting = event.status === "compacting" || event.compacting === true;
      if (proc.sessionId) this.emit("status", { id: proc.sessionId, status: proc.active ? "running" : "exited", webuiAlive: true, compacting: proc.compacting });
    } else if (event.type === "control_request") this.controlRequest(proc, event);
    this.emit("wire", { sessionId: proc.sessionId, event });
  }

  private controlRequest(proc: OwnedClaude, event: Record<string, unknown>): void {
    const requestId = asString(event.request_id) ?? asString(event.requestId);
    const request = asRecord(event.request);
    if (!requestId || !proc.sessionId) return;
    if (request?.subtype !== "can_use_tool") {
      this.write(proc, { type: "control_response", response: { subtype: "error", request_id: requestId, error: "Unsupported control request" } });
      return;
    }
    const toolName = asString(request.tool_name) ?? asString(request.toolName);
    const input = asRecord(request.input);
    const questionItems = Array.isArray(input?.questions) ? input.questions : [];
    const firstQuestion = asRecord(questionItems[0]);
    const firstOptions = Array.isArray(firstQuestion?.options) ? firstQuestion.options : [];
    const interaction: Interaction = {
      sessionId: proc.sessionId, requestId, kind: toolName === "AskUserQuestion" ? "question" : "permission",
      toolName, input: request.input, questions: questionItems, toolUseId: asString(request.tool_use_id) ?? null,
      command: asString(input?.command) ?? null, description: asString(input?.description) ?? null,
      title: toolName === "AskUserQuestion" ? asString(firstQuestion?.header) ?? "Question" : `${toolName ?? "Tool"} permission`,
      message: toolName === "AskUserQuestion" ? asString(firstQuestion?.question) ?? "Claude needs an answer" : asString(input?.description) ?? asString(input?.command) ?? `Allow ${toolName ?? "this tool"}?`,
      options: firstOptions.flatMap(option => { const item = asRecord(option); const label = asString(item?.label); return label ? [{ label, value: label }] : []; }),
      createdAt: new Date().toISOString(), agent: "claude",
    };
    proc.interactions.add(requestId);
    this.state.interactions.set(this.state.interactionKey(proc.sessionId, requestId), interaction);
    this.emit("interaction-added", interaction);
  }

  private write(proc: OwnedClaude, event: unknown): void {
    if (!proc.child.stdin.writable) throw new RpcError(409, "Claude process is not writable");
    proc.child.stdin.write(`${JSON.stringify(event)}\n`);
  }

  private input(prompt: string, images: unknown[] = []): unknown {
    const content: unknown[] = [];
    for (const image of images) {
      const obj = asRecord(image); const data = asString(obj?.data); const mediaType = asString(obj?.mediaType) ?? asString(obj?.type);
      if (data && mediaType?.startsWith("image/")) content.push({ type: "image", source: { type: "base64", media_type: mediaType, data } });
      else if (data && mediaType === "application/pdf") content.push({ type: "document", source: { type: "base64", media_type: mediaType, data } });
      else if (typeof image === "string") content.push({ type: "text", text: `[Attachment: ${image}]` });
    }
    content.push({ type: "text", text: prompt });
    return { type: "user", message: { role: "user", content } };
  }

  async newSession(cwd: string, prompt: string, options: ClaudePromptOptions = {}): Promise<{ sessionId: string }> {
    const started = await this.start(cwd, undefined, options);
    this.write(started.process, this.input(prompt, options.images));
    const sessionId = await Promise.race([
      started.sessionId,
      new Promise<never>((_, reject) => setTimeout(() => reject(new RpcError(504, "Claude did not initialize in time")), 15_000)),
    ]);
    return { sessionId };
  }

  async prompt(sessionId: string, cwd: string, prompt: string, options: ClaudePromptOptions & { clientUuid?: string } = {}): Promise<{ sessionId: string; queued: boolean }> {
    const clientKey = options.clientUuid ? `${sessionId}:${options.clientUuid}` : undefined;
    if (clientKey) {
      const prior = this.clientIds.get(clientKey);
      if (prior) return { sessionId: prior, queued: this.isActive(prior) };
      const inflight = this.clientRequests.get(clientKey);
      if (inflight) return inflight;
    }
    const operation = this.promptOnce(sessionId, cwd, prompt, options);
    if (clientKey) this.clientRequests.set(clientKey, operation);
    try {
      const result = await operation;
      if (clientKey) {
        this.clientIds.set(clientKey, sessionId);
        if (this.clientIds.size > 1000) this.clientIds.delete(this.clientIds.keys().next().value!);
      }
      return result;
    } finally {
      if (clientKey && this.clientRequests.get(clientKey) === operation) this.clientRequests.delete(clientKey);
    }
  }

  private async promptOnce(sessionId: string, cwd: string, prompt: string, options: ClaudePromptOptions): Promise<{ sessionId: string; queued: boolean }> {
    let proc = this.owned.get(sessionId);
    if (!proc || proc.child.exitCode !== null) proc = (await this.start(cwd, sessionId, options)).process;
    const queued = proc.active;
    this.write(proc, this.input(prompt, options.images));
    this.setActive(proc, true);
    return { sessionId, queued };
  }

  stop(sessionId: string): void {
    const proc = this.owned.get(sessionId);
    if (!proc) throw new RpcError(409, "Session has no WebUI-owned process");
    if (!proc.active) throw new RpcError(409, "Claude turn is not active");
    this.write(proc, { type: "control_request", request_id: `interrupt-${Date.now()}`, request: { subtype: "interrupt" } });
  }

  kill(sessionId: string): void {
    const proc = this.owned.get(sessionId);
    if (!proc) throw new RpcError(409, "Only WebUI-owned processes can be killed");
    proc.normalSignal = true; proc.child.kill("SIGTERM");
  }

  async compact(sessionId: string, cwd: string): Promise<void> {
    let proc = this.owned.get(sessionId);
    if (!proc || proc.child.exitCode !== null) proc = (await this.start(cwd, sessionId)).process;
    this.write(proc, this.input("/compact"));
    this.setActive(proc, true);
  }

  respond(sessionId: string, requestId: string, answer: unknown): void {
    const proc = this.owned.get(sessionId);
    if (!proc || !proc.interactions.has(requestId)) throw new RpcError(409, "Interaction is no longer pending");
    const interaction = this.state.interactions.get(this.state.interactionKey(sessionId, requestId));
    proc.interactions.delete(requestId);
    this.state.interactions.delete(this.state.interactionKey(sessionId, requestId));
    const object = asRecord(answer);
    const behavior = object?.behavior === "deny" || answer === "deny" || answer === false ? "deny" : "allow";
    const updatedInput = object?.updatedInput ?? object?.answers ?? (interaction?.kind === "permission" ? interaction.input : answer);
    this.write(proc, { type: "control_response", response: { subtype: "success", request_id: requestId, response: { behavior, updatedInput } } });
    this.emit("interaction-removed", { sessionId, requestId });
  }

  private exited(proc: OwnedClaude, code: number | null, signal: NodeJS.Signals | null): void {
    this.all.delete(proc); if (proc.sessionId) this.owned.delete(proc.sessionId);
    proc.initReject?.(new RpcError(502, `Claude exited before initialization (${code ?? signal ?? "unknown"})`));
    for (const requestId of proc.interactions) {
      if (proc.sessionId) {
        this.state.interactions.delete(this.state.interactionKey(proc.sessionId, requestId));
        this.emit("interaction-removed", { sessionId: proc.sessionId, requestId });
      }
    }
    if (proc.sessionId) this.emit("status", { id: proc.sessionId, status: claudeExitStatus(code, signal, proc.normalSignal), webuiAlive: false });
  }

  close(): void { for (const proc of this.all) { proc.normalSignal = true; proc.child.kill("SIGTERM"); } }
}
