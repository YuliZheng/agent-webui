export type CodexContextContributorSource =
  | "user"
  | "assistant"
  | "agents"
  | "skills"
  | "instructions"
  | "base"
  | "compaction"
  | "images"
  | "shell"
  | "browser"
  | "patches"
  | "tools"
  | "reasoning"
  | "messages"
  | "other";

export interface CodexContextContributor {
  source: CodexContextContributorSource;
  label: string;
  tokens: number;
  percent: number;
}

export interface CodexContextUsageSummary {
  tokens: number;
  limit: number | null;
  compactionCount: number;
  /** Provider-reported token total accumulated across the entire thread. */
  cumulativeTokens?: number;
  reportedTokens?: number;
  contributors?: readonly CodexContextContributor[];
  /**
   * Estimated source attribution for the provider-reported cumulative total.
   * Unlike `contributors`, this survives context compaction.
   */
  cumulativeContributors?: readonly CodexContextContributor[];
}

const CONTRIBUTOR_LABELS: Record<CodexContextContributorSource, string> = {
  user: "your messages",
  assistant: "assistant replies",
  agents: "AGENTS.md",
  skills: "skills",
  instructions: "system / context",
  base: "Codex base context",
  compaction: "compaction summary",
  images: "images",
  shell: "shell",
  browser: "browser",
  patches: "patches",
  tools: "other tools",
  reasoning: "reasoning",
  messages: "other messages",
  other: "unattributed context",
};

const CODEX_EFFECTIVE_CONTEXT_PERCENT = 95;
const CODEX_DEFAULT_AUTO_COMPACT_PERCENT = 90;
const IMAGE_CONTEXT_TOKEN_ESTIMATE = 1_844;
const MESSAGE_ENVELOPE_TOKEN_ESTIMATE = 4;
const TOOL_OUTPUT_CONTEXT_TOKEN_LIMIT = 2_000;

type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function parsedRecord(raw: string): JsonRecord | null {
  try {
    return recordValue(JSON.parse(raw));
  } catch {
    return null;
  }
}

function utf8Length(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return 0;
  }
}

function estimatedReasoningTokens(encodedLength: number): number {
  const visibleBytes = Math.max(Math.floor((encodedLength * 3) / 4) - 650, 0);
  return Math.ceil(visibleBytes / 4);
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(messageText).filter(Boolean).join("\n");
  const record = recordValue(value);
  if (!record) return "";
  if (typeof record.text === "string") return record.text;
  if (typeof record.message === "string") return record.message;
  return record.content === undefined ? "" : messageText(record.content);
}

interface ContributorRange {
  source: "agents" | "skills";
  start: number;
  end: number;
}

function taggedRanges(
  text: string,
  source: ContributorRange["source"],
  opening: string,
  closing: string,
): ContributorRange[] {
  const ranges: ContributorRange[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(opening, cursor);
    if (start < 0) break;
    const close = text.indexOf(closing, start + opening.length);
    const end = close < 0 ? text.length : close + closing.length;
    ranges.push({ source, start, end });
    cursor = Math.max(end, start + opening.length);
  }
  return ranges;
}

function agentsInstructionRanges(text: string): ContributorRange[] {
  const ranges: ContributorRange[] = [];
  const header = /# AGENTS\.md instructions(?: for [^\r\n]+)?/gi;
  for (const match of text.matchAll(header)) {
    const start = match.index ?? 0;
    const close = text.indexOf("</INSTRUCTIONS>", start + match[0].length);
    const end = close < 0 ? text.length : close + "</INSTRUCTIONS>".length;
    ranges.push({ source: "agents", start, end });
  }
  return ranges;
}

function instructionLikeText(text: string): boolean {
  const value = text.trimStart();
  return value.startsWith("<codex_internal_context")
    || value.startsWith("<permissions instructions>")
    || value.startsWith("<collaboration_mode>")
    || value.startsWith("<multi_agent_mode>")
    || value.startsWith("<apps_instructions>")
    || value.startsWith("<plugins_instructions>")
    || value.startsWith("<environment_context>")
    || value.startsWith("<rollout_budget>");
}

