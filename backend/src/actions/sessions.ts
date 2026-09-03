import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { open, stat, truncate, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { asRecord, asString, assertSessionId, RpcError, type UserMessageInfo } from "../types.js";
import type { ContentIndexCandidate, ContentSearchIndex } from "../services/content-search-index.js";
import { scanClaudeFile, type SessionIndex } from "../services/session-index.js";
import { searchableRecordPrefix, searchableRecordText } from "../services/search-text.js";
import {
  codexVisibleMessage,
  codexVisibleMessagePriority,
  isCodexInjectedContextText,
  sameCodexVisibleMessage,
  type CodexVisibleMessage,
} from "@agent-webui/shared/codex";
import type { ClaudeDriver } from "../services/claude-driver.js";
import type { CodexDriver, CodexThreadTurn } from "../services/codex-driver.js";
import type { AppState, TitleEntry } from "../services/state.js";
import { readRecordAt, streamJsonlLines } from "../services/jsonl.js";
import {
  fallbackTitleEmoji,
  fallbackTopicSummary,
  normalizeTopicSummary,
  SESSION_TITLE_TEXT_MAX_CHARS,
} from "../services/session-title-generator.js";
import {
  formatTitleRequestContext,
  recentSessionTitleContext,
} from "../services/session-title-context.js";

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap(item => {
    const obj = asRecord(item);
    return obj?.type === "text" && typeof obj.text === "string" ? [obj.text] : [];
  }).join("\n");
}

const MAX_TRANSCRIPT_ACTION_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_TRANSCRIPT_ACTION_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_TRANSCRIPT_ACTION_ITEMS = 20_000;

function oversizedTranscriptRecord(operation: string, bytes: number): RpcError {
  return new RpcError(
    413,
    `${operation} cannot process a ${Math.ceil(bytes / (1024 * 1024))} MiB conversation record; ` +
      `the per-record limit is ${MAX_TRANSCRIPT_ACTION_RECORD_BYTES / (1024 * 1024)} MiB`,
  );
}

function transcriptRecordType(prefix: string): string | undefined {
  return /"type"\s*:\s*"([^"\\]+)"/u.exec(prefix)?.[1];
}

function isPossiblyConversationRecord(prefix: string, agent: "claude" | "codex"): boolean {
  const type = transcriptRecordType(prefix);
  if (!type) return true;
  return agent === "claude"
    ? type === "user" || type === "assistant"
    : type === "response_item" || type === "event_msg";
}

function isPossiblyClaudeUserRecord(prefix: string): boolean {
  const type = transcriptRecordType(prefix);
  return !type || type === "user";
}

function addOutputBytes(current: number, text: string, operation: string): number {
  const next = current + Buffer.byteLength(text);
  if (next > MAX_TRANSCRIPT_ACTION_OUTPUT_BYTES) {
    throw new RpcError(
      413,
      `${operation} exceeds the ${MAX_TRANSCRIPT_ACTION_OUTPUT_BYTES / (1024 * 1024)} MiB output limit`,
    );
  }
  return next;
}

