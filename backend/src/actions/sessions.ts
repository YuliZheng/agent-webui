import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, open, readFile, truncate, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { asRecord, asString, assertSessionId, RpcError, type UserMessageInfo } from "../types.js";
import { scanClaudeFile, type SessionIndex } from "../services/session-index.js";
import type { ClaudeDriver } from "../services/claude-driver.js";
import type { CodexDriver, CodexThreadTurn } from "../services/codex-driver.js";
import type { AppState } from "../services/state.js";
import { snapshotJsonl } from "../services/jsonl.js";

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap(item => {
    const obj = asRecord(item);
    return obj?.type === "text" && typeof obj.text === "string" ? [obj.text] : [];
  }).join("\n");
}

function codexText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(codexText).filter(Boolean).join("\n");
  const record = asRecord(value);
  if (!record) return "";
  if (typeof record.text === "string") return record.text;
  if (typeof record.message === "string") return record.message;
  return record.content === undefined ? "" : codexText(record.content);
}

function isCodexInjectedContext(text: string): boolean {
  const value = text.trimStart();
  return value.startsWith("# AGENTS.md instructions\n\n<INSTRUCTIONS>") ||
    value.startsWith("<codex_internal_context") ||
    value.startsWith("<permissions instructions>") ||
    value.startsWith("<collaboration_mode>") ||
    value.startsWith("<skills_instructions>") ||
    value.startsWith("<apps_instructions>") ||
    value.startsWith("<plugins_instructions>") ||
    value.startsWith("<environment_context>");
}

interface CodexUserMessagePoint extends UserMessageInfo {
  sourceIndexes: number[];
  aliases: Set<string>;
  sourceKinds: Set<"response" | "event">;
  turnId: string | null;
  turnIndex: number | null;
}

interface CodexRolloutHistory {
  messages: CodexUserMessagePoint[];
  turnIds: string[];
}

function codexUserMessage(
  record: Record<string, unknown>,
  lineIndex: number,
): { text: string; aliases: string[]; sourceKind: "response" | "event" } | null {
  const payload = asRecord(record.payload);
  if (!payload) return null;
  let text = "";
  let sourceKind: "response" | "event";
  if (record.type === "response_item" && payload.type === "message" && payload.role === "user") {
    text = codexText(payload.content);
    sourceKind = "response";
  } else if (record.type === "event_msg" && (payload.type === "user_message" || payload.kind === "user_message")) {
    text = codexText(payload.message ?? payload.text ?? payload.content);
    sourceKind = "event";
  } else {
    return null;
  }
  text = text.trim();
  if (!text || isCodexInjectedContext(text)) return null;
  const lineId = `line-${lineIndex}`;
  const payloadId = asString(payload.id);
  return { text, aliases: payloadId ? [lineId, payloadId] : [lineId], sourceKind };
}

function withoutCodexImageEnvelope(text: string): string {
  return text.replace(/<image\b[^>]*>\s*<\/image>\s*/giu, "").trim();
}

function sameCodexUserMessage(left: string, right: string): boolean {
  const a = normalizePromptText(left);
  const b = normalizePromptText(right);
  return a === b || withoutCodexImageEnvelope(a) === withoutCodexImageEnvelope(b);
}

