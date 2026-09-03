import type {
  CodexAccountUsageDailyBucket,
  CodexRateLimitWindow,
} from "@claude-webui/shared/api";

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface CodexWeeklyUsageEstimate {
  accountTokensInWindow: number;
  estimatedWeeklyTokenCapacity: number;
  conversationPercent: number;
}

function dailyBucketStartMs(startDate: string): number | null {
  const calendarDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startDate);
  const parsed = calendarDate
    ? Date.UTC(Number(calendarDate[1]), Number(calendarDate[2]) - 1, Number(calendarDate[3]))
    : Date.parse(startDate);
  return Number.isFinite(parsed) ? parsed : null;
}

export function accountTokensInRateLimitWindow(
  buckets: readonly CodexAccountUsageDailyBucket[],
  window: CodexRateLimitWindow | null | undefined,
): number | null {
  const durationMins = window?.windowDurationMins;
  const resetsAt = window?.resetsAt;
  if (
    typeof durationMins !== "number"
    || !Number.isFinite(durationMins)
    || durationMins <= 0
    || typeof resetsAt !== "number"
    || !Number.isFinite(resetsAt)
    || resetsAt <= 0
  ) return null;

  const windowEnd = resetsAt * 1_000;
  const windowStart = windowEnd - durationMins * 60 * 1_000;
  let total = 0;
  let matched = false;
  for (const bucket of buckets) {
    if (!Number.isFinite(bucket.tokens) || bucket.tokens < 0) continue;
    const bucketStart = dailyBucketStartMs(bucket.startDate);
    if (bucketStart === null) continue;
    const overlap = Math.max(0, Math.min(windowEnd, bucketStart + DAY_MS) - Math.max(windowStart, bucketStart));
    if (!overlap) continue;
    matched = true;
    total += bucket.tokens * (overlap / DAY_MS);
  }
  return matched ? total : null;
}

export function estimateConversationWeeklyUsage(options: {
  cumulativeTokens: number;
  weeklyUsagePercent: number | null | undefined;
  weeklyWindow: CodexRateLimitWindow | null | undefined;
  dailyUsageBuckets: readonly CodexAccountUsageDailyBucket[];
}): CodexWeeklyUsageEstimate | null {
  const { cumulativeTokens, weeklyUsagePercent, weeklyWindow, dailyUsageBuckets } = options;
  if (
    !Number.isFinite(cumulativeTokens)
    || cumulativeTokens <= 0
    || typeof weeklyUsagePercent !== "number"
    || !Number.isFinite(weeklyUsagePercent)
    || weeklyUsagePercent <= 0
  ) return null;

  const accountTokens = accountTokensInRateLimitWindow(dailyUsageBuckets, weeklyWindow);
  if (accountTokens === null || accountTokens <= 0) return null;
  const usedFraction = Math.min(100, weeklyUsagePercent) / 100;
  const estimatedWeeklyTokenCapacity = accountTokens / usedFraction;
  if (!Number.isFinite(estimatedWeeklyTokenCapacity) || estimatedWeeklyTokenCapacity <= 0) return null;

  return {
    accountTokensInWindow: Math.round(accountTokens),
    estimatedWeeklyTokenCapacity: Math.round(estimatedWeeklyTokenCapacity),
    conversationPercent: (cumulativeTokens / estimatedWeeklyTokenCapacity) * 100,
  };
}
