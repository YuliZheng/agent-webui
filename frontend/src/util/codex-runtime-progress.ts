import { toolSummary } from "../parser/tool-summaries.js";
import { codexVisibleMessage } from "@agent-webui/shared/codex";

export type CodexRuntimeProgressEvent =
  | { type: "start"; preview: string; timestamp?: string }
  | { type: "assistant"; preview: string; timestamp?: string }
  | { type: "compaction-complete"; timestamp?: string }
  | { type: "tool-start"; callId: string; label: string }
  | { type: "tool-complete"; callId: string }
  | { type: "terminal"; timestamp?: string };

function compact(value: string, limit = 96): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

/** Extract only user-visible progress from one Codex rollout record. */
export function codexRuntimeProgressEvent(raw: string): CodexRuntimeProgressEvent | null {
  let record: Record<string, unknown>;
  try { record = JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const payload = (record.payload ?? {}) as Record<string, unknown>;
  const timestamp = typeof record.timestamp === "string" ? record.timestamp : undefined;

  const message = codexVisibleMessage(record);
  if (message) {
    if (message.role === "user") {
      const preview = compact(message.text, 80);
      return { type: "start", preview, ...(timestamp ? { timestamp } : {}) };
    }
    const preview = compact(message.text, 80);
    return { type: "assistant", preview, ...(timestamp ? { timestamp } : {}) };
  }

  if (record.type === "event_msg") {
    const kind = typeof payload.type === "string"
      ? payload.type
      : typeof payload.kind === "string" ? payload.kind : "";
    if (kind === "task_complete" || kind === "turn_complete" || kind === "turn_aborted") {
      return { type: "terminal", ...(timestamp ? { timestamp } : {}) };
    }
    if (kind === "context_compacted") {
      return { type: "compaction-complete", ...(timestamp ? { timestamp } : {}) };
    }
    return null;
  }

  if (record.type !== "response_item") return null;
  const callId = typeof payload.call_id === "string" ? payload.call_id : "";
  if (!callId) return null;
  if (payload.type === "function_call" || payload.type === "custom_tool_call") {
    const name = typeof payload.name === "string" ? payload.name : "tool";
    const rawInput = payload.arguments ?? payload.input;
    let input: Record<string, unknown> = {};
    try {
      const parsed = typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        input = parsed as Record<string, unknown>;
      }
    } catch {
      input = { raw: rawInput };
    }
    return {
      type: "tool-start",
      callId,
      label: `⚙ ${compact(toolSummary(name, input), 72)}`,
    };
  }
  if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
    return { type: "tool-complete", callId };
  }
  return null;
}
