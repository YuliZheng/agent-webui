import { asRecord, asString } from "../types.js";

export type BackgroundTaskState = "running" | "completed" | "failed" | "cancelled";

export interface BackgroundTaskRecord {
  id: string;
  title: string;
  status: BackgroundTaskState;
  kind?: "agent" | "workflow" | "shell" | "cron";
  relatedSessionIds?: string[];
  toolUseId?: string;
  detail?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

function eventStatus(method: string, params: Record<string, unknown> | null): BackgroundTaskState {
  const item = asRecord(params?.item);
  const task = asRecord(params?.task);
  const value = [method, asString(params?.status), asString(item?.status), asString(task?.status)].filter(Boolean).join(" ").toLocaleLowerCase();
  if (/(cancelled|canceled|aborted)/.test(value)) return "cancelled";
  if (/(failed|failure|error)/.test(value)) return "failed";
  if (/(completed|complete|finished|succeeded|success)/.test(value)) return "completed";
  return "running";
}

function eventId(method: string, params: Record<string, unknown> | null): string {
  const item = asRecord(params?.item);
  const task = asRecord(params?.task);
  return asString(params?.taskId) ?? asString(params?.task_id)
    ?? asString(params?.itemId) ?? asString(params?.item_id)
    ?? asString(params?.commandId) ?? asString(params?.command_id)
    ?? asString(item?.id) ?? asString(task?.id)
    ?? method.replace(/\/(?:started|completed|finished|failed|cancelled|canceled|error)$/i, "");
}

function printable(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return text.length > 8_192 ? `${text.slice(0, 8_191)}…` : text;
  } catch { return String(value); }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

/** Merge lifecycle events so a completed event replaces its matching running task. */
export function mergeCodexBackgroundTask(existing: readonly unknown[], method: string, rawParams: unknown, now = new Date().toISOString()): BackgroundTaskRecord[] {
  const params = asRecord(rawParams);
  const item = asRecord(params?.item);
  const task = asRecord(params?.task);
  const id = eventId(method, params);
  const status = eventStatus(method, params);
  const prior = existing.map(asRecord).find(value => asString(value?.id) === id);
  const descriptor = `${method} ${asString(item?.type) ?? ""} ${asString(task?.type) ?? ""}`;
  const agentTask = /(?:collab.*agent|subagent|agent.*tool)/i.test(descriptor);
  const relatedSessionIds = stringArray(item?.receiverThreadIds ?? item?.receiver_thread_ids);
  const title = asString(params?.title) ?? asString(params?.description)
    ?? asString(item?.title) ?? asString(item?.description) ?? asString(item?.name) ?? asString(item?.prompt)
    ?? asString(task?.title) ?? asString(task?.description)
    ?? (agentTask ? "Subagent" : method);
  const detail = printable(params);
  const record: BackgroundTaskRecord = {
    id,
    title,
    status,
    ...(agentTask ? { kind: "agent" as const } : {}),
    ...(relatedSessionIds.length
      ? { relatedSessionIds }
      : Array.isArray(prior?.relatedSessionIds)
        ? { relatedSessionIds: stringArray(prior.relatedSessionIds) }
        : {}),
    ...(detail ? { detail } : {}),
    startedAt: asString(prior?.startedAt) ?? asString(params?.startedAt) ?? now,
    ...(status !== "running" ? { finishedAt: asString(params?.finishedAt) ?? now } : {}),
    ...(status === "failed" ? { error: asString(params?.error) ?? asString(item?.error) ?? asString(task?.error) ?? "Task failed" } : {}),
  };
  const retained = existing.filter(value => asString(asRecord(value)?.id) !== id) as BackgroundTaskRecord[];
  return [...retained, record].slice(-100);
}

/**
 * A Codex turn boundary is authoritative: lifecycle items from the previous
 * turn cannot still be running after that turn ended or a later turn began.
 * Some nested custom tools omit (or change the id of) their completion event,
 * so id-only pairing otherwise leaves permanent sidebar spinners.
 */
export function settleRunningCodexBackgroundTasks(
  existing: readonly unknown[],
  outcome: "completed" | "failed" = "completed",
  now = new Date().toISOString(),
): BackgroundTaskRecord[] {
  let changed = false;
  const tasks = existing.map(value => {
    const record = asRecord(value);
    if (record?.status !== "running") return value as BackgroundTaskRecord;
    changed = true;
    return {
      ...record,
      status: outcome,
      finishedAt: now,
      ...(outcome === "failed"
        ? { error: asString(record.error) ?? "Codex turn failed" }
        : {}),
    } as BackgroundTaskRecord;
  });
  return changed ? tasks : existing as BackgroundTaskRecord[];
}

function claudeStatus(value: string, isError = false): BackgroundTaskState {
  const normalized = value.toLocaleLowerCase();
  if (/(cancelled|canceled|aborted|stopped|interrupted)/.test(normalized)) return "cancelled";
  if (isError || /(failed|failure|error)/.test(normalized)) return "failed";
  if (/(completed|complete|finished|succeeded|success|done)/.test(normalized)) return "completed";
  return "running";
}

function taskText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return printable(value);
  const parts = value.flatMap(item => {
    const record = asRecord(item);
    const text = asString(record?.text) ?? asString(record?.content);
    return text ? [text] : [];
  });
  return parts.length ? parts.join("\n") : printable(value);
}

