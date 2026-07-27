import { stat } from "node:fs/promises";
import {
  CodexContextUsageAccumulator,
  type CodexContextUsageSummary,
} from "@agent-webui/shared/codex";
import {
  MAX_JSONL_RECORD_BYTES,
  streamJsonlLines,
} from "./jsonl.js";

export interface FullCodexContextUsage extends CodexContextUsageSummary {
  completeHistoryScan: true;
  recordsScanned: number;
  oversizedRecords: number;
}

interface CacheEntry {
  size: number;
  mtimeMs: number;
  configuredLimit: number | null;
  value: FullCodexContextUsage;
}

const MAX_CACHE_ENTRIES = 16;
const cache = new Map<string, CacheEntry>();

function normalizedLimit(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

/**
 * Scan one fixed rollout snapshot exactly once and retain only aggregate
 * attribution state. Even a multi-gigabyte JSONL file produces a tiny result;
 * individual pathological records remain bounded by streamJsonlLines.
 */
export async function fullCodexContextUsage(
  path: string,
  configuredAutoCompactLimit: number | null = null,
): Promise<FullCodexContextUsage> {
  const limit = normalizedLimit(configuredAutoCompactLimit);
  const file = await stat(path);
  const cached = cache.get(path);
  if (
    cached
    && cached.size === file.size
    && cached.mtimeMs === file.mtimeMs
    && cached.configuredLimit === limit
  ) {
    // Refresh insertion order for simple LRU eviction.
    cache.delete(path);
    cache.set(path, cached);
    return cached.value;
  }

  const accumulator = new CodexContextUsageAccumulator(limit);
  let recordsScanned = 0;
  let oversizedRecords = 0;
  for await (const line of streamJsonlLines(path, {
    maxRecordBytes: MAX_JSONL_RECORD_BYTES,
    prefixBytes: 64 * 1024,
  })) {
    recordsScanned++;
    if (line.raw !== undefined) {
      accumulator.pushRawLine(line.raw);
    } else {
      oversizedRecords++;
      accumulator.pushOversizedPrefix(line.prefix);
    }
  }

  const value: FullCodexContextUsage = {
    ...accumulator.result(),
    completeHistoryScan: true,
    recordsScanned,
    oversizedRecords,
  };
  cache.delete(path);
  cache.set(path, {
    size: file.size,
    mtimeMs: file.mtimeMs,
    configuredLimit: limit,
    value,
  });
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return value;
}
