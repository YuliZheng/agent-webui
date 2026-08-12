import type { AgentKind } from "@agent-webui/shared";
import { asRecord, asString } from "../types.js";
import { streamJsonlLines } from "./jsonl.js";

const TITLE_REQUEST_COUNT = 16;
const TITLE_REQUEST_CACHE_COUNT = 64;
const MAX_STREAM_REQUEST_CANDIDATES = 2_048;
const TRAILING_REQUEST_COUNT = 4;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_STORED_REQUEST_CHARS = 2_000;
const REQUEST_CONTEXT_CHARS = 280;
const CONTEXT_TEXT_MAX_CHARS = 5_400;
const INCREMENTAL_REQUEST_COUNT = 12;
const INCREMENTAL_REQUEST_CHARS = 250;
const INCREMENTAL_CONTEXT_MAX_CHARS = 3_300;

function normalizeRequestText(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim()
    : "";
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap(item => {
    const block = asRecord(item);
    const type = asString(block?.type);
    const text = asString(block?.text);
    return text && (!type || type === "text" || type === "input_text") ? [text] : [];
  }).join("\n");
}

function codexText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(codexText).filter(Boolean).join("\n");
  const record = asRecord(value);
  if (!record) return "";
  return asString(record.text)
    ?? asString(record.message)
    ?? (record.content === undefined ? "" : codexText(record.content));
}

function isCodexInjectedContext(text: string): boolean {
  const value = text.trimStart();
  return value.startsWith("# AGENTS.md instructions\n\n<INSTRUCTIONS>")
    || value.startsWith("<codex_internal_context")
    || value.startsWith("<permissions instructions>")
    || value.startsWith("<collaboration_mode>")
    || value.startsWith("<skills_instructions>")
    || value.startsWith("<apps_instructions>")
    || value.startsWith("<plugins_instructions>")
    || value.startsWith("<recommended_plugins>")
    || value.startsWith("<rollout_budget>")
    || value.startsWith("<turn_aborted>")
    || value.startsWith("<multi_agent_mode>")
    || value.startsWith("<environment_context>");
}

export function titleRequestText(
  record: Record<string, unknown>,
  agent: AgentKind,
): string {
  if (agent === "claude") {
    if (record.type !== "user" || record.isMeta === true || record.isSidechain === true) return "";
    const message = asRecord(record.message);
    return normalizeRequestText(contentText(message?.content ?? record.content));
  }

  const payload = asRecord(record.payload);
  if (!payload) return "";
  const kind = asString(payload.type) ?? asString(payload.kind);
  const isResponse = record.type === "response_item"
    && kind === "message"
    && payload.role === "user";
  const isEvent = record.type === "event_msg" && kind === "user_message";
  if (!isResponse && !isEvent) return "";
  const text = normalizeRequestText(codexText(
    payload.message ?? payload.text ?? payload.content,
  ));
  return text && !isCodexInjectedContext(text) ? text : "";
}

/**
 * Very short follow-ups usually depend on the immediately preceding requests.
 * These deliberately broad checks only decide whether to include two extra
 * context items; the model still receives an explicit current-request marker.
 */
export function isContextDependentTitleRequest(value: string): boolean {
  const text = normalizeRequestText(value);
  if (!text) return false;
  return /^(?:continue|go ahead|do it|yes|ok(?:ay)?|same|that|this|keep going|proceed)\b/i.test(text)
    || /^(?:继续|接着|可以|行|好|好的|就这样|照着做|你看着做|搞吧|做吧|改吧|这个|那个|上面|刚才|再来一次|按这个|就按这个)/u.test(text);
}

function uniqueLatest(values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = values.length - 1; index >= 0; index--) {
    const text = normalizeRequestText(values[index]);
    if (!text) continue;
    const key = text.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result.reverse();
}

function evenlySampleRequests(values: string[], limit: number): string[] {
  if (values.length <= limit) return values;
  const indexes = new Set<number>();
  for (let slot = 0; slot < limit; slot++) {
    indexes.add(Math.round(slot * (values.length - 1) / (limit - 1)));
  }
  return [...indexes]
    .sort((left, right) => left - right)
    .map(index => values[index]!);
}

export function selectTitleRequests(values: string[]): string[] {
  return evenlySampleRequests(uniqueLatest(values), TITLE_REQUEST_COUNT);
}

/**
 * Maintain a richer in-memory timeline than the 16 requests sent to the model.
 * This lets a hot session absorb later phases without rescanning its transcript
 * on every title refresh, while keeping memory bounded per active session.
 */
export function appendConversationTitleRequests(
  existing: string[],
  incoming: string[],
): string[] {
  return evenlySampleRequests(
    uniqueLatest([...existing, ...incoming]),
    TITLE_REQUEST_CACHE_COUNT,
  );
}

