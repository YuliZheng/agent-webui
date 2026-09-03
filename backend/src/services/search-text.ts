import { asRecord, asString } from "../types.js";
import {
  codexVisibleMessage,
  isCodexInjectedContextText,
} from "@agent-webui/shared/codex";

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
  // Search only clean event forms. response_item/message can carry injected
  // instructions and local image envelopes; legacy and item_completed events
  // are the user-visible transcript representations.
  const message = codexVisibleMessage(record);
  if (!message || message.transport === "response") return null;
  if (message.role === "user" && isCodexInjectedContextText(message.text)) return null;
  return normalizedResult(message.text, message.id);
}

/**
 * Oversized JSONL records cannot safely be materialized just to decide whether
 * they are searchable. All supported transcript formats put their record kind
 * near the start, so inspect only the retained prefix and reject tool/system
 * records before collecting their raw gram signature.
 */
export function searchableRecordPrefix(prefix: string): boolean {
  const types = [...prefix.matchAll(/"(?:type|kind)"\s*:\s*"([^"]+)"/gu)]
    .map(match => match[1])
    .filter((type): type is string => typeof type === "string");
  const topLevelType = types[0];
  if (topLevelType === "user" || topLevelType === "assistant") {
    return !/"(?:isMeta|isSidechain|isCompactSummary)"\s*:\s*true/gu.test(prefix)
      && !/"agentId"\s*:\s*"/gu.test(prefix)
      && !types.slice(1).includes("tool_result")
      && !/<local-command-/u.test(prefix);
  }
  if (topLevelType !== "event_msg") return false;
  const nested = types.slice(1);
  const legacyMessage = nested.some(type => type === "user_message" || type === "agent_message");
  const completedMessage = nested.includes("item_completed")
    && nested.some(type => /^(?:User|Agent|Assistant)Message$/u.test(type));
  return (legacyMessage || completedMessage)
    && !/(?:# AGENTS\.md instructions|<codex_internal_context|<permissions instructions>|<skills_instructions>|<environment_context>)/u.test(prefix);
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