function roleSource(role: unknown, text: string): CodexContextContributorSource {
  if (instructionLikeText(text)) return "instructions";
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  if (role === "developer" || role === "system") return "instructions";
  return "messages";
}

function addTokens(
  totals: Map<CodexContextContributorSource, number>,
  source: CodexContextContributorSource,
  tokens: number,
): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  totals.set(source, (totals.get(source) ?? 0) + Math.ceil(tokens));
}

function addMessage(
  totals: Map<CodexContextContributorSource, number>,
  payload: JsonRecord,
): void {
  const text = messageText(payload.content);
  const baseSource = roleSource(payload.role, text);
  const textBytes = new TextEncoder().encode(text).length;
  const content = Array.isArray(payload.content) ? payload.content : [];
  const imageCount = content.reduce((count, value) => {
    const block = recordValue(value);
    const type = typeof block?.type === "string" ? block.type : "";
    return count + (
      /image/i.test(type)
      || typeof block?.image_url === "string"
      || typeof block?.imageUrl === "string"
        ? 1
        : 0
    );
  }, 0);
  addTokens(totals, "images", imageCount * IMAGE_CONTEXT_TOKEN_ESTIMATE);

  const tokens = Math.ceil(textBytes / 4) + MESSAGE_ENVELOPE_TOKEN_ESTIMATE;
  if (!textBytes) {
    addTokens(totals, baseSource, tokens);
    return;
  }

  const candidates = [
    ...agentsInstructionRanges(text),
    ...taggedRanges(text, "skills", "<skills_instructions>", "</skills_instructions>"),
  ].sort((a, b) => a.start - b.start || b.end - a.end);
  const ranges: ContributorRange[] = [];
  for (const candidate of candidates) {
    if (ranges.some((range) => candidate.start < range.end && candidate.end > range.start)) continue;
    ranges.push(candidate);
  }

  let assigned = 0;
  for (const range of ranges) {
    const sectionBytes = new TextEncoder().encode(text.slice(range.start, range.end)).length;
    const sectionTokens = Math.min(tokens - assigned, Math.round((tokens * sectionBytes) / textBytes));
    addTokens(totals, range.source, sectionTokens);
    assigned += sectionTokens;
  }
  addTokens(totals, baseSource, Math.max(0, tokens - assigned));
}

function contributorForTool(name: string, payload?: JsonRecord | null): CodexContextContributorSource {
  const normalized = name.toLowerCase();
  const input = typeof payload?.input === "string"
    ? payload.input.toLowerCase()
    : typeof payload?.arguments === "string"
      ? payload.arguments.toLowerCase()
      : "";
  if (/image[_-]?(gen|generation)|imagegen/.test(normalized)
    || /image[_-]?(gen|generation)|imagegen/.test(input)) return "images";
  if (normalized === "exec") {
    if (/apply_patch|patch/.test(input)) return "patches";
    if (/browser|chrome|node_repl|playwright|computer/.test(input)) return "browser";
    if (/shell_command|exec_command|powershell/.test(input)) return "shell";
  }
  if (/apply_patch|patch/.test(normalized)) return "patches";
  if (/browser|chrome|node_repl|playwright|computer|(^|_)js$/.test(normalized)) return "browser";
  if (/shell|exec_command|shell_command|powershell/.test(normalized)) return "shell";
  return "tools";
}

function compactLimit(modelWindow: number | null, configuredLimit: number | null): number | null {
  const defaultLimit = modelWindow && modelWindow > 0
    ? Math.floor((modelWindow * CODEX_DEFAULT_AUTO_COMPACT_PERCENT) / CODEX_EFFECTIVE_CONTEXT_PERCENT)
    : null;
  const cap = configuredLimit && Number.isFinite(configuredLimit) && configuredLimit > 0
    ? Math.floor(configuredLimit)
    : null;
  if (defaultLimit === null) return cap;
  return cap === null ? defaultLimit : Math.min(defaultLimit, cap);
}

