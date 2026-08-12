import { RpcError, type SessionRecord } from "../types.js";

export const SUBAGENT_READONLY_MESSAGE =
  "This Codex sub-agent thread is read-only. Open its parent session to continue.";

type PromptableSession = Pick<SessionRecord, "agent" | "subagent" | "parentSessionId">;

/** Ordinary forks can have a parentSessionId and must remain writable. */
export function assertDirectPromptAllowed(session: PromptableSession): void {
  if (session.agent === "codex" && session.subagent === true) {
    throw new RpcError(409, SUBAGENT_READONLY_MESSAGE);
  }
}

/**
 * Keep the UI useful if an old/stale index record misses the proactive guard
 * and Codex app-server enforces the same boundary at turn/start.
 */
export function normalizeDirectPromptError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (/direct app-server input is not allowed for multi-agent v2 sub-agents/i.test(message)) {
    return new RpcError(409, SUBAGENT_READONLY_MESSAGE);
  }
  return error;
}