/**
 * Keep one bounded batch of requests completed since the last rolling summary.
 * Default settings retain every request in a five-turn cycle; unusually large
 * intervals retain the first request as an anchor plus the newest requests.
 */
export function appendIncrementalTitleRequests(
  existing: string[],
  incoming: string[],
): string[] {
  const unique = uniqueLatest([...existing, ...incoming])
    .map(text => text.slice(0, INCREMENTAL_REQUEST_CHARS));
  if (unique.length <= INCREMENTAL_REQUEST_COUNT) return unique;
  return [unique[0]!, ...unique.slice(-(INCREMENTAL_REQUEST_COUNT - 1))];
}

export function formatIncrementalTitleContext(
  values: string[],
  maxChars = INCREMENTAL_CONTEXT_MAX_CHARS,
): string {
  const requests = appendIncrementalTitleRequests([], values);
  if (!requests.length) return "";
  const limit = Math.max(600, Math.floor(maxChars));
  const requestChars = Math.max(
    80,
    Math.min(INCREMENTAL_REQUEST_CHARS, Math.floor((limit - 180) / requests.length) - 8),
  );
  return [
    "Completed user requests since the previous topic summary (oldest to newest):",
    ...requests.map((text, index) => `${index + 1}. ${text.slice(0, requestChars)}`),
  ].join("\n").slice(0, limit);
}

export function formatTitleRequestContext(
  values: string[],
  maxChars = CONTEXT_TEXT_MAX_CHARS,
): string {
  const requests = selectTitleRequests(values);
  if (!requests.length) return "";
  const limit = Math.max(800, Math.floor(maxChars));
  const requestChars = Math.max(
    100,
    Math.min(REQUEST_CONTEXT_CHARS, Math.floor((limit - 320) / requests.length) - 8),
  );
  const rows = [
    "CONVERSATION-WIDE USER REQUEST SAMPLE (chronological, beginning to latest):",
    "Infer the session's overall central task from the full timeline. Treat the final entries as recent progress, not automatically as the main topic.",
    "",
  ];
  requests.forEach((text, index) => {
    rows.push(`${index + 1}. ${text.slice(0, requestChars)}`);
  });
  return rows.join("\n").slice(0, limit);
}

interface LocatedTitleRequest {
  text: string;
  ordinal: number;
}

/**
 * Read the complete transcript with bounded per-record memory, while retaining
 * a uniformly compacted request timeline plus the latest requests. Sampling by
 * user-request ordinal, rather than file bytes, prevents one huge assistant or
 * tool record from collapsing every middle landmark onto the same request.
 */
export async function sessionTitleRequests(
  path: string,
  agent: AgentKind,
): Promise<string[]> {
  let candidates: LocatedTitleRequest[] = [];
  const trailing: LocatedTitleRequest[] = [];
  let ordinal = 0;
  let stride = 1;
  let previousRequest = "";

  for await (const line of streamJsonlLines(path, {
    maxRecordBytes: MAX_RECORD_BYTES,
    prefixBytes: 0,
  })) {
    if (!line.raw) continue;
    try {
      const record = asRecord(JSON.parse(line.raw));
      if (!record) continue;
      const request = titleRequestText(record, agent);
      // Codex commonly records the same user input in two adjacent transport
      // envelopes. Keep intentional later repeats out too: they add no topic
      // information and would otherwise crowd out distinct landmarks.
      if (!request || request.toLocaleLowerCase() === previousRequest.toLocaleLowerCase()) continue;
      previousRequest = request;
      const compactText = request.length <= MAX_STORED_REQUEST_CHARS
        ? request
        : `${request.slice(0, 1_500)} … ${request.slice(-400)}`;
      const located = { text: compactText, ordinal: ordinal++ };
      if (located.ordinal % stride === 0) candidates.push(located);
      if (candidates.length > MAX_STREAM_REQUEST_CANDIDATES) {
        stride *= 2;
        candidates = candidates.filter(item => item.ordinal % stride === 0);
      }
      trailing.push(located);
      if (trailing.length > TRAILING_REQUEST_COUNT) trailing.shift();
    } catch {
      // A partially written final record or unrelated malformed bookkeeping
      // record cannot invalidate the rest of the conversation-wide sample.
    }
  }
  const selected = [...candidates, ...trailing]
    .sort((left, right) => left.ordinal - right.ordinal);
  return appendConversationTitleRequests([], selected.map(item => item.text));
}

/**
 * Build a bounded model context that represents the complete conversation.
 * The scan has bounded memory and keeps only a small set of timeline landmarks,
 * so manual re-title and restart recovery do not collapse to the last few turns.
 */
export async function recentSessionTitleContext(
  path: string,
  agent: AgentKind,
  observedRequests: string[] = [],
): Promise<string> {
  const transcript = await sessionTitleRequests(path, agent);
  const observed = selectTitleRequests(observedRequests);
  return formatTitleRequestContext([...transcript, ...observed]);
}
