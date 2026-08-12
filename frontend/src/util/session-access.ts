import type { SessionListItem } from "@claude-webui/shared/api";

type SessionAccessMetadata = Pick<SessionListItem, "subagent" | "parentSessionId">;

/**
 * Codex sub-agent workers inherit a conversation snapshot, but they are not
 * interactive forks. Only the parent agent may steer them. Ordinary forks may
 * also have parentSessionId, so that field must never make a session read-only.
 */
export function isReadOnlySubagentSession(
  item: SessionAccessMetadata | null | undefined,
): boolean {
  return item?.subagent === true;
}

/** Search only user-addressable chats; ordinary forks remain discoverable. */
export function isSessionSearchable(
  item: SessionAccessMetadata | null | undefined,
): boolean {
  return !isReadOnlySubagentSession(item);
}
