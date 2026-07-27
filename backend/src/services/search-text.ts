import { asRecord, asString } from "../types.js";

export interface SearchableRecord {
  haystack: string;
  uuid: string | null;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap(item => {
    const part = asRecord(item);
    const type = asString(part?.type);
    return (
      type === "text"
      || type === "input_text"
      || type === "output_text"
    ) && typeof part?.text === "string"
      ? [part.text]
      : [];
  }).join("\n");
}

function codexEventText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(codexEventText).filter(Boolean).join("\n");
  const record = asRecord(value);
  if (!record) return "";
  if (typeof record.text === "string") return record.text;
  if (typeof record.message === "string") return record.message;
  return record.content === undefined ? "" : codexEventText(record.content);
}

function isCodexInjectedContext(text: string): boolean {
  const value = text.trimStart();
  return value.startsWith("# AGENTS.md instructions\n\n<INSTRUCTIONS>")
    || value.startsWith("<codex_internal_context")
    || value.startsWith("<permissions instructions>")
    || value.startsWith("<collaboration_mode>")
    || value.startsWith("<skills_instructions>")
    || value.startsWith("<apps_instructions>")
    || value.startsWith("<plugins_instructions>")
    || value.startsWith("<environment_context>");
}

function normalizedResult(text: string, uuid?: string): SearchableRecord | null {
  const normalized = text.trim().toLocaleLowerCase();
  return normalized ? { haystack: normalized, uuid: uuid ?? null } : null;
}

function claudeSearchText(record: Record<string, unknown>): SearchableRecord | null {
  if (
    record.isMeta === true
    || record.isSidechain === true
    || record.isCompactSummary === true
    || typeof record.agentId === "string"
  ) return null;
  const type = asString(record.type);
  if (type !== "user" && type !== "assistant") return null;
  const message = asRecord(record.message);
  const text = contentText(message?.content ?? record.content);
  if (type === "user" && text.trimStart().startsWith("<local-command-")) return null;
  return normalizedResult(text, asString(record.uuid));
}

function codexSearchText(record: Record<string, unknown>): SearchableRecord | null {
  // The Codex renderer deliberately uses event_msg for the clean user and
  // assistant bubbles. response_item/message records are transport duplicates
  // and may contain injected instructions or local image envelopes.
  if (record.type !== "event_msg") return null;
  const payload = asRecord(record.payload);
  if (!payload) return null;
  const kind = asString(payload.type) ?? asString(payload.kind);
  if (kind !== "user_message" && kind !== "agent_message") {
    return null;
  }
  const text = codexEventText(payload.message ?? payload.text ?? payload.content);
  if (kind === "user_message" && isCodexInjectedContext(text)) return null;
  return normalizedResult(text, asString(payload.id));
}

/**
 * Oversized JSONL records cannot safely be materialized just to decide whether
 * they are searchable. All supported transcript formats put their record kind
 * near the start, so inspect only the retained prefix and reject tool/system
 * records before collecting their raw gram signature.
 */
export function searchableRecordPrefix(prefix: string): boolean {
  const types = [...prefix.matchAll(/"(?:type|kind)"\s*:\s*"([^"]+)"/gu)].map(match => match[1]);
  const topLevelType = types[0];
  if (topLevelType === "user" || topLevelType === "assistant") {
    return !/"(?:isMeta|isSidechain|isCompactSummary)"\s*:\s*true/gu.test(prefix)
      && !/"agentId"\s*:\s*"/gu.test(prefix)
      && !types.slice(1).includes("tool_result")
      && !/<local-command-/u.test(prefix);
  }
  if (topLevelType !== "event_msg") return false;
  return types.slice(1).some(type => type === "user_message" || type === "agent_message")
    && !isCodexInjectedContext(prefix.slice(prefix.indexOf("\"message\"") + 9));
}

export function searchableRecordText(raw: string): SearchableRecord | null {
  try {
    const record = asRecord(JSON.parse(raw));
    if (!record) return null;
    return record.type === "event_msg"
      ? codexSearchText(record)
      : claudeSearchText(record);
  } catch {
    return null;
  }
}
