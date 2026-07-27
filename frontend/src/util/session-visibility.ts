import type { SessionListItem } from "@claude-webui/shared/api";

export interface OrdinarySessionVisibilityPrefs {
  hidden: readonly string[];
  showPeerSessions: boolean;
  showSubagentSessions: boolean;
}

/**
 * Visibility for the ordinary sidebar tree (Active/Pinned/groups/cwd buckets).
 * Search deliberately bypasses this helper so hidden worker sessions remain
 * discoverable. A directly selected subagent also remains mounted, which makes
 * deep links and search navigation stable while the preference is off.
 */
export function isOrdinarySidebarSessionVisible(
  item: SessionListItem | undefined,
  prefs: OrdinarySessionVisibilityPrefs,
  selectedSessionId: string | null = null,
): boolean {
  if (!item || prefs.hidden.includes(item.id)) return false;
  if (!prefs.showPeerSessions && item.peer === true) return false;
  if (
    !prefs.showSubagentSessions
    && item.subagent === true
    && item.id !== selectedSessionId
  ) {
    return false;
  }
  return true;
}