function assertOutputItemLimit(items: number, operation: string): void {
  if (items > MAX_TRANSCRIPT_ACTION_ITEMS) {
    throw new RpcError(413, `${operation} exceeds the ${MAX_TRANSCRIPT_ACTION_ITEMS.toLocaleString("en-US")} item limit`);
  }
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
  // The frontend's Codex adapter deliberately prefixes fallback source IDs
  // with `codex-` so they cannot collide with Claude-style record IDs. Keep
  // both spellings as aliases: older API callers use `line-N`, while the
  // visible UserPromptBlock sends `codex-line-N` for rewind/fork.
  const frontendLineId = `codex-line-${lineIndex}`;
  const payloadId = asString(payload.id);
  return {
    text,
    aliases: payloadId ? [lineId, frontendLineId, payloadId] : [lineId, frontendLineId],
    sourceKind,
  };
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
  let outputBytes = 0;
  for await (const line of streamJsonlLines(path, {
    maxRecordBytes: MAX_TRANSCRIPT_ACTION_RECORD_BYTES,
  })) {
    if (line.raw === undefined) {
      if (isPossiblyConversationRecord(line.prefix, "codex")) {
        throw oversizedTranscriptRecord("Reading user messages", line.bytes);
      }
      continue;
    }
    try {
      const record = asRecord(JSON.parse(line.raw));
      if (!record) continue;
      if (record.type === "turn_context") {
        const payload = asRecord(record.payload);
        const turnId = asString(payload?.turn_id) ?? asString(payload?.turnId);
        if (turnId) {
          currentTurnId = turnId;
          if (!turnIndexes.has(turnId)) {
            assertOutputItemLimit(turnIds.length + 1, "Reading transcript turns");
            turnIndexes.set(turnId, turnIds.length);
            turnIds.push(turnId);
          }
        }
        continue;
      }
      const message = codexUserMessage(record, line.index);
      if (!message) continue;
      const previous = result.at(-1);
      const isCompanionRecord = previous &&
        previous.turnId === currentTurnId &&
        line.index - previous.sourceIndexes.at(-1)! <= 2 &&
        !previous.sourceKinds.has(message.sourceKind) &&
        sameCodexUserMessage(previous.text, message.text);
      if (isCompanionRecord) {
        previous.sourceIndexes.push(line.index);
        for (const alias of message.aliases) previous.aliases.add(alias);
        previous.sourceKinds.add(message.sourceKind);
        // event_msg is the clean user-visible form. response_item may prepend
        // a local <image path=...> transport envelope.
        if (message.sourceKind === "event") {
          outputBytes = addOutputBytes(
            outputBytes - Buffer.byteLength(previous.text),
            message.text,
            "Reading user messages",
          );
          previous.text = message.text;
        }
        continue;
      }
      outputBytes = addOutputBytes(outputBytes, message.text, "Reading user messages");
      assertOutputItemLimit(result.length + 1, "Reading user messages");
      result.push({
        uuid: `line-${line.index}`,
        parentUuid: null,
        type: "user",
        text: message.text,
        sourceIndexes: [line.index],
        aliases: new Set(message.aliases),
        sourceKinds: new Set([message.sourceKind]),
        turnId: currentTurnId,
        turnIndex: currentTurnId === null ? null : (turnIndexes.get(currentTurnId) ?? null),
      });
    } catch (error) {
      if (error instanceof RpcError) throw error;
      /* isolate malformed record */
    }
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
  const result: UserMessageInfo[] = [];
  let outputBytes = 0;
  for await (const line of streamJsonlLines(session.path, {
    maxRecordBytes: MAX_TRANSCRIPT_ACTION_RECORD_BYTES,
  })) {
    if (line.raw === undefined) {
      if (isPossiblyConversationRecord(line.prefix, "claude")) {
        throw oversizedTranscriptRecord("Reading user messages", line.bytes);
      }
      continue;
    }
    try {
      const record = asRecord(JSON.parse(line.raw)); if (!record) continue;
      if (session.agent === "claude" && record.type === "user" && record.isMeta !== true) {
        const message = asRecord(record.message); const text = contentText(message?.content ?? record.content).trim();
        const uuid = asString(record.uuid);
        if (uuid && text) {
          outputBytes = addOutputBytes(outputBytes, text, "Reading user messages");
          assertOutputItemLimit(result.length + 1, "Reading user messages");
          result.push({ uuid, parentUuid: asString(record.parentUuid) ?? null, type: "user", text });
        }
      }
    } catch (error) {
      if (error instanceof RpcError) throw error;
      /* isolate malformed record */
    }
  }
  return result;
}

async function rewindPoint(path: string, messageUuid: string): Promise<{ byte: number; removed: number; total: number; prefillText: string }> {
  let match: { byte: number; index: number; prefillText: string } | undefined;
  let total = 0;
  let sawOversizedUserRecord: number | undefined;
  for await (const line of streamJsonlLines(path, {
    maxRecordBytes: MAX_TRANSCRIPT_ACTION_RECORD_BYTES,
  })) {
    total = line.index + 1;
    if (line.raw === undefined) {
      if (isPossiblyClaudeUserRecord(line.prefix)) {
        sawOversizedUserRecord ??= line.bytes;
      }
      continue;
    }
    try {
      const record = asRecord(JSON.parse(line.raw));
      if (!match && record?.type === "user" && record.uuid === messageUuid) {
        const message = asRecord(record.message); const text = contentText(message?.content ?? record.content);
        match = { byte: line.startByte, index: line.index, prefillText: text };
      }
    } catch { /* continue */ }
  }
  if (match) {
    return {
      byte: match.byte,
      removed: total - match.index,
      total,
      prefillText: match.prefillText,
    };
  }
  if (sawOversizedUserRecord !== undefined) {
    throw oversizedTranscriptRecord("Claude rewind/fork", sawOversizedUserRecord);
  }
  throw new RpcError(404, "User message was not found");
}

async function copyJsonlPrefix(sourcePath: string, destinationPath: string, bytes: number, suffix: string): Promise<void> {
  const source = await open(sourcePath, "r");
  let destination: Awaited<ReturnType<typeof open>> | undefined;
  try {
    destination = await open(destinationPath, "wx", 0o600);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let remaining = bytes;
    while (remaining > 0) {
      const requested = Math.min(buffer.length, remaining);
      const { bytesRead } = await source.read(buffer, 0, requested, null);
      if (!bytesRead) throw new Error("Transcript changed while copying the fork prefix");
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written, null);
        if (!result.bytesWritten) throw new Error("Could not write the fork transcript");
        written += result.bytesWritten;
      }
      remaining -= bytesRead;
    }
    const suffixBytes = Buffer.from(suffix);
    let written = 0;
    while (written < suffixBytes.length) {
      const result = await destination.write(suffixBytes, written, suffixBytes.length - written, null);
      if (!result.bytesWritten) throw new Error("Could not write fork metadata");
      written += result.bytesWritten;
    }
  } catch (error) {
    await destination?.close().catch(() => undefined);
    destination = undefined;
    await unlink(destinationPath).catch(() => undefined);
    throw error;
  } finally {
    await source.close();
    await destination?.close();
  }
}

export async function rewindClaude(index: SessionIndex, driver: ClaudeDriver, sessionId: string, messageUuid: string) {
  assertSessionId(sessionId); const session = await index.resolve(sessionId);
  if (!session) throw new RpcError(404, "Session not found");
  if (session.agent !== "claude") throw new RpcError(501, "Exact JSONL rewind is only supported for Claude sessions");
  if (driver.isActive(sessionId)) throw new RpcError(409, "Cannot rewind an active turn");
  if (driver.isOwned(sessionId)) throw new RpcError(409, "Kill the WebUI-owned Claude process before rewinding");
  await driver.assertMutable(sessionId);
  const point = await rewindPoint(session.path, messageUuid);
  const oldSize = (await stat(session.path)).size;
  await truncate(session.path, point.byte);
  return { removedRecords: point.removed, truncatedBytes: oldSize - point.byte, prefillText: point.prefillText };
}

