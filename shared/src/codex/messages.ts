import { isRecord } from "../api.js";

export type CodexVisibleMessageRole = "user" | "assistant";
export type CodexVisibleMessageTransport = "response" | "legacy-event" | "item-completed";

export interface CodexVisibleMessage {
  role: CodexVisibleMessageRole;
  text: string;
  transport: CodexVisibleMessageTransport;
  id?: string;
  clientId?: string;
}

interface CodexMessageTextState {
  imageIndex: number;
}

function codexMessageTextWithState(value: unknown, state: CodexMessageTextState): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(item => codexMessageTextWithState(item, state)).filter(Boolean).join("\n");
  }
  if (!isRecord(value)) return "";
  // Newer Codex app-server rollouts persist image-only user prompts as an
  // item_completed/UserMessage containing local_image blocks and no text.
  // Give those blocks the same placeholder used by mixed image/text prompts
  // so the frontend can pair the durable user event with the preceding
  // response_item/input_image payload instead of dropping the whole turn.
  if (typeof value.type === "string" && value.type.toLowerCase() === "local_image") {
    state.imageIndex += 1;
    return `[Image #${state.imageIndex}]`;
  }
  if (typeof value.text === "string") return value.text;
  if (typeof value.message === "string") return value.message;
  return value.content === undefined ? "" : codexMessageTextWithState(value.content, state);
}

export function codexMessageText(value: unknown): string {
  return codexMessageTextWithState(value, { imageIndex: 0 });
}

export function isCodexInjectedContextText(text: string): boolean {
  const value = text.trimStart();
  return value.startsWith("# AGENTS.md instructions")
    || value.startsWith("<codex_internal_context")
    || value.startsWith("<permissions instructions>")
    || value.startsWith("<collaboration_mode>")
    || value.startsWith("<skills_instructions>")
    || value.startsWith("<apps_instructions>")
    || value.startsWith("<plugins_instructions>")
    || value.startsWith("<recommended_plugins>")
    || value.startsWith("<rollout_budget>")
    || value.startsWith("<turn_aborted>")
    || value.startsWith("<multi_agent_mode>")
    || value.startsWith("<environment_context>");
}

function messageId(value: Record<string, unknown>): string | undefined {
  return typeof value.id === "string" && value.id ? value.id : undefined;
}

function clientMessageId(...values: Array<Record<string, unknown>>): string | undefined {
  for (const value of values) {
    const id = typeof value.client_id === "string"
      ? value.client_id
      : typeof value.clientId === "string" ? value.clientId : undefined;
    if (id) return id;
  }
  return undefined;
}

export function codexVisibleMessage(value: unknown): CodexVisibleMessage | null {
  if (!isRecord(value)) return null;
  const payload = isRecord(value.payload) ? value.payload : null;
  if (!payload) return null;

  if (value.type === "response_item" && payload.type === "message") {
    const role = payload.role === "user"
      ? "user"
      : payload.role === "assistant" ? "assistant" : null;
    const text = codexMessageText(payload.content);
    if (!role || !text) return null;
    return {
      role,
      text,
      transport: "response",
      ...(messageId(payload) ? { id: messageId(payload) } : {}),
      ...(clientMessageId(payload) ? { clientId: clientMessageId(payload) } : {}),
    };
  }

  if (value.type !== "event_msg") return null;
  const kind = typeof payload.type === "string"
    ? payload.type
    : typeof payload.kind === "string" ? payload.kind : "";
  if (kind === "user_message" || kind === "agent_message" || kind === "assistant_message") {
    const role = kind === "user_message" ? "user" : "assistant";
    const text = codexMessageText(payload.message ?? payload.text ?? payload.content);
    if (!text) return null;
    return {
      role,
      text,
      transport: "legacy-event",
      ...(messageId(payload) ? { id: messageId(payload) } : {}),
      ...(clientMessageId(payload) ? { clientId: clientMessageId(payload) } : {}),
    };
  }

  if (kind !== "item_completed" || !isRecord(payload.item)) return null;
  const item = payload.item;
  const itemType = typeof item.type === "string" ? item.type.toLowerCase() : "";
  const role = itemType === "usermessage"
    ? "user"
    : itemType === "agentmessage" || itemType === "assistantmessage" ? "assistant" : null;
  const text = codexMessageText(item.content ?? item.message ?? item.text);
  if (!role || !text) return null;
  return {
    role,
    text,
    transport: "item-completed",
    ...(messageId(item) ? { id: messageId(item) } : {}),
    ...(clientMessageId(item, payload) ? { clientId: clientMessageId(item, payload) } : {}),
  };
}

export function codexVisibleMessageFromJson(raw: string): CodexVisibleMessage | null {
  try {
    return codexVisibleMessage(JSON.parse(raw));
  } catch {
    return null;
  }
}

function normalizedVisibleText(message: CodexVisibleMessage): string {
  let text = message.text.replace(/\r\n?/g, "\n").trim();
  if (message.role === "user") {
    text = text.replace(/<image\b[^>]*>\s*<\/image>\s*/giu, "").trim();
  }
  return text;
}

export function sameCodexVisibleMessage(
  left: CodexVisibleMessage,
  right: CodexVisibleMessage,
): boolean {
  return left.role === right.role && normalizedVisibleText(left) === normalizedVisibleText(right);
}

export function codexVisibleMessagePriority(message: CodexVisibleMessage): number {
  return message.transport === "response" ? 1 : 2;
}
