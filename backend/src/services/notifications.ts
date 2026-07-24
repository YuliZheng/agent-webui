import { asRecord, asString, type AgentKind } from "../types.js";

function visibleText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.flatMap(item => {
    const block = asRecord(item);
    return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("\n").trim();
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
  return ["turn_complete", "task_complete"].includes(asString(payload?.type) ?? asString(payload?.kind) ?? "");
}

/** Bounded insertion-order LRU used to suppress duplicate watcher notifications. */
export class NotificationDeduper {
  private values = new Set<string>();
  constructor(private readonly limit = 1024) {}
  seen(key: string): boolean {
    if (this.values.delete(key)) { this.values.add(key); return true; }
    this.values.add(key);
    while (this.values.size > this.limit) this.values.delete(this.values.values().next().value!);
    return false;
  }
  get size(): number { return this.values.size; }
}