async function codexRolloutHistory(path: string): Promise<CodexRolloutHistory> {
  const result: CodexUserMessagePoint[] = [];
  const turnIds: string[] = [];
  const turnIndexes = new Map<string, number>();
  let currentTurnId: string | null = null;
  let lineIndex = 0;
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const raw of lines) {
    try {
      const record = asRecord(JSON.parse(raw));
      if (!record) continue;
      if (record.type === "turn_context") {
        const payload = asRecord(record.payload);
        const turnId = asString(payload?.turn_id) ?? asString(payload?.turnId);
        if (turnId) {
          currentTurnId = turnId;
          if (!turnIndexes.has(turnId)) {
            turnIndexes.set(turnId, turnIds.length);
            turnIds.push(turnId);
          }
        }
        continue;
      }
      const message = codexUserMessage(record, lineIndex);
      if (!message) continue;
      const previous = result.at(-1);
      const isCompanionRecord = previous &&
        previous.turnId === currentTurnId &&
        lineIndex - previous.sourceIndexes.at(-1)! <= 2 &&
        !previous.sourceKinds.has(message.sourceKind) &&
        sameCodexUserMessage(previous.text, message.text);
      if (isCompanionRecord) {
        previous.sourceIndexes.push(lineIndex);
        for (const alias of message.aliases) previous.aliases.add(alias);
        previous.sourceKinds.add(message.sourceKind);
        // event_msg is the clean user-visible form. response_item may prepend
        // a local <image path=...> transport envelope.
        if (message.sourceKind === "event") previous.text = message.text;
        continue;
      }
      result.push({
        uuid: `line-${lineIndex}`,
        parentUuid: null,
        type: "user",
        text: message.text,
        sourceIndexes: [lineIndex],
        aliases: new Set(message.aliases),
        sourceKinds: new Set([message.sourceKind]),
        turnId: currentTurnId,
        turnIndex: currentTurnId === null ? null : (turnIndexes.get(currentTurnId) ?? null),
      });
    } catch { /* isolate malformed record */ }
    finally { lineIndex++; }
  }
  return { messages: result, turnIds };
}

async function codexUserMessages(path: string): Promise<CodexUserMessagePoint[]> {
  return (await codexRolloutHistory(path)).messages;
}

export async function getUserMessages(index: SessionIndex, sessionId: string): Promise<UserMessageInfo[]> {
  assertSessionId(sessionId); const session = await index.resolve(sessionId);
  if (!session) throw new RpcError(404, "Session not found");
  if (session.agent === "codex") {
    return (await codexUserMessages(session.path)).map(({
      sourceIndexes: _sourceIndexes,
      aliases: _aliases,
      sourceKinds: _sourceKinds,
      turnId: _turnId,
      turnIndex: _turnIndex,
      ...message
    }) => message);
  }
  const snapshot = await snapshotJsonl(session.path);
  const result: UserMessageInfo[] = [];
  for (const line of snapshot.lines) {
    try {
      const record = asRecord(JSON.parse(line.raw)); if (!record) continue;
      if (session.agent === "claude" && record.type === "user" && record.isMeta !== true) {
        const message = asRecord(record.message); const text = contentText(message?.content ?? record.content).trim();
        const uuid = asString(record.uuid); if (uuid && text) result.push({ uuid, parentUuid: asString(record.parentUuid) ?? null, type: "user", text });
      }
    } catch { /* isolate malformed record */ }
  }
  return result;
}

async function rewindPoint(path: string, messageUuid: string): Promise<{ byte: number; removed: number; total: number; prefillText: string }> {
  const data = await readFile(path);
  let offset = 0; let index = 0;
  for (const raw of data.toString("utf8").split(/(?<=\n)/)) {
    const line = raw.replace(/\r?\n$/, "");
    try {
      const record = asRecord(JSON.parse(line));
      if (record?.type === "user" && record.uuid === messageUuid) {
        const message = asRecord(record.message); const text = contentText(message?.content ?? record.content);
        const total = (await snapshotJsonl(path)).lines.length;
        return { byte: offset, removed: total - index, total, prefillText: text };
      }
    } catch { /* continue */ }
    offset += Buffer.byteLength(raw); index++;
  }
  throw new RpcError(404, "User message was not found");
}

export async function rewindClaude(index: SessionIndex, driver: ClaudeDriver, sessionId: string, messageUuid: string) {
  assertSessionId(sessionId); const session = await index.resolve(sessionId);
  if (!session) throw new RpcError(404, "Session not found");
  if (session.agent !== "claude") throw new RpcError(501, "Exact JSONL rewind is only supported for Claude sessions");
  if (driver.isActive(sessionId)) throw new RpcError(409, "Cannot rewind an active turn");
  if (driver.isOwned(sessionId)) throw new RpcError(409, "Kill the WebUI-owned Claude process before rewinding");
  await driver.assertMutable(sessionId);
  const point = await rewindPoint(session.path, messageUuid);
  const oldSize = (await readFile(session.path)).length;
  await truncate(session.path, point.byte);
  return { removedRecords: point.removed, truncatedBytes: oldSize - point.byte, prefillText: point.prefillText };
}

