import { isRecord } from "./api.js";

export interface ClaudeBaseRecord {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  cwd?: string;
  sessionId?: string;
  isSidechain?: boolean;
  agentId?: string;
  [key: string]: unknown;
}

export interface ClaudeTextBlock {
  type: "text";
  text: string;
  [key: string]: unknown;
}

export interface ClaudeThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
  [key: string]: unknown;
}

export interface ClaudeToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
  [key: string]: unknown;
}

export interface ClaudeToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
  [key: string]: unknown;
}

export type ClaudeAssistantContentBlock =
  | ClaudeTextBlock
  | ClaudeThinkingBlock
  | ClaudeToolUseBlock
  | (Record<string, unknown> & { type: string });

export interface ClaudeMessage {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface ClaudeUserRecord extends ClaudeBaseRecord {
  type: "user";
  message?: ClaudeMessage;
  toolUseResult?: unknown;
}

export interface ClaudeAssistantRecord extends ClaudeBaseRecord {
  type: "assistant";
  message?: ClaudeMessage;
}

export interface ClaudeSystemRecord extends ClaudeBaseRecord {
  type: "system";
  subtype?: string;
}

export interface ClaudeAttachmentRecord extends ClaudeBaseRecord {
  type: "attachment";
  attachment?: unknown;
}

export interface ClaudeQueueOperationRecord extends ClaudeBaseRecord {
  type: "queue-operation";
  operation?: string;
}

export interface ClaudeQueuedCommandAttachment
  extends ClaudeAttachmentRecord {
  attachment: {
    type: "queued_command";
    [key: string]: unknown;
  };
}

export function topLevelType(value: unknown): string | undefined {
  return isRecord(value) && typeof value.type === "string"
    ? value.type
    : undefined;
}

export function isUser(value: unknown): value is ClaudeUserRecord {
  return topLevelType(value) === "user";
}

export function isAssistant(value: unknown): value is ClaudeAssistantRecord {
  return topLevelType(value) === "assistant";
}

export function isSystem(value: unknown): value is ClaudeSystemRecord {
  return topLevelType(value) === "system";
}

export function isAttachment(value: unknown): value is ClaudeAttachmentRecord {
  return topLevelType(value) === "attachment";
}

export function claudeMessage(value: unknown): ClaudeMessage | undefined {
  if (!isRecord(value)) return undefined;
  return isRecord(value.message)
    ? (value.message as ClaudeMessage)
    : undefined;
}

export function claudeMessageContent(value: unknown): unknown {
  return claudeMessage(value)?.content;
}

export function isClaudeTextBlock(value: unknown): value is ClaudeTextBlock {
  return (
    isRecord(value) && value.type === "text" && typeof value.text === "string"
  );
}

export function isClaudeThinkingBlock(
  value: unknown,
): value is ClaudeThinkingBlock {
  return (
    isRecord(value) &&
    value.type === "thinking" &&
    typeof value.thinking === "string"
  );
}

export function isClaudeToolUseBlock(
  value: unknown,
): value is ClaudeToolUseBlock {
  return (
    isRecord(value) &&
    value.type === "tool_use" &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    Object.hasOwn(value, "input")
  );
}

export function isClaudeToolResultBlock(
  value: unknown,
): value is ClaudeToolResultBlock {
  return (
    isRecord(value) &&
    value.type === "tool_result" &&
    typeof value.tool_use_id === "string"
  );
}

export function isUserPromptShape(value: unknown): value is ClaudeUserRecord {
  if (!isUser(value)) return false;
  const content = claudeMessageContent(value);
  if (typeof content === "string") return true;
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every(isClaudeTextBlock)
  );
}

export function isUserToolResultShape(
  value: unknown,
): value is ClaudeUserRecord {
  if (!isUser(value)) return false;
  const content = claudeMessageContent(value);
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every(isClaudeToolResultBlock)
  );
}

function booleanMarker(value: unknown, key: string): boolean {
  if (!isRecord(value)) return false;
  if (value[key] === true) return true;
  return isRecord(value.message) && value.message[key] === true;
}

export function hasIsMeta(value: unknown): boolean {
  return booleanMarker(value, "isMeta");
}

export function hasIsCompactSummary(value: unknown): boolean {
  return booleanMarker(value, "isCompactSummary");
}

export function hasIsApiErrorMessage(value: unknown): boolean {
  return booleanMarker(value, "isApiErrorMessage");
}

export function isSidechain(value: unknown): boolean {
  return isRecord(value) && value.isSidechain === true;
}

export function systemSubtype(value: unknown): string | undefined {
  return isSystem(value) && typeof value.subtype === "string"
    ? value.subtype
    : undefined;
}

export function isQueueOperation(
  value: unknown,
): value is ClaudeQueueOperationRecord {
  return topLevelType(value) === "queue-operation";
}

export function isQueuedCommandAttachment(
  value: unknown,
): value is ClaudeQueuedCommandAttachment {
  if (!isAttachment(value)) return false;
  return isRecord(value.attachment) && value.attachment.type === "queued_command";
}

export function assistantContentBlocks(
  value: unknown,
): ClaudeAssistantContentBlock[] {
  if (!isAssistant(value)) return [];
  const content = claudeMessageContent(value);
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block): block is ClaudeAssistantContentBlock =>
      isRecord(block) && typeof block.type === "string",
  );
}

export function userToolResultBlocks(value: unknown): ClaudeToolResultBlock[] {
  if (!isUser(value)) return [];
  const content = claudeMessageContent(value);
  return Array.isArray(content) ? content.filter(isClaudeToolResultBlock) : [];
}

export function structuredToolUseResult(value: unknown): unknown | undefined {
  return isUser(value) && Object.hasOwn(value, "toolUseResult")
    ? value.toolUseResult
    : undefined;
}

export function recordUuid(value: unknown): string | undefined {
  return isRecord(value) && typeof value.uuid === "string"
    ? value.uuid
    : undefined;
}

export function recordParentUuid(value: unknown): string | null | undefined {
  if (!isRecord(value)) return undefined;
  return value.parentUuid === null || typeof value.parentUuid === "string"
    ? value.parentUuid
    : undefined;
}
