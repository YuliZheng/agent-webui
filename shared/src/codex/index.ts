import { isRecord } from "../api.js";
export * from "./context-usage.js";
export * from "./messages.js";

export interface CodexRolloutLine {
  timestamp: string;
  type: "session_meta" | "response_item" | "event_msg" | "turn_context" | string;
  payload: unknown;
}

export interface CodexSessionMetaPayload {
  id: string;
  cwd: string;
  [key: string]: unknown;
}

export interface CodexResponseItemLine extends CodexRolloutLine {
  type: "response_item";
}

export interface CodexEventMessageLine extends CodexRolloutLine {
  type: "event_msg";
}

export function isCodexRolloutLine(
  value: unknown,
): value is CodexRolloutLine {
  return (
    isRecord(value) &&
    typeof value.timestamp === "string" &&
    typeof value.type === "string" &&
    Object.hasOwn(value, "payload")
  );
}

export function isCodexSessionMetaLine(
  value: unknown,
): value is CodexRolloutLine & { type: "session_meta" } {
  return isCodexRolloutLine(value) && value.type === "session_meta";
}

export function isCodexResponseItemLine(
  value: unknown,
): value is CodexResponseItemLine {
  return isCodexRolloutLine(value) && value.type === "response_item";
}

export function isCodexEventMessageLine(
  value: unknown,
): value is CodexEventMessageLine {
  return isCodexRolloutLine(value) && value.type === "event_msg";
}

export function isCodexTurnContextLine(
  value: unknown,
): value is CodexRolloutLine & { type: "turn_context" } {
  return isCodexRolloutLine(value) && value.type === "turn_context";
}

/** Accepts both current `id` and older `session_id` metadata defensively. */
export function codexSessionId(value: unknown): string | undefined {
  if (!isCodexSessionMetaLine(value) || !isRecord(value.payload)) {
    return undefined;
  }
  if (typeof value.payload.id === "string") return value.payload.id;
  return typeof value.payload.session_id === "string"
    ? value.payload.session_id
    : undefined;
}

export function codexSessionCwd(value: unknown): string | undefined {
  if (!isCodexSessionMetaLine(value) || !isRecord(value.payload)) {
    return undefined;
  }
  return typeof value.payload.cwd === "string" ? value.payload.cwd : undefined;
}

export function isCodexSessionMetaPayload(
  value: unknown,
): value is CodexSessionMetaPayload {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.cwd === "string"
  );
}

export function codexPayloadType(value: unknown): string | undefined {
  return isCodexRolloutLine(value) &&
    isRecord(value.payload) &&
    typeof value.payload.type === "string"
    ? value.payload.type
    : undefined;
}

export function codexPayloadRole(value: unknown): string | undefined {
  return isCodexRolloutLine(value) &&
    isRecord(value.payload) &&
    typeof value.payload.role === "string"
    ? value.payload.role
    : undefined;
}