export async function forkClaude(index: SessionIndex, driver: ClaudeDriver, sessionId: string, messageUuid: string) {
  assertSessionId(sessionId); const session = await index.resolve(sessionId);
  if (!session) throw new RpcError(404, "Session not found");
  if (session.agent !== "claude") throw new RpcError(501, "JSONL prefix fork is only supported for Claude sessions");
  await driver.assertMutable(sessionId);
  const point = await rewindPoint(session.path, messageUuid);
  const newSessionId = crypto.randomUUID();
  const destination = join(dirname(session.path), `${newSessionId}.jsonl`);
  const metadata = `${JSON.stringify({ type: "system", subtype: "fork", sessionId: newSessionId, parentSessionId: sessionId, cwd: session.cwd, timestamp: new Date().toISOString() })}\n`;
  await copyJsonlPrefix(session.path, destination, point.byte, metadata);
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
  allowActive = false,
): Promise<{ message: CodexUserMessagePoint; turnId: string; turnIndex: number; turnCount: number }> {
  const session = await index.resolve(sessionId);
  if (!session) throw new RpcError(404, "Session not found");
  if (session.agent !== "codex") throw new RpcError(409, "This is not a Codex session");
  if (!allowActive && driver.isActive(sessionId)) throw new RpcError(409, "Interrupt the active Codex turn before rewinding");
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

const CODEX_LINE_MESSAGE_ID = /^codex-line-(\d+)$/u;
const CODEX_FORK_TURN_LOOKBACK_LINES = 256;

/**
 * Visible Codex bubbles carry their physical rollout line as `codex-line-N`.
 * The transcript line index is already hot for an opened conversation, so a
 * fork can recover the prompt and preceding turn_context with a handful of
 * direct reads instead of parsing the entire (potentially huge) rollout.
 */
async function indexedCodexForkPoint(
  path: string,
  messageUuid: string,
): Promise<{ message: CodexUserMessagePoint; turnId: string } | null> {
  const match = CODEX_LINE_MESSAGE_ID.exec(messageUuid);
  if (!match) return null;
  const lineIndex = Number(match[1]);
  if (!Number.isSafeInteger(lineIndex) || lineIndex < 0) return null;

  const targetLine = await readRecordAt(path, lineIndex, MAX_TRANSCRIPT_ACTION_RECORD_BYTES);
  if (!targetLine) return null;
  let targetRecord: Record<string, unknown> | null = null;
  try {
    targetRecord = asRecord(JSON.parse(targetLine.raw));
  } catch {
    return null;
  }
  if (!targetRecord) return null;
  const message = codexUserMessage(targetRecord, lineIndex);
  if (!message || !message.aliases.includes(messageUuid)) return null;

  const lowerBound = Math.max(0, lineIndex - CODEX_FORK_TURN_LOOKBACK_LINES);
  for (let index = lineIndex - 1; index >= lowerBound; index--) {
    const line = await readRecordAt(path, index, MAX_TRANSCRIPT_ACTION_RECORD_BYTES);
    if (!line) return null;
    let record: Record<string, unknown> | null = null;
    try {
      record = asRecord(JSON.parse(line.raw));
    } catch {
      continue;
    }
    if (!record) continue;
    if (record.type === "turn_context") {
      const payload = asRecord(record.payload);
      const turnId = asString(payload?.turn_id) ?? asString(payload?.turnId);
      if (turnId) {
        return {
          message: {
            text: message.text,
            uuid: message.aliases[0]!,
            parentUuid: null,
            type: "user",
            aliases: new Set(message.aliases),
            sourceIndexes: [lineIndex],
            sourceKinds: new Set([message.sourceKind]),
            turnId,
            turnIndex: null,
          },
          turnId,
        };
      }
    }
    const earlierMessage = codexUserMessage(record, index);
    if (earlierMessage && !sameCodexUserMessage(earlierMessage.text, message.text)) return null;
  }
  return null;
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
  const point = await indexedCodexForkPoint(session.path, messageUuid)
    ?? await codexMutationPoint(index, codex, sessionId, messageUuid, true);
  // The WebUI action means "branch immediately before this prompt and put the
  // prompt back in the composer". `beforeTurnId` expresses that boundary
  // directly and, unlike `lastTurnId`, also accepts an in-progress turn.
  const response = asRecord(await codex.fork(sessionId, { beforeTurnId: point.turnId }));
  const thread = asRecord(response?.thread);
  const newSessionId = asString(thread?.id) ?? asString(response?.threadId) ?? asString(response?.thread_id);
  if (!newSessionId) throw new RpcError(501, "The installed Codex app-server did not return a forked thread ID");
  assertSessionId(newSessionId);
  const forkPath = asString(thread?.path);
  try {
    const path = forkPath;
    if (!path) {
      throw new Error("Codex returned an in-memory fork without a rollout path");
    }
    const indexed = await indexCodexMutationPath(index, path, sessionId);
    if (!indexed || indexed.id !== newSessionId) {
      throw new Error("the forked rollout could not be indexed safely");
    }
  } catch (error) {
    throw new RpcError(500, `Codex created fork ${newSessionId}, but could not make it ready for WebUI: ${error instanceof Error ? error.message : "fork indexing failed"}`);
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
const SEARCH_RG_ARG_CHARS = 20_000;
const SEARCH_RG_MAX_MATCH_LINES = 10_000;
const SEARCH_RG_MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
const SEARCH_RG_MIN_ARCHIVE_BYTES = 32 * 1024 * 1024;
const SEARCH_INDEX_READ_CONCURRENCY = 8;

interface SearchOptions {
  signal?: AbortSignal;
  rgBinary?: string;
  rgMinArchiveBytes?: number;
  contentIndex?: ContentSearchIndex | null;
  onDiagnostic?: (diagnostic: SearchDiagnostic) => void;
}

interface SearchDiagnostic {
  strategy:
    | "content-index"
    | "content-index+rg"
    | "content-index+node"
    | "rg-stream"
    | "node-fallback"
    | "node-small";
  archiveBytes: number;
  scannedArchiveBytes: number;
  sessionCount: number;
  resultCount: number;
  elapsedMs: number;
  indexedFiles?: number;
  indexedCandidates?: number;
  indexElapsedMs?: number;
  indexCatchupMs?: number;
  indexCatchupFiles?: number;
  rgElapsedMs?: number;
  rgMatchLines?: number;
  rgOutputBytes?: number;
  fallbackReason?: "rg-unavailable" | "rg-output-limit";
}

interface SearchFileMatch {
  score: number;
  lastMatchUuid: string | null;
  lastMatchIndex: number;
}

interface RgSearchResult {
  matchesByPath: Map<string, SearchFileMatch>;
  matchLineCount: number;
  outputBytes: number;
  overflowed: boolean;
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

function normalizedSearchPath(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLocaleLowerCase() : absolute;
}

function defaultRgBinary(): string {
  const configured = process.env.AGENT_WEBUI_RG_BINARY?.trim();
  if (configured) return configured;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const wingetLink = join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "rg.exe");
    if (existsSync(wingetLink)) return wingetLink;
  }
  return "rg";
}

function chunkRgPaths(paths: readonly string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentChars = 0;
  for (const path of paths) {
    const pathChars = path.length + 3;
    if (current.length && currentChars + pathChars > SEARCH_RG_ARG_CHARS) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(path);
    currentChars += pathChars;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function rgJsonText(value: unknown): string | null {
  const data = asRecord(value);
  const text = asString(data?.text);
  if (text !== undefined) return text;
  const bytes = asString(data?.bytes);
  if (bytes === undefined) return null;
  try {
    return Buffer.from(bytes, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function addRgJsonRecord(
  result: RgSearchResult,
  record: string,
  tokens: readonly string[],
  normalizedQuery: string,
): void {
  let event: Record<string, unknown> | null = null;
  try {
    event = asRecord(JSON.parse(record));
  } catch {
    return;
  }
  if (event?.type !== "match") return;
  const data = asRecord(event.data);
  const path = rgJsonText(data?.path);
  const rawWithEnding = rgJsonText(data?.lines);
  const lineNumber = Number(data?.line_number);
  if (!path || rawWithEnding === null || !Number.isSafeInteger(lineNumber) || lineNumber < 1) return;

  result.matchLineCount++;
  if (result.matchLineCount > SEARCH_RG_MAX_MATCH_LINES) {
    result.matchesByPath.clear();
    result.overflowed = true;
    return;
  }

  const raw = rawWithEnding.endsWith("\n")
    ? rawWithEnding.slice(0, -1).replace(/\r$/u, "")
    : rawWithEnding;
  const line = newLineSearchState();
  const overlapChars = Math.max(0, ...tokens.map(token => token.length - 1), normalizedQuery.length - 1);
  appendSearchLine(line, raw, tokens, normalizedQuery, overlapChars);
  const match = finishSearchLine(line, tokens, normalizedQuery);
  if (!match || !tokens.every(token => match.tokenHits.has(token))) return;

  const normalizedPath = normalizedSearchPath(path);
  const previous = result.matchesByPath.get(normalizedPath);
  result.matchesByPath.set(normalizedPath, {
    score: (previous?.score ?? 0) + match.score,
    lastMatchUuid: stableSearchUuid(match.uuid, line.prefix, lineNumber - 1),
    lastMatchIndex: lineNumber - 1,
  });
}

async function rgChunkSearch(
  binary: string,
  paths: readonly string[],
  token: string,
  tokens: readonly string[],
  normalizedQuery: string,
  maxOutputBytes: number,
  maxMatchLines: number,
  signal?: AbortSignal,
): Promise<RgSearchResult | null> {
  throwIfAborted(signal);
  const result: RgSearchResult = {
    matchesByPath: new Map(),
    matchLineCount: SEARCH_RG_MAX_MATCH_LINES - maxMatchLines,
    outputBytes: SEARCH_RG_MAX_OUTPUT_BYTES - maxOutputBytes,
    overflowed: false,
  };
  const args = [
    "--json",
    "--no-config",
    "--no-messages",
    "--text",
    "--ignore-case",
    "--fixed-strings",
    "--regexp",
    token,
    "--",
    ...paths,
  ];
  return new Promise<RgSearchResult | null>((resolveResult, rejectResult) => {
    let settled = false;
    let pending = "";
    const finish = (value: RgSearchResult | null, error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) rejectResult(error);
      else resolveResult(value);
    };
    let child;
    try {
      child = spawn(binary, args, {
        signal,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      if (signal?.aborted) finish(null, abortError());
      else finish(null);
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (result.overflowed) return;
      result.outputBytes += Buffer.byteLength(chunk);
      if (result.outputBytes > SEARCH_RG_MAX_OUTPUT_BYTES) {
        result.matchesByPath.clear();
        result.overflowed = true;
        pending = "";
        child.kill();
        return;
      }
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        addRgJsonRecord(result, pending.slice(0, newline), tokens, normalizedQuery);
        pending = pending.slice(newline + 1);
        if (result.overflowed) {
          pending = "";
          child.kill();
          return;
        }
        newline = pending.indexOf("\n");
      }
    });
    child.once("error", error => {
      if (signal?.aborted || error.name === "AbortError") finish(null, abortError());
      else finish(null);
    });
    child.once("close", code => {
      if (pending && !result.overflowed) addRgJsonRecord(result, pending, tokens, normalizedQuery);
      if (signal?.aborted) finish(null, abortError());
      else finish(result.overflowed || code === 0 || code === 1 ? result : null);
    });
  });
}

async function rgSearchRecords(
  paths: readonly string[],
  token: string,
  tokens: readonly string[],
  normalizedQuery: string,
  options: SearchOptions,
): Promise<RgSearchResult | null> {
  if (!paths.length) {
    return { matchesByPath: new Map(), matchLineCount: 0, outputBytes: 0, overflowed: false };
  }
  const combined: RgSearchResult = {
    matchesByPath: new Map(),
    matchLineCount: 0,
    outputBytes: 0,
    overflowed: false,
  };
  const binary = options.rgBinary ?? defaultRgBinary();
  for (const chunk of chunkRgPaths(paths)) {
    const result = await rgChunkSearch(
      binary,
      chunk,
      token,
      tokens,
      normalizedQuery,
      SEARCH_RG_MAX_OUTPUT_BYTES - combined.outputBytes,
      SEARCH_RG_MAX_MATCH_LINES - combined.matchLineCount,
      options.signal,
    );
    if (!result) return null;
    if (result.overflowed) {
      combined.matchesByPath.clear();
      combined.overflowed = true;
      return combined;
    }
    combined.matchLineCount = result.matchLineCount;
    combined.outputBytes = result.outputBytes;
    for (const [path, match] of result.matchesByPath) {
      const previous = combined.matchesByPath.get(path);
      combined.matchesByPath.set(path, previous
        ? {
            score: previous.score + match.score,
            lastMatchUuid: match.lastMatchUuid,
            lastMatchIndex: match.lastMatchIndex,
          }
        : match);
    }
    throwIfAborted(options.signal);
  }
  return combined;
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
  return searchableRecordText(raw);
}

function uuidFromPrefix(prefix: string): string | null {
  for (const key of ["uuid", "id"]) {
    const match = prefix.match(new RegExp(`"${key}"\\s*:\\s*"([0-9A-Za-z_-]{1,200})"`));
    if (match?.[1]) return match[1];
  }
  return null;
}

function stableSearchUuid(uuid: string | null, prefix: string, lineIndex: number): string | null {
  if (uuid) return uuid;
  if (!/"type"\s*:\s*"event_msg"/u.test(prefix)) return null;
  if (/"type"\s*:\s*"(?:user_message|UserMessage)"/u.test(prefix)) return `codex-line-${lineIndex}`;
  if (/"type"\s*:\s*"(?:agent_message|AgentMessage|AssistantMessage)"/u.test(prefix)) return `a-${lineIndex}`;
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
    if (!parsed) return null;
    tokenHits = new Set(tokens.filter(token => parsed.haystack.includes(token)));
    occurrences = 0;
    for (const token of tokenHits) occurrences += countOccurrences(parsed.haystack, token, 1000 - occurrences);
    phraseHit = parsed.haystack.includes(normalizedQuery);
    uuid = parsed.uuid;
  } else if (!searchableRecordPrefix(line.prefix)) {
    return null;
  }
  if (!tokenHits.size) return null;
  return { tokenHits, score: 10 + occurrences + (phraseHit ? 5 : 0), uuid };
}

async function searchSessionFile(
  path: string,
  tokens: readonly string[],
  normalizedQuery: string,
  signal?: AbortSignal,
): Promise<{ score: number; lastMatchUuid: string | null; lastMatchIndex: number } | null> {
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
        lastMatchUuid = stableSearchUuid(result.uuid, line.prefix, lineIndex);
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
      lastMatchUuid = stableSearchUuid(result.uuid, line.prefix, lineIndex);
      lastMatchIndex = lineIndex;
    }
  }
  return lastMatchIndex !== null
    ? { score, lastMatchUuid, lastMatchIndex }
    : null;
}

async function searchIndexedRecords(
  candidates: readonly ContentIndexCandidate[],
  tokens: readonly string[],
  normalizedQuery: string,
  signal?: AbortSignal,
): Promise<{ matchesByPath: Map<string, SearchFileMatch>; failedPaths: Set<string> }> {
  const byPath = new Map<string, ContentIndexCandidate[]>();
  for (const candidate of candidates) {
    const key = normalizedSearchPath(candidate.path);
    const existing = byPath.get(key) ?? [];
    existing.push(candidate);
    byPath.set(key, existing);
  }
  const matchesByPath = new Map<string, SearchFileMatch>();
  const failedPaths = new Set<string>();
  const overlapChars = Math.max(0, ...tokens.map(token => token.length - 1), normalizedQuery.length - 1);
  const entries = [...byPath.entries()];
  let nextEntry = 0;
  const searchPath = async ([key, records]: [string, ContentIndexCandidate[]]) => {
    throwIfAborted(signal);
    records.sort((left, right) => left.lineIndex - right.lineIndex);
    let handle;
    try {
      handle = await open(records[0]!.path, "r");
      for (const record of records) {
        throwIfAborted(signal);
        if (
          !Number.isSafeInteger(record.byteOffset)
          || record.byteOffset < 0
          || !Number.isSafeInteger(record.byteLength)
          || record.byteLength < 0
          || !Number.isSafeInteger(record.byteOffset + record.byteLength)
        ) throw new Error("invalid content-index record range");
        const line = newLineSearchState();
        const decoder = new StringDecoder("utf8");
        const buffer = Buffer.allocUnsafe(Math.min(SEARCH_CHUNK_BYTES, Math.max(1, record.byteLength)));
        let offset = 0;
        while (offset < record.byteLength) {
          throwIfAborted(signal);
          const wanted = Math.min(buffer.length, record.byteLength - offset);
          const read = await handle.read(buffer, 0, wanted, record.byteOffset + offset);
          if (!read.bytesRead) throw new Error("indexed transcript record is no longer readable");
          appendSearchLine(
            line,
            decoder.write(buffer.subarray(0, read.bytesRead)),
            tokens,
            normalizedQuery,
            overlapChars,
          );
          offset += read.bytesRead;
        }
        appendSearchLine(line, decoder.end().replace(/\r$/u, ""), tokens, normalizedQuery, overlapChars);
        const match = finishSearchLine(line, tokens, normalizedQuery);
        if (!match || !tokens.every(token => match.tokenHits.has(token))) continue;
        const previous = matchesByPath.get(key);
        matchesByPath.set(key, {
          score: (previous?.score ?? 0) + match.score,
          lastMatchUuid: stableSearchUuid(match.uuid, line.prefix, record.lineIndex),
          lastMatchIndex: record.lineIndex,
        });
      }
    } catch (error) {
      if ((error as { name?: unknown })?.name === "AbortError") throw error;
      matchesByPath.delete(key);
      failedPaths.add(key);
    } finally {
      await handle?.close().catch(() => undefined);
    }
    await new Promise<void>(resolveImmediate => setImmediate(resolveImmediate));
  };
  await Promise.all(Array.from(
    { length: Math.min(SEARCH_INDEX_READ_CONCURRENCY, entries.length) },
    async () => {
      while (nextEntry < entries.length) {
        const entry = entries[nextEntry++];
        if (entry) await searchPath(entry);
      }
    },
  ));
  return { matchesByPath, failedPaths };
}

export async function searchSessions(index: SessionIndex, query: string, options: SearchOptions = {}) {
  const startedAt = Date.now();
  const normalizedQuery = query.trim().toLocaleLowerCase(); if (!normalizedQuery) return { matches: [] };
  const parsedTokens = normalizedQuery.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const tokens = [...new Set(parsedTokens.length ? parsedTokens : [normalizedQuery])];
  // Multi-agent v2 workers are parent-controlled implementation threads, not
  // user-addressable chats. Ordinary forks can also have a parentSessionId,
  // so exclude only the explicit subagent marker.
  const sessions = index.list().filter(session => session.subagent !== true);
  const candidateToken = tokens.reduce((longest, token) => token.length > longest.length ? token : longest, tokens[0] ?? normalizedQuery);
  const archiveBytes = sessions.reduce((total, session) => total + session.size, 0);

  const indexCatchup = options.contentIndex
    ? await options.contentIndex.catchUpAppends(sessions, options.signal)
    : null;
  const indexedCandidates = options.contentIndex
    ? await options.contentIndex.candidates(sessions, candidateToken, options.signal)
    : null;
  const indexedSearch = indexedCandidates && !indexedCandidates.overflowed
    ? await searchIndexedRecords(indexedCandidates.candidates, tokens, normalizedQuery, options.signal)
    : null;
  const coveredPaths = new Set(indexedCandidates?.overflowed ? [] : indexedCandidates?.coveredPaths ?? []);
  for (const failedPath of indexedSearch?.failedPaths ?? []) coveredPaths.delete(failedPath);
  const remainingSessions = sessions.filter(session => !coveredPaths.has(normalizedSearchPath(session.path)));
  const scannedArchiveBytes = remainingSessions.reduce((total, session) => total + session.size, 0);

  const shouldUseRg = (
    scannedArchiveBytes >= (options.rgMinArchiveBytes ?? SEARCH_RG_MIN_ARCHIVE_BYTES)
    && !/[\r\n]/u.test(candidateToken)
  );
  const rgStartedAt = Date.now();
  const rgResult = shouldUseRg
    ? await rgSearchRecords(remainingSessions.map(session => session.path), candidateToken, tokens, normalizedQuery, options)
    : null;
  const rgElapsedMs = Date.now() - rgStartedAt;
  const matchesByPath = new Map(indexedSearch?.matchesByPath ?? []);
  const matchesForSessions = () => {
    const matches: {
      id: string;
      score: number;
      lastMatchUuid: string | null;
      lastMatchIndex: number | null;
    }[] = [];
    for (const session of sessions) {
      const match = matchesByPath.get(normalizedSearchPath(session.path));
      if (match) matches.push({ id: session.id, ...match });
    }
    return matches.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  };

  if (rgResult && !rgResult.overflowed) {
    for (const [path, match] of rgResult.matchesByPath) matchesByPath.set(path, match);
    const sorted = matchesForSessions();
    try {
      options.onDiagnostic?.({
        strategy: coveredPaths.size ? "content-index+rg" : "rg-stream",
        archiveBytes,
        scannedArchiveBytes,
        sessionCount: sessions.length,
        resultCount: sorted.length,
        elapsedMs: Date.now() - startedAt,
        indexedFiles: coveredPaths.size,
        indexedCandidates: indexedCandidates?.candidates.length,
        indexElapsedMs: indexedCandidates?.elapsedMs,
        indexCatchupMs: indexCatchup?.elapsedMs,
        indexCatchupFiles: indexCatchup?.freshenedFiles,
        rgElapsedMs,
        rgMatchLines: rgResult.matchLineCount,
        rgOutputBytes: rgResult.outputBytes,
      });
    } catch { /* diagnostics must never fail a search */ }
    return { matches: sorted };
  }

  for (const session of remainingSessions) {
    throwIfAborted(options.signal);
    const result = await searchSessionFile(
      session.path,
      tokens,
      normalizedQuery,
      options.signal,
    ).catch(error => {
      if ((error as { name?: unknown })?.name === "AbortError") throw error;
      return null;
    });
    if (result) matchesByPath.set(normalizedSearchPath(session.path), {
      score: result.score,
      lastMatchUuid: result.lastMatchUuid,
      lastMatchIndex: result.lastMatchIndex,
    });
    await new Promise<void>(resolveImmediate => setImmediate(resolveImmediate));
  }
  const sorted = matchesForSessions();
  try {
    options.onDiagnostic?.({
      strategy: coveredPaths.size
        ? (remainingSessions.length ? "content-index+node" : "content-index")
        : shouldUseRg ? "node-fallback" : "node-small",
      archiveBytes,
      scannedArchiveBytes,
      sessionCount: sessions.length,
      resultCount: sorted.length,
      elapsedMs: Date.now() - startedAt,
      indexedFiles: coveredPaths.size,
      indexedCandidates: indexedCandidates?.candidates.length,
      indexElapsedMs: indexedCandidates?.elapsedMs,
      indexCatchupMs: indexCatchup?.elapsedMs,
      indexCatchupFiles: indexCatchup?.freshenedFiles,
      ...(shouldUseRg ? {
        rgElapsedMs,
        rgMatchLines: rgResult?.matchLineCount,
        rgOutputBytes: rgResult?.outputBytes,
        fallbackReason: rgResult?.overflowed ? "rg-output-limit" as const : "rg-unavailable" as const,
      } : {}),
    });
  } catch { /* diagnostics must never fail a search */ }
  return { matches: sorted };
}

export async function markdownExport(index: SessionIndex, sessionId: string, resolvedTitle?: string): Promise<string> {
  assertSessionId(sessionId); const session = await index.resolve(sessionId); if (!session) throw new RpcError(404, "Session not found");
  const title = resolvedTitle?.trim() || session.title || session.preview || `${session.agent} session`;
  const rows = [`# ${title}`, "", `- Agent: ${session.agent}`, `- Working directory: ${session.cwd}`, `- Session: ${session.id}`, ""];
  let outputBytes = rows.reduce((total, row) => total + Buffer.byteLength(row) + 1, 0);
  let sectionCount = 0;
  const codexMessages: Array<{
    message: CodexVisibleMessage;
    lastSourceIndex: number;
  }> = [];
  const appendSection = (role: "User" | "Assistant", text: string): void => {
    assertOutputItemLimit(++sectionCount, "Markdown export");
    const section = [`## ${role}`, "", text, ""];
    for (const row of section) outputBytes = addOutputBytes(outputBytes, `${row}\n`, "Markdown export");
    rows.push(...section);
  };
  for await (const line of streamJsonlLines(session.path, {
    maxRecordBytes: MAX_TRANSCRIPT_ACTION_RECORD_BYTES,
  })) {
    if (line.raw === undefined) {
      if (isPossiblyConversationRecord(line.prefix, session.agent)) {
        throw oversizedTranscriptRecord("Markdown export", line.bytes);
      }
      continue;
    }
    try {
      const record = asRecord(JSON.parse(line.raw)); if (!record) continue;
      if (session.agent === "claude" && (record.type === "user" || record.type === "assistant")) {
        const text = contentText(asRecord(record.message)?.content ?? record.content).trim();
        if (text) appendSection(record.type === "user" ? "User" : "Assistant", text);
      } else if (session.agent === "codex") {
        const message = codexVisibleMessage(record);
        if (!message || (message.role === "user" && isCodexInjectedContextText(message.text))) continue;
        const previous = codexMessages.at(-1);
        const isCompanion = previous
          && line.index - previous.lastSourceIndex <= 4
          && previous.message.transport !== message.transport
          && sameCodexVisibleMessage(previous.message, message);
        if (isCompanion) {
          previous.lastSourceIndex = line.index;
          if (codexVisibleMessagePriority(message) > codexVisibleMessagePriority(previous.message)) {
            previous.message = message;
          }
          continue;
        }
        assertOutputItemLimit(codexMessages.length + 1, "Markdown export");
        codexMessages.push({
          message,
          lastSourceIndex: line.index,
        });
      }
    } catch (error) {
      if (error instanceof RpcError) throw error;
      /* isolate malformed record */
    }
  }
  if (session.agent === "codex") {
    for (const { message } of codexMessages) {
      appendSection(message.role === "user" ? "User" : "Assistant", message.text.trim());
    }
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

  const sameTitleEntry = (
    left: TitleEntry | undefined,
    right: TitleEntry | undefined,
  ): boolean => left?.title === right?.title
    && left?.source === right?.source
    && left?.emoji === right?.emoji
    && left?.parentSessionId === right?.parentSessionId
    && left?.topicSummary === right?.topicSummary;
  const commitIfUnchanged = async (entry: TitleEntry): Promise<string> => {
    if (!force && !(await state.prefs.get()).autoTitleEnabled) {
      return (await state.titles.get())[sessionId]?.title ?? "";
    }
    const updated = await state.titles.update(all => {
      // A manual rename, title clear, competing refresh, or session deletion
      // that lands while the model is running must win over this stale result.
      if (!index.get(sessionId) || !sameTitleEntry(all[sessionId], existing)) return;
      all[sessionId] = {
        ...entry,
        ...(existing?.parentSessionId !== undefined
          ? { parentSessionId: existing.parentSessionId }
          : {}),
      };
    });
    return updated[sessionId]?.title ?? "";
  };

  // Both Claude and Codex sessions use the same tiny Codex structured-output
  // job. The generator is injected by buildApp so unit tests and offline
  // installations can fall through to the deterministic heuristic below.
  if (state.titleGenerator) {
    try {
      const generated = await state.titleGenerator({
        text: text.trim().slice(0, SESSION_TITLE_TEXT_MAX_CHARS),
        language: prefs.autoTitleLanguage,
        ...(existing?.topicSummary ? { previousSummary: existing.topicSummary } : {}),
      });
      const topicSummary = normalizeTopicSummary(generated.summary)
        || fallbackTopicSummary(existing?.topicSummary, text);
      return commitIfUnchanged({
        title: generated.title,
        emoji: generated.emoji,
        source: "auto",
        ...(topicSummary ? { topicSummary } : {}),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : error;
      if (existing?.title.trim()) {
        // A transient provider/network failure during a periodic refresh must
        // not replace a useful title with a clipped copy of the user prompts.
        console.error("Codex titler failed; keeping existing title", detail);
        return existing.title;
      }
      console.error("Codex titler failed, falling back to heuristic", detail);
      /* New sessions still need a deterministic title when the model is unavailable. */
    }
  }

  // Heuristic fallback: remove title-context scaffolding before slicing. If the
  // model is unavailable, users should still see their actual task rather than
  // a title such as "CONVERSATION-WIDE USER REQUEST SAMPLE".
  const requestLines = text.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^(?:\d+\.|Context \d+:)\s*(.+)$/i);
    return match?.[1]?.trim() ? [match[1].trim()] : [];
  });
  const legacyCurrent = text.match(/CURRENT REQUEST \(highest priority\):\s*\n([^\n]+)/i)?.[1]?.trim();
  const fallbackText = requestLines.join(" ")
    || legacyCurrent
    || text.replace(/\s+/g, " ").trim();
  let base = fallbackText || index.get(sessionId)?.preview || "Untitled session";
  const language = prefs.autoTitleLanguage.trim().toLocaleLowerCase();
  const identifiers = (base.match(/[A-Za-z_][A-Za-z0-9_.-]{2,}/g) ?? []).slice(0, 3).join(", ");
  if ((language === "中文" || language.startsWith("zh")) && !/[\u3400-\u9fff]/u.test(base)) base = `编程会话${identifiers ? `：${identifiers}` : ""}`;
  else if ((language === "english" || language.startsWith("en")) && /[\u3400-\u9fff]/u.test(base)) base = `Coding session${identifiers ? `: ${identifiers}` : ""}`;
  const title = base.length > 48 ? `${base.slice(0, 47)}…` : base;
  const emoji = fallbackTitleEmoji(fallbackText);
  const topicSummary = fallbackTopicSummary(existing?.topicSummary, fallbackText);
  return commitIfUnchanged({
    title,
    emoji,
    source: "auto",
    ...(topicSummary ? { topicSummary } : {}),
  });
}

export async function autoTitle(index: SessionIndex, state: AppState, sessionId: string, force = false): Promise<string> {
  const existing = (await state.titles.get())[sessionId];
  if (existing?.source === "manual" && !force) return existing.title;
  const prefs = await state.prefs.get();
  if (!force && !prefs.autoTitleEnabled) return existing?.title ?? "";
  const session = index.get(sessionId);
  if (!session) throw new RpcError(404, "Session not found");
  const context = await recentSessionTitleContext(session.path, session.agent)
    || formatTitleRequestContext([session.preview ?? "Untitled session"]);
  return autoTitleFromText(index, state, sessionId, context, force);
}