function reconcile(
  rawTotals: ReadonlyMap<CodexContextContributorSource, number>,
  authoritativeTotal: number,
): readonly CodexContextContributor[] {
  const target = Number.isFinite(authoritativeTotal)
    ? Math.max(0, Math.floor(authoritativeTotal))
    : 0;
  if (!target) return [];

  const totals = new Map(rawTotals);
  const rawTotal = [...totals.values()].reduce((sum, tokens) => sum + tokens, 0);
  if (rawTotal < target) {
    totals.set("other", (totals.get("other") ?? 0) + target - rawTotal);
  } else if (rawTotal > target) {
    const scaled = [...totals.entries()].map(([source, tokens], index) => {
      const exact = (tokens * target) / rawTotal;
      const floor = Math.floor(exact);
      return { source, tokens: floor, remainder: exact - floor, index };
    });
    let remaining = target - scaled.reduce((sum, item) => sum + item.tokens, 0);
    for (const item of [...scaled].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
      if (remaining <= 0) break;
      item.tokens++;
      remaining--;
    }
    totals.clear();
    for (const item of scaled) {
      if (item.tokens > 0) totals.set(item.source, item.tokens);
    }
  }

  const reconciled = [...totals.entries()]
    .filter(([, tokens]) => tokens > 0)
    .map(([source, tokens], index) => {
      const exactPercent = (tokens / target) * 100;
      return {
        source,
        tokens,
        percent: Math.floor(exactPercent),
        remainder: exactPercent - Math.floor(exactPercent),
        index,
      };
    });
  let remaining = 100 - reconciled.reduce((sum, item) => sum + item.percent, 0);
  for (const item of [...reconciled].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (remaining <= 0) break;
    item.percent++;
    remaining--;
  }
  return reconciled
    .map(({ source, tokens, percent }) => ({
      source,
      label: CONTRIBUTOR_LABELS[source],
      tokens,
      percent,
    }))
    .sort((a, b) => b.tokens - a.tokens);
}

function allocateProportionally(
  rawTotals: ReadonlyMap<CodexContextContributorSource, number>,
  authoritativeTotal: number,
): ReadonlyMap<CodexContextContributorSource, number> {
  const target = Number.isFinite(authoritativeTotal)
    ? Math.max(0, Math.floor(authoritativeTotal))
    : 0;
  if (!target) return new Map();

  const entries = [...rawTotals.entries()].filter(([, tokens]) => Number.isFinite(tokens) && tokens > 0);
  const rawTotal = entries.reduce((sum, [, tokens]) => sum + tokens, 0);
  if (!rawTotal) return new Map([["other", target]]);

  const scaled = entries.map(([source, tokens], index) => {
    const exact = (tokens * target) / rawTotal;
    const floor = Math.floor(exact);
    return { source, tokens: floor, remainder: exact - floor, index };
  });
  let remaining = target - scaled.reduce((sum, item) => sum + item.tokens, 0);
  for (const item of [...scaled].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (remaining <= 0) break;
    item.tokens++;
    remaining--;
  }
  return new Map(scaled.filter((item) => item.tokens > 0).map((item) => [item.source, item.tokens]));
}

function jsonStringFields(prefix: string, key: string): string[] {
  const values: string[] = [];
  const pattern = new RegExp(`"${key}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`, "g");
  for (const match of prefix.matchAll(pattern)) {
    try {
      const value: unknown = JSON.parse(match[1] ?? "\"\"");
      if (typeof value === "string") values.push(value);
    } catch {
      // Ignore a prefix that ends midway through a quoted string.
    }
  }
  return values;
}

function jsonStringField(prefix: string, key: string): string {
  return jsonStringFields(prefix, key)[0] ?? "";
}

