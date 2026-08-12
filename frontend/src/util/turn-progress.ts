import type { TimelineNode } from "../parser/group.js";
import { toolSummary } from "../parser/tool-summaries.js";

export interface TurnProgress {
  label: string;
  completedActions: number;
  updates: number;
}

function inlineSummary(value: string, limit = 96): string {
  let text = value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^[\s>*#`~_-]+/, "")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > limit) text = `${text.slice(0, limit).trimEnd()}…`;
  return text;
}

function assistantText(record: Record<string, unknown>): string {
  const content = (record.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return inlineSummary(content);
  if (!Array.isArray(content)) return "";
  const text = content
    .flatMap((block) => {
      if (!block || typeof block !== "object" || Array.isArray(block)) return [];
      const item = block as Record<string, unknown>;
      return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
    })
    .join(" ");
  return inlineSummary(text);
}

/**
 * Summarize only observable work in the active turn. This deliberately does
 * not expose or invent hidden reasoning: it uses assistant progress messages
 * and completed tool calls that are already present in the transcript.
 */
export function currentTurnProgress(timeline: TimelineNode[]): TurnProgress {
  let start = 0;
  for (let i = timeline.length - 1; i >= 0; i--) {
    if (timeline[i]?.block === "UserPromptBlock") {
      start = i + 1;
      break;
    }
  }

  let label = "";
  let completedActions = 0;
  let updates = 0;
  for (let i = start; i < timeline.length; i++) {
    const node = timeline[i];
    if (!node || node.kind !== "event") continue;

    for (const pair of node.toolPairs ?? []) {
      if (pair.result === undefined) continue;
      completedActions++;
      const summary = inlineSummary(toolSummary(pair.use.name, pair.use.input), 72);
      if (summary) label = `✓ Completed · ${summary}`;
    }

    if (node.block === "AssistantBlock") {
      const text = assistantText(node.record);
      if (text) {
        updates++;
        label = `Latest update · ${text}`;
      }
    }
  }

  return { label, completedActions, updates };
}