interface ClaudeTaskCandidate {
  id: string;
  toolUseId?: string;
  title: string;
  status: BackgroundTaskState;
  detail?: string;
  error?: string;
}

function toolCandidates(event: Record<string, unknown>): ClaudeTaskCandidate[] {
  const message = asRecord(event.message);
  const content = Array.isArray(message?.content) ? message.content : Array.isArray(event.content) ? event.content : [];
  const candidates: ClaudeTaskCandidate[] = [];
  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    if (!block) continue;
    if (block.type === "tool_use") {
      const name = asString(block.name);
      const input = asRecord(block.input);
      const background = input?.run_in_background === true || input?.runInBackground === true || input?.background === true;
      if (!name || !/^(?:Task|Agent)$/i.test(name) || !background) continue;
      const id = asString(block.id);
      if (!id) continue;
      candidates.push({
        id,
        toolUseId: id,
        title: asString(input?.description) ?? asString(input?.prompt) ?? `${name} background task`,
        status: "running",
        detail: printable(input),
      });
      continue;
    }
    if (block.type !== "tool_result") continue;
    const toolUseId = asString(block.tool_use_id) ?? asString(block.toolUseId);
    if (!toolUseId) continue;
    const detail = taskText(block.content);
    const asynchronous = /\b(?:background|async(?:hronous)?|launched|still running|in progress)\b/i.test(detail ?? "");
    const isError = block.is_error === true || block.isError === true;
    candidates.push({
      id: toolUseId,
      toolUseId,
      title: "Background task",
      status: isError ? "failed" : asynchronous ? "running" : "completed",
      ...(detail ? { detail } : {}),
      ...(isError ? { error: detail ?? "Task failed" } : {}),
    });
  }
  return candidates;
}

function lifecycleCandidate(event: Record<string, unknown>): ClaudeTaskCandidate | undefined {
  const task = asRecord(event.task);
  const payload = asRecord(event.payload);
  const nested = task ?? asRecord(payload?.task) ?? payload;
  const subtype = asString(event.subtype) ?? asString(event.event) ?? "";
  const type = asString(event.type) ?? "";
  const marker = `${type} ${subtype} ${asString(event.status) ?? ""} ${asString(nested?.status) ?? ""}`;
  const taskLike = /(?:task|agent|background)/i.test(marker)
    || event.task_id !== undefined || event.taskId !== undefined || event.agent_id !== undefined || event.agentId !== undefined;
  if (!taskLike) return undefined;
  const id = asString(event.task_id) ?? asString(event.taskId)
    ?? asString(event.agent_id) ?? asString(event.agentId)
    ?? asString(nested?.id) ?? asString(payload?.task_id) ?? asString(payload?.taskId);
  const toolUseId = asString(event.tool_use_id) ?? asString(event.toolUseId)
    ?? asString(nested?.tool_use_id) ?? asString(nested?.toolUseId);
  if (!id && !toolUseId) return undefined;
  const detail = asString(event.message) ?? asString(event.output) ?? asString(nested?.message)
    ?? asString(nested?.output) ?? printable(nested);
  const error = asString(event.error) ?? asString(nested?.error);
  return {
    id: id ?? toolUseId!,
    ...(toolUseId ? { toolUseId } : {}),
    title: asString(event.title) ?? asString(event.description) ?? asString(nested?.title)
      ?? asString(nested?.description) ?? "Claude background task",
    status: claudeStatus(`${marker} ${detail ?? ""}`, Boolean(error)),
    ...(detail ? { detail } : {}),
    ...(error ? { error } : {}),
  };
}

