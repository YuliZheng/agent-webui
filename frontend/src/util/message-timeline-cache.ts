import { codexRolloutToClaudeLines } from "../parser/codex-adapt.js";
import { groupTimeline, type TimelineNode } from "../parser/group.js";

export interface MessageTimelineInput {
  sessionId: string;
  contentRevision: number;
  lines: string[];
  isCodex: boolean;
  suppressLatestEmptyCompletion: boolean;
}

interface CachedTimeline extends MessageTimelineInput {
  timeline: TimelineNode[];
}

// Keep only the current conversation and a few nearby/recently visited ones.
// The cache stores parsed records (not DOM), so returning with the arrow keys
// can reuse the expensive Codex adaptation + grouping without retaining an
// unbounded copy of every conversation opened during the app's lifetime.
const MAX_CACHED_TIMELINES = 4;
const MAX_PRIMED_NON_EMPTY_LINES = 800;
const MAX_PRIMED_SOURCE_CHARS = 4 * 1024 * 1024;
const timelines = new Map<string, CachedTimeline>();

function matches(cached: CachedTimeline, input: MessageTimelineInput): boolean {
  return cached.contentRevision === input.contentRevision
    && cached.lines === input.lines
    && cached.isCodex === input.isCodex
    && cached.suppressLatestEmptyCompletion === input.suppressLatestEmptyCompletion;
}

function touch(sessionId: string, cached: CachedTimeline): TimelineNode[] {
  timelines.delete(sessionId);
  timelines.set(sessionId, cached);
  return cached.timeline;
}

export function messageTimeline(input: MessageTimelineInput): TimelineNode[] {
  const cached = timelines.get(input.sessionId);
  if (cached && matches(cached, input)) return touch(input.sessionId, cached);

  const renderLines = input.isCodex
    ? codexRolloutToClaudeLines(input.lines, {
        suppressLatestEmptyCompletion: input.suppressLatestEmptyCompletion,
      })
    : input.lines;
  const timeline = groupTimeline(renderLines);
  timelines.set(input.sessionId, { ...input, timeline });
  while (timelines.size > MAX_CACHED_TIMELINES) {
    const oldest = timelines.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    timelines.delete(oldest);
  }
  return timeline;
}

// Neighbor warming runs only during browser idle time. Refuse unusually large
// inputs so speculative work can never create a new interaction hitch; those
// conversations are still parsed normally when the user explicitly opens one.
export function primeMessageTimeline(input: MessageTimelineInput): boolean {
  const cached = timelines.get(input.sessionId);
  if (cached && matches(cached, input)) {
    touch(input.sessionId, cached);
    return true;
  }

  let nonEmpty = 0;
  let sourceChars = 0;
  for (const line of input.lines) {
    if (!line) continue;
    nonEmpty++;
    sourceChars += line.length;
    if (nonEmpty > MAX_PRIMED_NON_EMPTY_LINES || sourceChars > MAX_PRIMED_SOURCE_CHARS) {
      return false;
    }
  }
  messageTimeline(input);
  return true;
}
