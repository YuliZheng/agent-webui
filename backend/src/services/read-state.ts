import type { SessionListItem } from "../types.js";
import type { ReadEntry } from "./state.js";

function timestamp(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function storedUnreadCount(entry: ReadEntry | undefined): number {
  return Number.isSafeInteger(entry?.unreadCount) && Number(entry?.unreadCount) > 0
    ? Number(entry?.unreadCount)
    : 0;
}

/** Canonical unread count exposed by the session list. */
export function sessionUnreadCount(
  session: Pick<SessionListItem, "previewRole" | "lastTurnAt" | "mtime">,
  entry: ReadEntry | undefined,
): number {
  const latest = session.lastTurnAt || session.mtime;
  if (timestamp(entry?.at) >= timestamp(latest)) return 0;

  const stored = storedUnreadCount(entry);
  if (stored > 0) return stored;

  // Migration/offline catch-up for read-state files created before unread
  // counts were persisted. The latest assistant turn is at least one unread
  // reply when the read watermark does not cover it.
  return session.previewRole === "assistant" && timestamp(latest) > timestamp(entry?.at) ? 1 : 0;
}

/** Record one newly completed assistant turn without double-counting replay. */
export function recordUnreadCompletion(entry: ReadEntry | undefined, at: string): ReadEntry {
  const completionAt = timestamp(at);
  if (!Number.isFinite(completionAt)) return entry ?? {};
  if (completionAt <= timestamp(entry?.at) || completionAt <= timestamp(entry?.unreadAt)) {
    return entry ?? {};
  }
  return {
    ...entry,
    unreadAt: at,
    unreadCount: storedUnreadCount(entry) + 1,
  };
}

/** Advance a global read watermark monotonically and clear only covered work. */
export function advanceReadEntry(entry: ReadEntry | undefined, at: string): ReadEntry {
  const requestedAt = timestamp(at);
  if (!Number.isFinite(requestedAt)) return entry ?? {};
  const nextAt = requestedAt > timestamp(entry?.at) ? at : entry?.at;
  if (!nextAt) return entry ?? {};
  return {
    ...entry,
    at: nextAt,
    unreadCount: timestamp(nextAt) >= timestamp(entry?.unreadAt)
      ? 0
      : storedUnreadCount(entry),
  };
}
