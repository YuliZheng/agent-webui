import type { PendingPrompt } from "../stores/prompt-pending.js";

export type PendingTranscriptItem<T> =
  | { kind: "entry"; entry: T }
  | { kind: "pending"; prompt: PendingPrompt };

/**
 * Codex pending prompts belong at their physical send boundary. A normal
 * turn/start is eventually replaced by its durable user_message; a mid-turn
 * steer may remain local forever because Codex does not echo it. Using the
 * source boundary for both also survives a stale frontend running flag when
 * the backend correctly routes the request as a steer. Claude queue prompts
 * retain their queue/first-frame behavior at the live tail.
 */
export function interleavePendingPrompts<T>(
  entries: readonly T[],
  prompts: readonly PendingPrompt[],
  sourceLineIndex: (entry: T) => number | null,
): PendingTranscriptItem<T>[] {
  const anchored = prompts
    .map((prompt, order) => ({
      prompt,
      order,
      boundary: Number.isSafeInteger(prompt.startedAtLineCount)
        ? prompt.startedAtLineCount
        : Number.MAX_SAFE_INTEGER,
    }))
    .filter(({ prompt }) => prompt.agent === "codex")
    .sort((a, b) =>
      a.boundary - b.boundary
      || a.prompt.startedAt - b.prompt.startedAt
      || a.order - b.order,
    );
  const tail = prompts.filter(prompt => prompt.agent !== "codex");
  const ordered: PendingTranscriptItem<T>[] = [];
  let anchoredIndex = 0;

  for (const entry of entries) {
    const entrySourceIndex = sourceLineIndex(entry);
    if (entrySourceIndex !== null) {
      while (
        anchoredIndex < anchored.length
        && anchored[anchoredIndex]!.boundary <= entrySourceIndex
      ) {
        ordered.push({ kind: "pending", prompt: anchored[anchoredIndex]!.prompt });
        anchoredIndex++;
      }
    }
    ordered.push({ kind: "entry", entry });
  }

  while (anchoredIndex < anchored.length) {
    ordered.push({ kind: "pending", prompt: anchored[anchoredIndex]!.prompt });
    anchoredIndex++;
  }
  for (const prompt of tail) ordered.push({ kind: "pending", prompt });
  return ordered;
}