export class CodexContextUsageAccumulator {
  private readonly totals = new Map<CodexContextContributorSource, number>();
  private readonly cumulativeTotals = new Map<CodexContextContributorSource, number>();
  private readonly tools = new Map<string, { name: string; source: CodexContextContributorSource }>();
  private latest: CodexContextUsageSummary = { tokens: 0, limit: null, compactionCount: 0 };
  private latestWindow: number | null = null;
  private compactionCount = 0;
  private detailedCompactionAtMs: number | null = null;
  private cumulativeTokens: number | null = null;
  private lastAttributedCumulativeTokens: number | null = null;
  // Codex includes a stable hidden floor (base prompt + tool schemas) in every
  // authoritative token_count, but does not persist those bytes as rollout
  // rows. Calibrate that floor from the first complete pre-compaction usage
  // sample. Later byte/token estimation noise must not erode a stable hidden
  // floor into a misleading near-zero value.
  private baseContextTokens: number | null = null;

  constructor(private readonly configuredAutoCompactLimit: number | null = null) {}

  pushRawLine(raw: string): void {
    const record = parsedRecord(raw);
    if (!record) return;
    if (this.isCompaction(record)) {
      const timestamp = typeof record.timestamp === "string"
        ? Date.parse(record.timestamp)
        : Number.NaN;
      const detailed = record.type === "compacted";
      if (
        !detailed
        && this.detailedCompactionAtMs !== null
        && Number.isFinite(timestamp)
        && timestamp >= this.detailedCompactionAtMs
        && timestamp - this.detailedCompactionAtMs <= 5_000
      ) {
        this.detailedCompactionAtMs = null;
        return;
      }
      this.detailedCompactionAtMs = detailed && Number.isFinite(timestamp)
        ? timestamp
        : null;
      this.compactionCount++;
      this.resetSegment();
      this.addCompactionContext(record);
      this.latest = {
        tokens: 0,
        limit: compactLimit(this.latestWindow, this.configuredAutoCompactLimit),
        compactionCount: this.compactionCount,
        ...(this.cumulativeTokens !== null ? { cumulativeTokens: this.cumulativeTokens } : {}),
        ...this.cumulativeContributorSummary(),
      };
      return;
    }
    if (record.type === "response_item") {
      const payload = recordValue(record.payload);
      if (payload) this.addPayload(payload);
      return;
    }
    this.captureUsage(record);
  }

  pushOversizedPrefix(prefix: string): void {
    if (!prefix) return;
    const types = jsonStringFields(prefix, "type");
    const type = types[0] === "response_item"
      ? types[1] ?? ""
      : types[0] ?? "";
    if (type === "image_generation_call") {
      addTokens(this.totals, "images", IMAGE_CONTEXT_TOKEN_ESTIMATE);
      return;
    }
    if (type === "message") {
      const role = jsonStringField(prefix, "role");
      const texts = jsonStringFields(prefix, "text");
      const text = texts.join("\n");
      const source = roleSource(role, text);
      addTokens(
        this.totals,
        source,
        Math.ceil(new TextEncoder().encode(text).length / 4) + MESSAGE_ENVELOPE_TOKEN_ESTIMATE,
      );
      if (prefix.includes("input_image") || /data:image/i.test(prefix)) {
        addTokens(this.totals, "images", IMAGE_CONTEXT_TOKEN_ESTIMATE);
      }
      return;
    }
    if (/output|result/i.test(type) || type.includes("tool")) {
      const callId = jsonStringField(prefix, "call_id") || jsonStringField(prefix, "id");
      const call = callId ? this.tools.get(callId) : undefined;
      const name = jsonStringField(prefix, "name") || call?.name || "";
      addTokens(this.totals, call?.source ?? contributorForTool(name), TOOL_OUTPUT_CONTEXT_TOKEN_LIMIT);
    }
  }

  result(): CodexContextUsageSummary {
    return this.latest;
  }

  private isCompaction(record: JsonRecord): boolean {
    if (record.type === "compacted" || record.type === "context_compacted") return true;
    const payload = recordValue(record.payload);
    return record.type === "event_msg" && payload?.type === "context_compacted";
  }