export async function forkClaude(index: SessionIndex, driver: ClaudeDriver, sessionId: string, messageUuid: string) {
  assertSessionId(sessionId); const session = await index.resolve(sessionId);
  if (!session) throw new RpcError(404, "Session not found");
  if (session.agent !== "claude") throw new RpcError(501, "JSONL prefix fork is only supported for Claude sessions");
  await driver.assertMutable(sessionId);
  const point = await rewindPoint(session.path, messageUuid);
  const original = await readFile(session.path); const newSessionId = crypto.randomUUID();
  const destination = join(dirname(session.path), `${newSessionId}.jsonl`);
  const metadata = `${JSON.stringify({ type: "system", subtype: "fork", sessionId: newSessionId, parentSessionId: sessionId, cwd: session.cwd, timestamp: new Date().toISOString() })}\n`;
  const handle = await open(destination, "wx", 0o600);
  try { await handle.writeFile(Buffer.concat([original.subarray(0, point.byte), Buffer.from(metadata)])); } finally { await handle.close(); }
  const forked = await scanClaudeFile(destination);
  if (!forked) throw new RpcError(500, "Fork was written but could not be indexed");
  index.upsert(forked);
  return { newSessionId, prefillText: point.prefillText };
}

function normalizePromptText(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

const CODEX_INDEX_RETRY_MS = [0, 50, 100, 200, 400, 750] as const;

async function indexCodexMutationPath(
  index: SessionIndex,
  path: string,
  parentSessionId?: string,
): Promise<Awaited<ReturnType<SessionIndex["indexPath"]>>> {
  let lastError: unknown;
  for (const waitMs of CODEX_INDEX_RETRY_MS) {
    if (waitMs) await new Promise<void>(resolve => setTimeout(resolve, waitMs));
    try {
      const record = await index.indexPath(path, "codex", {
        ...(parentSessionId ? { parentSessionId } : {}),
      });
      if (record) return record;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError instanceof Error) throw lastError;
  return undefined;
}

function mapCodexMessagesToTurns(messages: readonly CodexUserMessagePoint[], turns: readonly CodexThreadTurn[]): number[] {
  const mapping: number[] = [];
  let nextTurn = 0;
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const prompt = normalizePromptText(messages[messageIndex]!.text);
    let matched = -1;
    for (let turnIndex = nextTurn; turnIndex < turns.length; turnIndex++) {
      if (normalizePromptText(turns[turnIndex]!.userText) === prompt) {
        matched = turnIndex;
        break;
      }
    }
    if (matched < 0 && messages.length === turns.length && turns[messageIndex]) matched = messageIndex;
    if (matched < 0) {
      throw new RpcError(409, "Could not safely match this rollout prompt to a Codex turn. Refresh the session and try again.");
    }
    mapping.push(matched);
    nextTurn = matched + 1;
  }
  return mapping;
}

async function codexMutationPoint(
  index: SessionIndex,
  driver: CodexDriver,
  sessionId: string,
  messageUuid: string,
): Promise<{ message: CodexUserMessagePoint; turnId: string; turnIndex: number; turnCount: number }> {
  const session = await index.resolve(sessionId);
  if (!session) throw new RpcError(404, "Session not found");
  if (session.agent !== "codex") throw new RpcError(409, "This is not a Codex session");
  if (driver.isActive(sessionId)) throw new RpcError(409, "Interrupt the active Codex turn before rewinding or forking");
  const history = await codexRolloutHistory(session.path);
  const messages = history.messages;
  const messageIndex = messages.findIndex(message => message.uuid === messageUuid || message.aliases.has(messageUuid));
  if (messageIndex < 0) throw new RpcError(404, "User message was not found");
  const message = messages[messageIndex]!;
  if (message.turnId && message.turnIndex !== null) {
    return {
      message,
      turnId: message.turnId,
      turnIndex: message.turnIndex,
      turnCount: history.turnIds.length,
    };
  }
  // Older rollouts may not persist turn_context. Keep a conservative
  // text-based fallback for those files only.
  const turns = await driver.threadTurns(sessionId);
  const turnIndex = mapCodexMessagesToTurns(messages, turns)[messageIndex];
  if (turnIndex === undefined) throw new RpcError(409, "The selected prompt no longer exists in Codex thread history");
  const turn = turns[turnIndex];
  if (!turn) throw new RpcError(409, "The selected prompt no longer exists in Codex thread history");
  return { message, turnId: turn.id, turnIndex, turnCount: turns.length };
}

export async function rewindSession(
  index: SessionIndex,
  claude: ClaudeDriver,
  codex: CodexDriver,
  sessionId: string,
  messageUuid: string,
) {
  assertSessionId(sessionId);
  const session = await index.resolve(sessionId);
  if (!session) throw new RpcError(404, "Session not found");
  if (session.agent === "claude") return rewindClaude(index, claude, sessionId, messageUuid);
  const point = await codexMutationPoint(index, codex, sessionId, messageUuid);
  const removedTurns = point.turnCount - point.turnIndex;
  if (removedTurns < 1) throw new RpcError(409, "There are no Codex turns to rewind");
  const response = asRecord(await codex.rollback(sessionId, removedTurns));
  const thread = asRecord(response?.thread);
  const path = asString(thread?.path) ?? session.path;
  // Let the app-server finish persisting the rewritten rollout before the
  // frontend drops its cache and resubscribes. If Windows keeps the file
  // briefly locked, the watcher can still finish the metadata refresh.
  await indexCodexMutationPath(index, path).catch(() => undefined);
  return {
    removedRecords: removedTurns,
    truncatedBytes: 0,
    prefillText: point.message.text,
  };
}

export async function forkSession(
  index: SessionIndex,
  claude: ClaudeDriver,
  codex: CodexDriver,
  sessionId: string,
  messageUuid: string,
) {
  assertSessionId(sessionId);
  const session = await index.resolve(sessionId);
  if (!session) throw new RpcError(404, "Session not found");
  if (session.agent === "claude") return forkClaude(index, claude, sessionId, messageUuid);
  const point = await codexMutationPoint(index, codex, sessionId, messageUuid);
  const response = asRecord(await codex.fork(sessionId, point.turnId));
  const thread = asRecord(response?.thread);
  const newSessionId = asString(thread?.id) ?? asString(response?.threadId) ?? asString(response?.thread_id);
  if (!newSessionId) throw new RpcError(501, "The installed Codex app-server did not return a forked thread ID");
  assertSessionId(newSessionId);
  const forkPath = asString(thread?.path);
  try {
    // `thread/fork(lastTurnId)` retains that turn. Removing one turn makes the
    // new branch match Claude's "fork before this prompt and prefill it" UX.
    const rollbackResponse = asRecord(await codex.rollback(newSessionId, 1));
    const rollbackThread = asRecord(rollbackResponse?.thread);
    const path = asString(rollbackThread?.path) ?? forkPath;
    if (!path) {
      throw new Error("Codex returned an in-memory fork without a rollout path");
    }
    const indexed = await indexCodexMutationPath(index, path, sessionId);
    if (!indexed || indexed.id !== newSessionId) {
      throw new Error("the forked rollout could not be indexed safely");
    }
  } catch (error) {
    throw new RpcError(500, `Codex created fork ${newSessionId}, but could not make it ready for WebUI: ${error instanceof Error ? error.message : "rollback/index failed"}`);
  }
  return { newSessionId, prefillText: point.message.text };
}

export async function deleteSessions(index: SessionIndex, driver: ClaudeDriver, ids: unknown[], codexActive?: (id: string) => boolean): Promise<{ deleted: string[]; failed: { id: string; message: string }[] }> {
  const deleted: string[] = []; const failed: { id: string; message: string }[] = [];
  for (const value of ids) {
    const id = String(value);
    try {
      assertSessionId(id); const session = await index.resolve(id); if (!session) throw new RpcError(404, "Not found");
      if (session.agent === "claude") await driver.assertMutable(id);
      if (session.agent === "codex" && codexActive?.(id)) throw new RpcError(409, "Interrupt the active Codex turn before deleting");
      if (driver.isOwned(id)) throw new RpcError(409, "Kill the WebUI-owned process before deleting");
      await unlink(session.path); index.remove(id); deleted.push(id);
    } catch (error) { failed.push({ id, message: error instanceof Error ? error.message : "Delete failed" }); }
  }
  return { deleted, failed };
}

const SEARCH_CHUNK_BYTES = 128 * 1024;
const SEARCH_PARSE_LINE_MAX_BYTES = 2 * 1024 * 1024;
const SEARCH_LINE_PREFIX_BYTES = 64 * 1024;
const SEARCH_YIELD_EVERY_BYTES = 2 * 1024 * 1024;

interface SearchOptions {
  signal?: AbortSignal;
}

interface LineSearchState {
  buffered: string;
  bufferedBytes: number;
  oversized: boolean;
  prefix: string;
  overlap: string;
  rawTokenHits: Set<string>;
  rawOccurrences: number;
  rawPhraseHit: boolean;
}

function newLineSearchState(): LineSearchState {
  return {
    buffered: "",
    bufferedBytes: 0,
    oversized: false,
    prefix: "",
    overlap: "",
    rawTokenHits: new Set(),
    rawOccurrences: 0,
    rawPhraseHit: false,
  };
}

function abortError(): Error {
  const error = new Error("Search superseded");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function countOccurrences(haystack: string, needle: string, limit: number): number {
  let count = 0;
  let at = 0;
  while (count < limit && (at = haystack.indexOf(needle, at)) >= 0) {
    count++;
    at += Math.max(1, needle.length);
  }
  return count;
}

function scanRawFragment(
  line: LineSearchState,
  fragment: string,
  tokens: readonly string[],
  normalizedQuery: string,
  overlapChars: number,
): void {
  if (!fragment) return;
  const haystack = `${line.overlap}${fragment}`.toLocaleLowerCase();
  const overlapLength = line.overlap.length;
  for (const token of tokens) {
    let at = 0;
    while (line.rawOccurrences < 1000 && (at = haystack.indexOf(token, at)) >= 0) {
      if (at + token.length > overlapLength) {
        line.rawTokenHits.add(token);
        line.rawOccurrences++;
      }
      at += Math.max(1, token.length);
    }
  }
  if (!line.rawPhraseHit) {
    let at = 0;
    while ((at = haystack.indexOf(normalizedQuery, at)) >= 0) {
      if (at + normalizedQuery.length > overlapLength) {
        line.rawPhraseHit = true;
        break;
      }
      at += Math.max(1, normalizedQuery.length);
    }
  }
  line.overlap = overlapChars > 0 ? haystack.slice(-overlapChars) : "";
}

function appendSearchLine(
  line: LineSearchState,
  fragment: string,
  tokens: readonly string[],
  normalizedQuery: string,
  overlapChars: number,
): void {
  scanRawFragment(line, fragment, tokens, normalizedQuery, overlapChars);
  if (line.prefix.length < SEARCH_LINE_PREFIX_BYTES) {
    line.prefix += fragment.slice(0, SEARCH_LINE_PREFIX_BYTES - line.prefix.length);
  }
  if (line.oversized) return;
  const bytes = Buffer.byteLength(fragment);
  if (line.bufferedBytes + bytes <= SEARCH_PARSE_LINE_MAX_BYTES) {
    line.buffered += fragment;
    line.bufferedBytes += bytes;
  } else {
    line.buffered = "";
    line.bufferedBytes = 0;
    line.oversized = true;
  }
}

function recordSearchText(raw: string): { haystack: string; uuid: string | null } | null {
  try {
    const record = asRecord(JSON.parse(raw));
    if (!record) return null;
    const payload = asRecord(record.payload);
    const item = asRecord(payload?.item);
    return {
      haystack: collectSearchStrings(record).join(" ").toLocaleLowerCase(),
      uuid: asString(record.uuid) ?? asString(payload?.id) ?? asString(item?.id) ?? null,
    };
  } catch {
    return null;
  }
}

function uuidFromPrefix(prefix: string): string | null {
  for (const key of ["uuid", "id"]) {
    const match = prefix.match(new RegExp(`"${key}"\\s*:\\s*"([0-9A-Za-z_-]{1,200})"`));
    if (match?.[1]) return match[1];
  }
  return null;
}

function finishSearchLine(
  line: LineSearchState,
  tokens: readonly string[],
  normalizedQuery: string,
): { tokenHits: Set<string>; score: number; uuid: string | null } | null {
  let tokenHits = line.rawTokenHits;
  let occurrences = line.rawOccurrences;
  let phraseHit = line.rawPhraseHit;
  let uuid = uuidFromPrefix(line.prefix);
  if (!line.oversized) {
    const parsed = recordSearchText(line.buffered);
    if (parsed) {
      tokenHits = new Set(tokens.filter(token => parsed.haystack.includes(token)));
      occurrences = 0;
      for (const token of tokenHits) occurrences += countOccurrences(parsed.haystack, token, 1000 - occurrences);
      phraseHit = parsed.haystack.includes(normalizedQuery);
      uuid = parsed.uuid;
    }
  }
  if (!tokenHits.size) return null;
  return { tokenHits, score: 10 + occurrences + (phraseHit ? 5 : 0), uuid };
}

async function searchSessionFile(
  path: string,
  tokens: readonly string[],
  normalizedQuery: string,
  signal?: AbortSignal,
): Promise<{ score: number; lastMatchUuid: string | null; lastMatchIndex: number | null } | null> {
  throwIfAborted(signal);
  const overlapChars = Math.max(0, ...tokens.map(token => token.length - 1), normalizedQuery.length - 1);
  let score = 0;
  let lastMatchUuid: string | null = null;
  let lastMatchIndex: number | null = null;
  let lineIndex = 0;
  let line = newLineSearchState();
  let bytesSinceYield = 0;
  const stream = createReadStream(path, {
    encoding: "utf8",
    highWaterMark: SEARCH_CHUNK_BYTES,
    signal,
  });
  for await (const value of stream) {
    throwIfAborted(signal);
    const chunk = String(value);
    bytesSinceYield += Buffer.byteLength(chunk);
    let start = 0;
    for (let at = chunk.indexOf("\n", start); at >= 0; at = chunk.indexOf("\n", start)) {
      appendSearchLine(line, chunk.slice(start, at).replace(/\r$/, ""), tokens, normalizedQuery, overlapChars);
      const result = finishSearchLine(line, tokens, normalizedQuery);
      if (result && tokens.every(token => result.tokenHits.has(token))) {
        score += result.score;
        lastMatchUuid = result.uuid;
        lastMatchIndex = lineIndex;
      }
      line = newLineSearchState();
      lineIndex++;
      start = at + 1;
    }
    appendSearchLine(line, chunk.slice(start), tokens, normalizedQuery, overlapChars);
    if (bytesSinceYield >= SEARCH_YIELD_EVERY_BYTES) {
      bytesSinceYield = 0;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  if (line.buffered || line.oversized || line.prefix) {
    const result = finishSearchLine(line, tokens, normalizedQuery);
    if (result && tokens.every(token => result.tokenHits.has(token))) {
      score += result.score;
      lastMatchUuid = result.uuid;
      lastMatchIndex = lineIndex;
    }
  }
  return lastMatchIndex !== null
    ? { score, lastMatchUuid, lastMatchIndex }
    : null;
}

export async function searchSessions(index: SessionIndex, query: string, options: SearchOptions = {}) {
  const normalizedQuery = query.trim().toLocaleLowerCase(); if (!normalizedQuery) return { matches: [] };
  const parsedTokens = normalizedQuery.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const tokens = [...new Set(parsedTokens.length ? parsedTokens : [normalizedQuery])];
  const matches: {
    id: string;
    score: number;
    lastMatchUuid: string | null;
    lastMatchIndex: number | null;
  }[] = [];
  for (const session of index.list()) {
    throwIfAborted(options.signal);
    const result = await searchSessionFile(session.path, tokens, normalizedQuery, options.signal).catch(error => {
      if ((error as { name?: unknown })?.name === "AbortError") throw error;
      return null;
    });
    if (result) matches.push({
      id: session.id,
      score: result.score,
      lastMatchUuid: result.lastMatchUuid,
      lastMatchIndex: result.lastMatchIndex,
    });
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return { matches: matches.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)) };
}

function collectSearchStrings(value: unknown, depth = 0): string[] {
  if (depth > 20) return [];
  if (typeof value === "string") {
    if (value.startsWith("data:") && value.includes(";base64,")) return [];
    if (value.length > 4096 && /^[A-Za-z0-9+/=\r\n]+$/u.test(value)) return [];
    return [value];
  }
  if (Array.isArray(value)) return value.flatMap(item => collectSearchStrings(item, depth + 1));
  const record = asRecord(value); if (!record) return [];
  return Object.values(record).flatMap(item => collectSearchStrings(item, depth + 1));
}

export async function markdownExport(index: SessionIndex, sessionId: string): Promise<string> {
  assertSessionId(sessionId); const session = await index.resolve(sessionId); if (!session) throw new RpcError(404, "Session not found");
  const rows = [`# ${session.title ?? session.preview ?? `${session.agent} session`}`, "", `- Agent: ${session.agent}`, `- Working directory: ${session.cwd}`, `- Session: ${session.id}`, ""];
  for (const line of (await snapshotJsonl(session.path)).lines) {
    try {
      const record = asRecord(JSON.parse(line.raw)); if (!record) continue;
      if (session.agent === "claude" && (record.type === "user" || record.type === "assistant")) {
        const text = contentText(asRecord(record.message)?.content ?? record.content).trim();
        if (text) rows.push(`## ${record.type === "user" ? "User" : "Assistant"}`, "", text, "");
      } else if (session.agent === "codex") {
        const payload = asRecord(record.payload); const type = asString(payload?.type) ?? asString(payload?.kind);
        const role = asString(payload?.role) ?? (type === "user_message" ? "user" : type?.includes("agent") ? "assistant" : undefined);
        const text = contentText(payload?.content) || asString(payload?.message) || asString(payload?.text);
        if (role && text) rows.push(`## ${role === "user" ? "User" : "Assistant"}`, "", text, "");
      }
    } catch { /* isolate */ }
  }
  return rows.join("\n");
}

export async function autoTitleFromText(
  index: SessionIndex,
  state: AppState,
  sessionId: string,
  text: string,
  force = false,
): Promise<string> {
  assertSessionId(sessionId);
  if (!index.get(sessionId)) throw new RpcError(404, "Session not found");
  const existing = (await state.titles.get())[sessionId];
  if (existing?.source === "manual" && !force) return existing.title;
  const prefs = await state.prefs.get();
  if (!force && !prefs.autoTitleEnabled) return existing?.title ?? "";
  let base = text.replace(/\s+/g, " ").trim() || index.get(sessionId)?.preview || "Untitled session";
  const language = prefs.autoTitleLanguage.trim().toLocaleLowerCase();
  const identifiers = (base.match(/[A-Za-z_][A-Za-z0-9_.-]{2,}/g) ?? []).slice(0, 3).join(", ");
  if ((language === "中文" || language.startsWith("zh")) && !/[\u3400-\u9fff]/u.test(base)) base = `编程会话${identifiers ? `：${identifiers}` : ""}`;
  else if ((language === "english" || language.startsWith("en")) && /[\u3400-\u9fff]/u.test(base)) base = `Coding session${identifiers ? `: ${identifiers}` : ""}`;
  const title = base.length > 48 ? `${base.slice(0, 47)}…` : base;
  await state.titles.update(all => { all[sessionId] = { title, source: "auto" }; });
  return title;
}

export async function autoTitle(index: SessionIndex, state: AppState, sessionId: string, force = false): Promise<string> {
  const existing = (await state.titles.get())[sessionId];
  if (existing?.source === "manual" && !force) return existing.title;
  const prefs = await state.prefs.get();
  if (!force && !prefs.autoTitleEnabled) return existing?.title ?? "";
  const messages = await getUserMessages(index, sessionId);
  return autoTitleFromText(index, state, sessionId, messages[0]?.text ?? "", force);
}
