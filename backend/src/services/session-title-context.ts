import { open } from "node:fs/promises";
import type { AgentKind } from "@agent-webui/shared";
import { asRecord, asString } from "../types.js";

const NORMAL_REQUEST_COUNT = 4;
const CONTEXTUAL_REQUEST_COUNT = 6;
const INITIAL_TAIL_BYTES = 512 * 1024;
const MAX_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_RECORD_CHARS = 256 * 1024;
const CURRENT_REQUEST_CHARS = 1_200;
const SUPPORTING_REQUEST_CHARS = 520;
const CONTEXT_TEXT_MAX_CHARS = 3_900;
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

export function selectTitleRequests(values: string[]): string[] {
  const unique = uniqueLatest(values);
  const latest = unique.at(-1) ?? "";
  const limit = isContextDependentTitleRequest(latest)
    ? CONTEXTUAL_REQUEST_COUNT
    : NORMAL_REQUEST_COUNT;
  return unique.slice(-limit);
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

export function formatIncrementalTitleContext(values: string[]): string {
  const requests = appendIncrementalTitleRequests([], values);
  if (!requests.length) return "";
  return [
    "Completed user requests since the previous topic summary (oldest to newest):",
    ...requests.map((text, index) => `${index + 1}. ${text}`),
  ].join("\n").slice(0, INCREMENTAL_CONTEXT_MAX_CHARS);
}

/**
 * Put the newest request first so it cannot be truncated behind older context
 * and so recency is structural, not merely implied by chronological order.
 */
export function formatTitleRequestContext(values: string[]): string {
  const requests = selectTitleRequests(values);
  const current = requests.at(-1);
  if (!current) return "";
  const rows = [
    "CURRENT REQUEST (highest priority):",
    current.slice(0, CURRENT_REQUEST_CHARS),
  ];
  const older = requests.slice(0, -1).reverse();
  if (older.length) {
    rows.push(
      "",
      "RECENT CONTEXT (newest first; use only to resolve references or continuing work):",
    );
    older.forEach((text, index) => {
      rows.push(`Context ${index + 1}: ${text.slice(0, SUPPORTING_REQUEST_CHARS)}`);
    });
  }
  return rows.join("\n").slice(0, CONTEXT_TEXT_MAX_CHARS);
}

function parseTailRequests(
  data: Buffer,
  startsMidRecord: boolean,
  agent: AgentKind,
): string[] {
  let text = data.toString("utf8");
  if (startsMidRecord) {
    const firstNewline = text.indexOf("\n");
    if (firstNewline < 0) return [];
    text = text.slice(firstNewline + 1);
  }
  const result: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw || raw.length > MAX_RECORD_CHARS) continue;
    try {
      const record = asRecord(JSON.parse(raw));
      if (!record) continue;
      const request = titleRequestText(record, agent);
      if (request) result.push(request);
    } catch {
      // The last record may still be in flight; malformed bookkeeping records
      // are irrelevant to title context and are isolated here.
    }
  }
  return result;
}

async function tailTitleRequests(
  path: string,
  agent: AgentKind,
  desiredCount: number,
): Promise<string[]> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    let windowBytes = Math.min(info.size, INITIAL_TAIL_BYTES);
    while (windowBytes > 0) {
      const start = Math.max(0, info.size - windowBytes);
      const data = Buffer.allocUnsafe(info.size - start);
      let offset = 0;
      while (offset < data.length) {
        const read = await handle.read(data, offset, data.length - offset, start + offset);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      const requests = parseTailRequests(data.subarray(0, offset), start > 0, agent);
      const selected = selectTitleRequests(requests);
      const latest = selected.at(-1) ?? "";
      const required = isContextDependentTitleRequest(latest)
        ? CONTEXTUAL_REQUEST_COUNT
        : desiredCount;
      if (selected.length >= required || start === 0 || windowBytes >= MAX_TAIL_BYTES) {
        return requests;
      }
      windowBytes = Math.min(info.size, MAX_TAIL_BYTES, windowBytes * 2);
    }
    return [];
  } finally {
    await handle.close();
  }
}

/**
 * Build one bounded, recent-first model context. A hot session with enough
 * observed prompts performs no disk read. After a backend restart (or for a
 * manual re-title), a small reverse tail read fills the missing context without
 * indexing or scanning the complete transcript.
 */
export async function recentSessionTitleContext(
  path: string,
  agent: AgentKind,
  observedRequests: string[] = [],
): Promise<string> {
  const observed = selectTitleRequests(observedRequests);
  const latest = observed.at(-1) ?? "";
  const desired = isContextDependentTitleRequest(latest)
    ? CONTEXTUAL_REQUEST_COUNT
    : NORMAL_REQUEST_COUNT;
  if (observed.length >= desired) return formatTitleRequestContext(observed);
  const transcript = await tailTitleRequests(path, agent, desired);
  return formatTitleRequestContext([...transcript, ...observed]);
}