  private resetSegment(): void {
    this.totals.clear();
    this.tools.clear();
  }

  private cumulativeContributorSummary(): Pick<CodexContextUsageSummary, "cumulativeContributors"> {
    if (this.cumulativeTokens === null || this.cumulativeTokens <= 0) return {};
    const cumulativeContributors = reconcile(this.cumulativeTotals, this.cumulativeTokens);
    return cumulativeContributors.length ? { cumulativeContributors } : {};
  }

  private addCompactionContext(record: JsonRecord): void {
    const payload = recordValue(record.payload);
    if (!payload) return;
    const replacementHistory = Array.isArray(payload.replacement_history)
      ? payload.replacement_history
      : Array.isArray(payload.replacementHistory)
        ? payload.replacementHistory
        : [];
    let hasEncryptedSummary = false;
    for (const value of replacementHistory) {
      const item = recordValue(value);
      if (!item) continue;
      const replacement = item.type === "response_item"
        ? recordValue(item.payload)
        : item;
      if (!replacement) continue;
      if (replacement.type === "compaction") {
        const encoded = typeof replacement.encrypted_content === "string"
          ? replacement.encrypted_content
          : typeof replacement.encryptedContent === "string"
            ? replacement.encryptedContent
            : "";
        if (encoded) {
          hasEncryptedSummary = true;
          addTokens(this.totals, "compaction", estimatedReasoningTokens(encoded.length));
        }
        continue;
      }
      this.addPayload(replacement);
    }

    // Newer Codex versions persist a readable summary beside the replacement
    // history instead of an encrypted `type: "compaction"` item. Count exactly
    // one representation when both forms are ever present.
    const summary = typeof payload.message === "string"
      ? payload.message
      : typeof payload.summary === "string"
        ? payload.summary
        : "";
    if (!hasEncryptedSummary && summary) {
      addTokens(
        this.totals,
        "compaction",
        Math.ceil(new TextEncoder().encode(summary).length / 4) + MESSAGE_ENVELOPE_TOKEN_ESTIMATE,
      );
    }
  }

  private addPayload(payload: JsonRecord): void {
    const type = typeof payload.type === "string" ? payload.type : "";
    if (!type) return;
    if (type === "message" || type === "agent_message") {
      addMessage(this.totals, payload);
      return;
    }

    let source: CodexContextContributorSource = "other";
    let tokens = Math.ceil(utf8Length(payload) / 4);
    if (type === "reasoning" || type === "compaction") {
      source = type === "compaction" ? "compaction" : "reasoning";
      const encoded = typeof payload.encrypted_content === "string"
        ? payload.encrypted_content
        : typeof payload.encryptedContent === "string"
          ? payload.encryptedContent
          : "";
      if (encoded) tokens = estimatedReasoningTokens(encoded.length);
    } else if (type === "image_generation_call") {
      source = "images";
      tokens = Math.min(tokens, IMAGE_CONTEXT_TOKEN_ESTIMATE);
    } else if (type.includes("call") || type.includes("tool")) {
      const callIdValue = payload.call_id ?? payload.id;
      const callId = typeof callIdValue === "string" ? callIdValue : "";
      const previous = callId ? this.tools.get(callId) : undefined;
      const name = typeof payload.name === "string" ? payload.name : previous?.name ?? "";
      source = previous?.source ?? contributorForTool(name, payload);
      if (callId && typeof payload.name === "string" && !/output|result/i.test(type)) {
        this.tools.set(callId, { name, source });
      }
      if (/output|result/i.test(type)) {
        tokens = Math.min(tokens, TOOL_OUTPUT_CONTEXT_TOKEN_LIMIT);
      }
    }
    addTokens(this.totals, source, tokens);
  }

