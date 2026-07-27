// Parse a claude-code `<task-notification>…</task-notification>` blob (injected
// when a `Bash run_in_background` task settles) into the human-meaningful bits.
// Shared by TaskNotificationBlock (the consumed timeline node) and MessageList's
// queue-chip strip (the mid-turn window where the notice is still queued and the
// CLI records it as a `queue-operation enqueue` whose raw XML would otherwise
// render as an ugly wall of tags). Both surfaces show the same compact summary.

export interface TaskNotificationInfo {
  summary: string;
  outputFile: string;
  failed: boolean;
}

function pick(content: string, tag: string): string | null {
  const m = content.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m?.[1]?.trim() ?? null;
}

export function isTaskNotificationContent(content: string): boolean {
  return content.trimStart().startsWith("<task-notification>");
}

export function parseTaskNotification(content: string): TaskNotificationInfo {
  const status = pick(content, "status") ?? "";
  const summary = pick(content, "summary") ?? "";
  const outputFile = pick(content, "output-file") ?? "";
  // "failed" if the status isn't completed, or the summary reports a non-zero
  // exit code. Drives the red vs neutral styling + icon.
  const failed = /fail|error/i.test(status) || /exit code\s+(?!0\b)\d+/i.test(summary);
  return { summary, outputFile, failed };
}
