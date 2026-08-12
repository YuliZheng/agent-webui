export function withoutPinnedSessions(
  ids: readonly string[],
  pinnedIds: ReadonlySet<string>,
): string[] {
  return ids.filter((id) => !pinnedIds.has(id));
}
