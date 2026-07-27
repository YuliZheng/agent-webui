type Loose = Record<string, unknown> | null | undefined;

function obj(x: unknown): Record<string, unknown> | null {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

export function topLevelType(rec: unknown): string | null {
  const o = obj(rec);
  if (!o) return null;
  return typeof o.type === "string" ? o.type : null;
}

export function isUser(rec: Loose): boolean {
  return topLevelType(rec) === "user";
}
export function isAssistant(rec: Loose): boolean {
  return topLevelType(rec) === "assistant";
}
export function isSystem(rec: Loose): boolean {
  return topLevelType(rec) === "system";
}

function userContent(rec: Loose): unknown {
  const o = obj(rec);
  const m = o ? obj(o.message) : null;
  return m ? m.content : undefined;
}

export function isUserPromptShape(rec: Loose): boolean {
  if (!isUser(rec)) return false;
  const c = userContent(rec);
  if (typeof c === "string") return true;
  if (!Array.isArray(c)) return false;
  return c.every((b) => obj(b)?.type === "text");
}

export function isUserToolResultShape(rec: Loose): boolean {
  if (!isUser(rec)) return false;
  const c = userContent(rec);
  if (!Array.isArray(c)) return false;
  return c.some((b) => obj(b)?.type === "tool_result");
}

export function hasIsMeta(rec: Loose): boolean {
  return obj(rec)?.isMeta === true;
}
export function hasIsCompactSummary(rec: Loose): boolean {
  return obj(rec)?.isCompactSummary === true;
}
export function hasIsApiErrorMessage(rec: Loose): boolean {
  return obj(rec)?.isApiErrorMessage === true;
}
export function isSidechain(rec: Loose): boolean {
  return obj(rec)?.isSidechain === true;
}

export function systemSubtype(rec: Loose): string | null {
  if (!isSystem(rec)) return null;
  const s = obj(rec)?.subtype;
  return typeof s === "string" ? s : null;
}

// CLI's internal user-message queue. Three operations observed in ~36
// captured records and confirmed against the `MWH(...)` call sites in
// the claude binary: enqueue (on every user msg into stdin), dequeue
// (queue drained to feed model when no turn in flight), remove (queued
// item consumed mid-turn or via TUI cancel).
export type QueueOperation = "enqueue" | "dequeue" | "remove";

export interface QueueOperationRecord extends Record<string, unknown> {
  type: "queue-operation";
  operation: QueueOperation;
  sessionId: string;
  timestamp: string;
  content?: string;
}

export function isQueueOperation(rec: Loose): rec is QueueOperationRecord {
  if (topLevelType(rec) !== "queue-operation") return false;
  const o = obj(rec)!;
  const op = o.operation;
  return op === "enqueue" || op === "dequeue" || op === "remove";
}

// Mid-turn queued prompts are fed to the model as `attachment` records
// of subtype `queued_command` (NOT concatenated into the next user
// block). The `prompt` field holds the verbatim user text the CLI
// dequeued. `commandMode` is "prompt" for normal prompts (only value
// observed; TUI may emit others for slash commands).
export interface QueuedCommandAttachment extends Record<string, unknown> {
  type: "attachment";
  uuid: string;
  parentUuid?: string | null;
  timestamp: string;
  sessionId: string;
  attachment: {
    type: "queued_command";
    prompt: string;
    commandMode: string;
  };
}

export function isQueuedCommandAttachment(rec: Loose): rec is QueuedCommandAttachment {
  if (topLevelType(rec) !== "attachment") return false;
  const a = obj(obj(rec)!.attachment);
  if (!a) return false;
  return a.type === "queued_command" && typeof a.prompt === "string";
}
