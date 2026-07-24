import type { IndexedRawLine, NormalizedBlock } from "@/types";
import { isRecord, textOf } from "@/util/storage";

function value(record: Record<string, unknown>, line: IndexedRawLine, kind: NormalizedBlock["kind"], text?: string): NormalizedBlock {
  return {
    key: `codex-${line.index}-${kind}`, index: line.index, sourceIndexes: [line.index], agent: "codex", kind, text,
    ...(kind === "user" ? { uuid: `line-${line.index}` } : {}),
    timestamp: typeof record.timestamp === "string" ? record.timestamp : undefined
  };
}

export function isCodexInjectedContext(text: string): boolean {
  const value = text.trimStart();
  return value.startsWith("# AGENTS.md instructions\n\n<INSTRUCTIONS>") ||
    value.startsWith("<permissions instructions>") ||
    value.startsWith("<collaboration_mode>") ||
    value.startsWith("<skills_instructions>") ||
    value.startsWith("<apps_instructions>") ||
    value.startsWith("<plugins_instructions>") ||
    value.startsWith("<environment_context>");
}

export function normalizeCodexLine(line: IndexedRawLine): NormalizedBlock[] {
  let record: Record<string, unknown>;
  try { const parsed = JSON.parse(line.raw) as unknown; if (!isRecord(parsed)) return []; record = parsed; } catch { return []; }
  if (!isRecord(record.payload)) return [];
  const payload = record.payload;
  if (record.type === "response_item") {
    const type = String(payload.type ?? "");
    if (type === "message") {
      const role = String(payload.role ?? "");
      // Codex persists its injected developer/system prompt in the rollout.
      // It is execution context, not a conversational transcript entry.
      if (role !== "user" && role !== "assistant") return [];
      const text = textOf(payload.content);
      if (!text) return [];
      if (role === "user" && isCodexInjectedContext(text)) return [];
      return [value(record, line, role, text)];
    }
    if (type === "function_call" || type === "custom_tool_call" || type === "local_shell_call") {
      return [{ ...value(record, line, "tool"), toolUseId: String(payload.call_id ?? payload.id ?? ""), toolName: String(payload.name ?? type), toolInput: payload.arguments ?? payload.input ?? payload.action }];
    }
    if (type === "function_call_output" || type === "custom_tool_call_output") {
      return [{ ...value(record, line, "tool-result", textOf(payload.output)), toolUseId: String(payload.call_id ?? ""), toolResult: payload.output }];
    }
    if (type.includes("reasoning")) {
      const text = textOf(payload.summary ?? payload.content);
      return text.trim() ? [value(record, line, "thinking", text)] : [];
    }
  }
  if (record.type === "event_msg") {
    const type = String(payload.type ?? "");
    const text = textOf(payload.message ?? payload.text ?? payload.content);
    if (type === "user_message") return text && !isCodexInjectedContext(text) ? [value(record, line, "user", text)] : [];
    if (type === "agent_message") return text ? [value(record, line, "assistant", text)] : [];
    if (type.includes("reasoning")) return text ? [value(record, line, "thinking", text)] : [];
    if (type.includes("error")) return [{ ...value(record, line, "api-error", text || "Codex error"), isError: true }];
    if (type.includes("task")) return [value(record, line, "task-notification", text)];
    if (type === "token_count") return [{ ...value(record, line, "unknown"), meta: { usage: payload.info ?? payload, usageOnly: true } }];
  }
  return [];
}
