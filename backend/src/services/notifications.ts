import { asRecord, asString, type AgentKind } from "../types.js";

function visibleText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.flatMap(item => {
    const block = asRecord(item);
    return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("\n").trim();
}

export interface CodexDurableTerminal {
  kind: "completed" | "interrupted";
  timestamp?: string;
  turnId: string;
}

/**
 * Rollout terminal records are durable even when the app-server's matching
 * turn/completed notification is lost. Keep this separate from the
 * user-visible notification filter below: an empty final answer still ends a
 * turn and must clear driver/UI running state.
 */
export function codexDurableTerminal(record: Record<string, unknown>): CodexDurableTerminal | null {
  if (record.type !== "event_msg") return null;
  const payload = asRecord(record.payload);
  const type = asString(payload?.type) ?? asString(payload?.kind);
  if (type !== "task_complete" && type !== "turn_complete" && type !== "turn_aborted") return null;
  const turnId = asString(payload?.turn_id) ?? asString(payload?.turnId);
  if (!turnId) return null;
  return {
    kind: type === "turn_aborted" ? "interrupted" : "completed",
    timestamp: asString(record.timestamp),
    turnId,
  };
}

/** Empty Claude end_turn placeholders are bookkeeping, not user-visible completions. */
export function isMeaningfulEndTurnRecord(record: Record<string, unknown>, agent: AgentKind): boolean {
  if (agent === "claude") {
    if (record.type !== "assistant" || record.isSidechain === true || typeof record.agentId === "string") return false;
    const message = asRecord(record.message);
    const stopped = message?.stop_reason === "end_turn" || record.stop_reason === "end_turn";
    return stopped && visibleText(message?.content ?? record.content).length > 0;
  }
  if (record.type !== "event_msg") return false;
  const payload = asRecord(record.payload);
  const completionType = asString(payload?.type) ?? asString(payload?.kind) ?? "";
  if (completionType === "turn_complete") return true;
  if (completionType !== "task_complete") return false;
  return (asString(payload?.last_agent_message) ?? "").trim().length > 0;
}

/** Bounded insertion-order LRU used to suppress duplicate watcher notifications. */
export class NotificationDeduper {
  private values = new Set<string>();
  constructor(private readonly limit = 1024) {}
  has(key: string): boolean { return this.values.has(key); }
  remember(key: string): void {
    this.values.delete(key);
    this.values.add(key);
    while (this.values.size > this.limit) this.values.delete(this.values.values().next().value!);
  }
  seen(key: string): boolean {
    const known = this.has(key);
    this.remember(key);
    return known;
  }
  get size(): number { return this.values.size; }
}