  private captureUsage(record: JsonRecord): void {
    let reported = Number.NaN;
    let failureTotal = Number.NaN;
    let cumulative = Number.NaN;
    let window = Number.NaN;
    if (record.type === "event_msg") {
      const payload = recordValue(record.payload);
      if (payload?.type !== "token_count") return;
      const info = recordValue(payload.info);
      const usage = recordValue(info?.last_token_usage);
      const totalUsage = recordValue(info?.total_token_usage);
      reported = Number(usage?.total_tokens ?? (
        Number(usage?.input_tokens ?? 0) + Number(usage?.output_tokens ?? 0)
      ));
      failureTotal = Number(totalUsage?.total_tokens);
      cumulative = failureTotal;
      window = Number(info?.model_context_window ?? 0);
    } else if (record.method === "thread/tokenUsage/updated") {
      const params = recordValue(record.params);
      const tokenUsage = recordValue(params?.tokenUsage);
      const usage = recordValue(tokenUsage?.last);
      const totalUsage = recordValue(tokenUsage?.total);
      reported = Number(usage?.totalTokens ?? (
        Number(usage?.inputTokens ?? 0) + Number(usage?.outputTokens ?? 0)
      ));
      cumulative = Number(totalUsage?.totalTokens ?? totalUsage?.total_tokens);
      window = Number(tokenUsage?.modelContextWindow ?? 0);
    } else {
      return;
    }

    let tokens = Number.isFinite(reported) ? Math.max(0, reported) : 0;
    // A request rejected at the hard context boundary is recorded by Codex
    // with an empty `last_token_usage` and a non-cumulative sentinel in
    // `total_token_usage.total_tokens`. Preserve the authoritative full-window
    // value instead of making a failed, full thread appear empty.
    const isFailureSentinel = (
      tokens === 0
      && Number.isFinite(window)
      && window > 0
      && failureTotal === window
    );
    if (isFailureSentinel) {
      tokens = window;
    }
    if (Number.isFinite(window) && window > 0) this.latestWindow = window;
    const attributionTotals = new Map(this.totals);
    const visibleTotal = [...attributionTotals.values()].reduce((sum, value) => sum + value, 0);
    const residual = Math.max(0, tokens - visibleTotal);
    if (this.compactionCount === 0 && residual > 0 && this.baseContextTokens === null) {
      this.baseContextTokens = residual;
    }
    const baseTokens = Math.min(this.baseContextTokens ?? 0, residual);
    if (baseTokens > 0) attributionTotals.set("base", baseTokens);
    const contributors = reconcile(attributionTotals, tokens);
    if (Number.isFinite(cumulative) && cumulative >= 0 && !isFailureSentinel) {
      const previous = this.lastAttributedCumulativeTokens;
      if (previous === null || cumulative >= previous) {
        const delta = previous === null ? cumulative : cumulative - previous;
        if (delta > 0) {
          const currentTotals = new Map(contributors.map((item) => [item.source, item.tokens]));
          for (const [source, allocated] of allocateProportionally(currentTotals, delta)) {
            addTokens(this.cumulativeTotals, source, allocated);
          }
        }
        this.lastAttributedCumulativeTokens = cumulative;
        this.cumulativeTokens = this.cumulativeTokens === null
          ? cumulative
          : Math.max(this.cumulativeTokens, cumulative);
      }
    }
    this.latest = {
      tokens,
      limit: compactLimit(this.latestWindow, this.configuredAutoCompactLimit),
      compactionCount: this.compactionCount,
      ...(this.cumulativeTokens !== null ? { cumulativeTokens: this.cumulativeTokens } : {}),
      reportedTokens: tokens,
      ...(contributors.length ? { contributors } : {}),
      ...this.cumulativeContributorSummary(),
    };
  }
}

export function summarizeCodexContextUsage(
  lines: readonly string[],
  configuredAutoCompactLimit: number | null = null,
): CodexContextUsageSummary {
  const accumulator = new CodexContextUsageAccumulator(configuredAutoCompactLimit);
  for (const raw of lines) {
    if (raw) accumulator.pushRawLine(raw);
  }
  return accumulator.result();
}