function mergeClaudeCandidate(existing: readonly unknown[], candidate: ClaudeTaskCandidate, now: string): BackgroundTaskRecord[] {
  const prior = existing.map(asRecord).find(value => {
    const priorId = asString(value?.id);
    const priorToolUseId = asString(value?.toolUseId);
    return priorId === candidate.id || priorId === candidate.toolUseId
      || priorToolUseId === candidate.id || (candidate.toolUseId !== undefined && priorToolUseId === candidate.toolUseId);
  });
  const stableId = asString(prior?.id) ?? candidate.id;
  const toolUseId = candidate.toolUseId ?? asString(prior?.toolUseId);
  const priorDetail = asString(prior?.detail);
  const genericTitle = candidate.title === "Background task" || candidate.title === "Claude background task";
  const record: BackgroundTaskRecord = {
    id: stableId,
    title: genericTitle ? asString(prior?.title) ?? candidate.title : candidate.title,
    status: candidate.status,
    ...(toolUseId ? { toolUseId } : {}),
    ...(candidate.detail ? { detail: candidate.detail } : priorDetail ? { detail: priorDetail } : {}),
    startedAt: asString(prior?.startedAt) ?? now,
    ...(candidate.status !== "running" ? { finishedAt: now } : {}),
    ...(candidate.status === "failed" ? { error: candidate.error ?? "Task failed" } : {}),
  };
  const retained = existing.filter(value => {
    const current = asRecord(value);
    const currentId = asString(current?.id);
    const currentToolUseId = asString(current?.toolUseId);
    return currentId !== stableId && currentId !== candidate.id && currentId !== candidate.toolUseId
      && currentToolUseId !== candidate.id && currentToolUseId !== candidate.toolUseId;
  }) as BackgroundTaskRecord[];
  return [...retained, record].slice(-100);
}

/**
 * Reduces Claude's evolving stream-json task shapes into one stable lifecycle
 * record per Task/Agent invocation. Unrelated wire events preserve identity so
 * callers can avoid emitting redundant snapshots.
 */
export function mergeClaudeBackgroundTasks(existing: readonly unknown[], rawEvent: unknown, now = new Date().toISOString()): BackgroundTaskRecord[] {
  const event = asRecord(rawEvent);
  if (!event) return existing as BackgroundTaskRecord[];
  const candidates = [...toolCandidates(event)];
  const lifecycle = lifecycleCandidate(event);
  if (lifecycle) candidates.push(lifecycle);
  if (!candidates.length) return existing as BackgroundTaskRecord[];
  let tasks = existing as readonly unknown[];
  for (const candidate of candidates) {
    const hasPrior = tasks.some(value => {
      const record = asRecord(value);
      return asString(record?.id) === candidate.id || asString(record?.toolUseId) === candidate.id
        || (candidate.toolUseId !== undefined && (asString(record?.id) === candidate.toolUseId || asString(record?.toolUseId) === candidate.toolUseId));
    });
    // A generic tool_result is relevant only if its Task/Agent invocation is known.
    if (candidate.title === "Background task" && !hasPrior) continue;
    tasks = mergeClaudeCandidate(tasks, candidate, now);
  }
  return tasks === existing ? existing as BackgroundTaskRecord[] : tasks as BackgroundTaskRecord[];
}

/** Finalize tasks that cannot continue after the owned Claude process exits. */
export function failRunningClaudeBackgroundTasks(existing: readonly unknown[], now = new Date().toISOString()): BackgroundTaskRecord[] {
  let changed = false;
  const tasks = existing.map(value => {
    const record = asRecord(value);
    if (record?.status !== "running") return value as BackgroundTaskRecord;
    changed = true;
    return { ...record, status: "failed", finishedAt: now, error: asString(record.error) ?? "Claude process exited" } as BackgroundTaskRecord;
  });
  return changed ? tasks : existing as BackgroundTaskRecord[];
}
