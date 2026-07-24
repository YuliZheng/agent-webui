import type { AgentKind, IndexedRawLine, NormalizedBlock } from "@/types";
import { normalizeClaudeLine } from "./claude";
import { normalizeCodexLine } from "./codex";

export const TOOL_RUN_MIN = 2;

export function normalizeLines(agent: AgentKind, lines: readonly IndexedRawLine[]): NormalizedBlock[] {
  const raw = lines.flatMap((line) => agent === "claude" ? normalizeClaudeLine(line) : normalizeCodexLine(line));
  return groupBlocks(raw);
}

export function groupBlocks(input: readonly NormalizedBlock[]): NormalizedBlock[] {
  // Usage-only Codex events are transcript metadata. Attach their snapshot to
  // the previous semantic block so context usage remains available without an
  // invisible row interrupting consecutive tool-call runs.
  const semantic: NormalizedBlock[] = [];
  for (const block of input) {
    if (block.meta?.usageOnly) {
      const previous = semantic.at(-1);
      if (previous && block.meta.usage !== undefined) {
        previous.meta = { ...previous.meta, usage: block.meta.usage };
      }
      continue;
    }
    if (!block.text?.trim() && (block.kind === "unknown" || block.kind === "task-notification")) continue;
    semantic.push({ ...block });
  }
  const seen = new Set<string>();
  const uuidDeduped = semantic.filter((block) => {
    const identity = block.uuid ? `${block.uuid}:${block.kind}:${block.toolUseId ?? block.text ?? ""}` : block.key;
    if (seen.has(identity)) return false; seen.add(identity); return true;
  });
  const deduped: NormalizedBlock[] = [];
  for (const block of uuidDeduped) {
    const previous = deduped.at(-1);
    if (block.agent === "codex" && previous?.agent === "codex" && (block.kind === "user" || block.kind === "assistant") && previous.kind === block.kind && block.text?.trim() && block.text.trim() === previous.text?.trim() && block.index - previous.index <= 2) {
      previous.sourceIndexes = [...new Set([...previous.sourceIndexes, ...block.sourceIndexes])];
      continue;
    }
    deduped.push(block);
  }
  const tools = new Map<string, NormalizedBlock>();
  const output: NormalizedBlock[] = [];
  for (const block of deduped) {
    if (block.kind === "tool" && block.toolUseId) tools.set(block.toolUseId, block);
    if (block.kind === "tool-result" && block.toolUseId && tools.has(block.toolUseId)) {
      const tool = tools.get(block.toolUseId)!;
      tool.toolResult = block.toolResult ?? block.text;
      tool.isError = block.isError;
      if (block.meta) tool.meta = { ...tool.meta, ...block.meta };
      tool.sourceIndexes = [...new Set([...tool.sourceIndexes, ...block.sourceIndexes])];
      tool.matched = true;
      continue;
    }
    output.push(block);
  }
  const sidechains = output.filter((block) => block.sidechain);
  const parents = output.filter((block) => block.kind === "tool" && /^(Task|Agent)$/i.test(block.toolName ?? ""));
  const attached = new Set<string>();
  for (const child of sidechains) {
    const parent = parents.find((candidate) => {
      if (child.agentId && (candidate.toolUseId === child.agentId || containsValue(candidate.toolInput, child.agentId) || containsValue(candidate.toolResult, child.agentId))) return true;
      return !!child.parentUuid && (candidate.uuid === child.parentUuid || candidate.toolUseId === child.parentUuid);
    });
    if (!parent) continue;
    (parent.children ??= []).push(child); attached.add(child.key);
  }
  const visible = output.filter((block) => !attached.has(block.key));
  // Consecutive, fully-settled, plain tool entries become one collapsible run.
  // Unmatched calls and rich results must stay visible at their original fold.
  const grouped: NormalizedBlock[] = [];
  for (let i = 0; i < visible.length;) {
    if (!isCollapsibleTool(visible[i])) { grouped.push(visible[i]!); i++; continue; }
    let end = i + 1;
    while (end < visible.length && isCollapsibleTool(visible[end])) end++;
    const run = visible.slice(i, end);
    if (run.length >= TOOL_RUN_MIN) grouped.push({
      key: `tool-run-${run[0]!.key}`, index: run[0]!.index, sourceIndexes: run.flatMap((item) => item.sourceIndexes),
      agent: run[0]!.agent, kind: "tool-run", children: run
    });
    else grouped.push(run[0]!);
    i = end;
  }
  return grouped;
}

function isCollapsibleTool(block: NormalizedBlock | undefined): block is NormalizedBlock {
  if (!block || block.kind !== "tool" || block.toolResult === undefined || block.matched !== true) return false;
  if (/^(AskUserQuestion|Agent)$/i.test(block.toolName ?? "")) return false;
  if (block.children?.length) return false;
  const result = block.toolResult;
  if (!result || typeof result !== "object") return true;
  const record = result as Record<string, unknown>;
  return !record.preview && !record.previewUrl && !record.image && !record.imageUrl &&
    !record.workflow && !record.subagentTimeline;
}

