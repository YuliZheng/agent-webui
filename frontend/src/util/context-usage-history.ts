export interface IndexedUsageLine {
  index: number;
  raw: string;
}

// Matches the backend's authenticated range cap. One click performs at most
// one bounded request; it never downloads an unbounded rollout.
export const USAGE_BACKFILL_MAX_LINES = 2_000;

function parsedRecord(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function isCompactionBoundary(raw: string): boolean {
  const record = parsedRecord(raw);
  if (!record) return false;
  if (record.type === "compacted" || record.type === "context_compacted") return true;
  const payload = record.payload;
  return record.type === "event_msg"
    && !!payload
    && typeof payload === "object"
    && !Array.isArray(payload)
    && (payload as Record<string, unknown>).type === "context_compacted";
}

function isUsageRecord(raw: string): boolean {
  return raw.includes('"token_count"') || raw.includes('"thread/tokenUsage/updated"');
}

/**
 * True when the loaded slice contains the start of the context segment used by
 * the latest token report. A compaction boundary is sufficient; index zero is
 * handled by the caller because a never-compacted thread has no boundary row.
 */
export function hasLoadedCodexUsageBoundary(lines: readonly string[]): boolean {
  let sawUsage = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    if (!raw) continue;
    if (!sawUsage) {
      if (isUsageRecord(raw)) sawUsage = true;
      continue;
    }
    if (isCompactionBoundary(raw)) return true;
  }
  return false;
}

export function needsCodexUsageBackfill(
  firstLoadedIndex: number,
  lines: readonly string[],
): boolean {
  return firstLoadedIndex > 0 && !hasLoadedCodexUsageBoundary(lines);
}

/**
 * Merge a bounded older range with the sparse live cache without mutating or
 * expanding that cache. Live/cache rows win if both sources contain an index.
 */
export function mergeIndexedUsageLines(
  older: readonly IndexedUsageLine[],
  cached: readonly string[],
): string[] {
  const byIndex = new Map<number, string>();
  for (const item of older) {
    if (Number.isSafeInteger(item.index) && item.index >= 0 && item.raw) {
      byIndex.set(item.index, item.raw);
    }
  }
  for (let index = 0; index < cached.length; index++) {
    const raw = cached[index];
    if (raw) byIndex.set(index, raw);
  }
  return [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, raw]) => raw);
}
