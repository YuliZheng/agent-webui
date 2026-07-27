export type AgentKind = "claude" | "codex";
export type ProcessStatus = "running" | "exited" | "failed";

export interface SessionListItem {
  id: string;
  cwd: string;
  mtime: string;
  size: number;
  agent: AgentKind;
  peer?: boolean;
  subagent?: boolean;
  title?: string | null;
  titleSource?: "auto" | "manual" | null;
  titleEmoji?: string | null;
  parentSessionId?: string | null;
  status?: ProcessStatus | null;
  preview?: string | null;
  lastTurnAt?: string | null;
  lastBoundaryAt?: string | null;
  readAt?: string | null;
}

export interface IndexedRawLine { index: number; raw: string }
export interface UserMessageInfo { uuid: string; parentUuid: string | null; type: string; text: string }
export interface SessionRecord extends SessionListItem { path: string }

export class RpcError extends Error {
  constructor(public code: number, message: string) { super(message); }
}

export const SESSION_ID_RE = /^[0-9A-Za-z_-]+$/;
export function assertSessionId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !SESSION_ID_RE.test(id)) throw new RpcError(400, "Invalid session ID");
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