function containsValue(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value === needle || value.includes(needle);
  if (Array.isArray(value)) return value.some((item) => containsValue(item, needle));
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).some((item) => containsValue(item, needle));
  return false;
}

export interface TodoItem { id: string; subject: string; status: string }
export function contextUsagePercent(blocks: readonly NormalizedBlock[]): number | null {
  const latest = latestUsageMetadata(blocks);
  if (!latest.found) return null;
  return usagePercent(latest.value);
}

function latestUsageMetadata(blocks: readonly NormalizedBlock[]): { found: boolean; value?: unknown } {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.children?.length) {
      const nested = latestUsageMetadata(block.children);
      if (nested.found) return nested;
    }
    if (block.meta && Object.prototype.hasOwnProperty.call(block.meta, "usage")) {
      return { found: true, value: block.meta.usage };
    }
  }
  return { found: false };
}

function usagePercent(value: unknown): number | null {
  if (!isUsageRecord(value)) return null;

  const current = namedUsage(value, ["current_token_usage", "currentTokenUsage"]);
  const last = namedUsage(value, ["last_token_usage", "lastTokenUsage"]);
  const selected = current.present ? current.value : last.present ? last.value : directUsage(value);
  if (!selected || !isUsageRecord(selected)) return null;

  const contextWindow = contextWindowOf(value, selected);
  const usedTokens = usedTokensOf(selected);
  if (contextWindow === null || usedTokens === null || usedTokens > contextWindow) return null;

  // Flooring keeps a genuinely sub-limit snapshot from being displayed as 100%.
  return Math.floor(usedTokens / contextWindow * 100);
}

function namedUsage(
  root: Record<string, unknown>,
  keys: readonly string[],
): { present: boolean; value?: unknown } {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(root, key)) return { present: true, value: root[key] };
  }
  return { present: false };
}

function directUsage(root: Record<string, unknown>): Record<string, unknown> | null {
  // Codex's total_token_usage is cumulative across the session, not the current
  // model context. It must never be compared with a single context window.
  if (Object.prototype.hasOwnProperty.call(root, "total_token_usage") ||
      Object.prototype.hasOwnProperty.call(root, "totalTokenUsage")) return null;
  return root;
}

function contextWindowOf(
  root: Record<string, unknown>,
  usage: Record<string, unknown>,
): number | null {
  const keys = ["model_context_window", "context_window", "modelContextWindow", "contextWindow"];
  const values: number[] = [];
  for (const record of usage === root ? [root] : [usage, root]) {
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      const parsed = tokenInteger(record[key], false);
      if (parsed === null) return null;
      values.push(parsed);
    }
  }
  if (!values.length || values.some((item) => item !== values[0])) return null;
  return values[0]!;
}

function usedTokensOf(usage: Record<string, unknown>): number | null {
  if (Object.prototype.hasOwnProperty.call(usage, "total_tokens")) {
    return tokenInteger(usage.total_tokens, true);
  }
  if (Object.prototype.hasOwnProperty.call(usage, "totalTokens")) {
    return tokenInteger(usage.totalTokens, true);
  }

  const keys = [
    "input_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ];
  const present = keys.filter((key) => Object.prototype.hasOwnProperty.call(usage, key));
  if (!present.length) return null;
  let total = 0;
  for (const key of present) {
    const value = tokenInteger(usage[key], true);
    if (value === null || !Number.isSafeInteger(total + value)) return null;
    total += value;
  }
  return total;
}

function tokenInteger(value: unknown, allowZero: boolean): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  return value > 0 || (allowZero && value === 0) ? value : null;
}

function isUsageRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function reconstructTodos(blocks: readonly NormalizedBlock[]): TodoItem[] {
  const todos = new Map<string, TodoItem>();
  for (const block of blocks.flatMap((item) => item.children ?? [item])) {
    if (block.kind !== "tool" || (block.toolName !== "TaskCreate" && block.toolName !== "TaskUpdate")) continue;
    const input = block.toolInput as Record<string, unknown> | undefined;
    const result = block.toolResult && typeof block.toolResult === "object" ? block.toolResult as Record<string, unknown> : undefined;
    const id = String(input?.taskId ?? input?.id ?? result?.taskId ?? result?.id ?? block.toolUseId ?? "");
    if (!id) continue;
    const prior = todos.get(id) ?? { id, subject: String(input?.subject ?? "Task"), status: "pending" };
    todos.set(id, { ...prior, subject: String(input?.subject ?? prior.subject), status: String(input?.status ?? prior.status) });
  }
  return [...todos.values()];
}
