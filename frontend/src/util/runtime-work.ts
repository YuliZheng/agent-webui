import type { BackgroundTask, SessionListItem } from "@claude-webui/shared/api";

export interface RuntimeChecklistItem {
  id: string;
  subject: string;
  status: string;
}

type SessionStatus = "running" | "exited" | "failed" | null | undefined;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Defensively hides a running wire task that predates the current turn.
 * Turn boundaries are authoritative even when an older nested tool omitted
 * its matching completion event.
 */
export function currentTurnBackgroundTasks(
  tasks: readonly BackgroundTask[],
  boundaryAt: string | null | undefined,
): BackgroundTask[] {
  const boundary = Date.parse(boundaryAt ?? "");
  if (!Number.isFinite(boundary)) return [...tasks];
  return tasks.filter(task => {
    if (task.status !== "running") return true;
    const started = Date.parse(task.startedAt);
    return Number.isFinite(started) && started >= boundary;
  });
}

/**
 * Reconstructs the compact header checklist from explicit Claude TaskCreate /
 * TaskUpdate records. Codex update_plan is intentionally excluded: it is an
 * internal execution plan, not a distinct background worker.
 */
export function runtimeChecklist(lines: readonly string[]): RuntimeChecklistItem[] {
  const claudeTasks = new Map<string, RuntimeChecklistItem>();

  for (const raw of lines) {
    if (!raw) continue;
    const maybeClaude = raw.includes('"toolUseResult"') || raw.includes('"TaskUpdate"');
    if (!maybeClaude) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }

    const task = asRecord(asRecord(record.toolUseResult)?.task);
    if (task && typeof task.id === "string" && typeof task.subject === "string") {
      const previous = claudeTasks.get(task.id);
      claudeTasks.set(task.id, {
        id: task.id,
        subject: task.subject,
        status: typeof task.status === "string" ? task.status : previous?.status ?? "pending",
      });
    }

    const message = asRecord(record.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const rawBlock of content) {
      const block = asRecord(rawBlock);
      if (block?.type !== "tool_use" || block.name !== "TaskUpdate") continue;
      const input = asRecord(block.input);
      const id = typeof input?.taskId === "string" ? input.taskId : "";
      if (!id) continue;
      const current = claudeTasks.get(id) ?? { id, subject: `#${id}`, status: "pending" };
      if (typeof input?.subject === "string" && input.subject) current.subject = input.subject;
      if (typeof input?.status === "string" && input.status) current.status = input.status;
      claudeTasks.set(id, current);
    }
  }

  const sortedClaude = [...claudeTasks.values()].sort((a, b) => {
    const difference = Number(a.id) - Number(b.id);
    return Number.isNaN(difference) ? a.id.localeCompare(b.id) : difference;
  });
  return sortedClaude;
}

/**
 * Adds indexed Codex worker sessions to the parent's wire task list. This is
 * the durable fallback when an app-server version does not emit a recognized
 * collab-agent lifecycle notification.
 */
export function runtimeBackgroundTasks(
  wireTasks: readonly BackgroundTask[],
  sessions: readonly SessionListItem[],
  statusBySession: Readonly<Record<string, SessionStatus>>,
  parentSessionId: string,
): BackgroundTask[] {
  const merged = new Map(wireTasks.map((task) => [task.taskId, task]));
  const correlatedSessions = new Set(wireTasks.flatMap((task) => task.relatedSessionIds ?? []));
  for (const child of sessions) {
    if (child.subagent !== true || child.parentSessionId !== parentSessionId) continue;
    if (correlatedSessions.has(child.id)) continue;
    const rawStatus = statusBySession[child.id] ?? child.status;
    const status: BackgroundTask["status"] = rawStatus === "running"
      ? "running"
      : rawStatus === "failed"
        ? "failed"
        : "completed";
    const title = [child.title, child.titleEmoji].filter(Boolean).join(" ").trim();
    merged.set(child.id, {
      taskId: child.id,
      kind: "agent",
      label: title || `Subagent ${child.id.slice(0, 8)}…`,
      startedAt: child.mtime,
      status,
      ...(status !== "running" ? { completedAt: child.lastBoundaryAt ?? child.mtime } : {}),
    });
  }
  return [...merged.values()];
}
