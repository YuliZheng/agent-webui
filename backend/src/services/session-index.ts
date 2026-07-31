import { EventEmitter } from "node:events";
import { watch as watchFs } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import chokidar from "chokidar";
import { asRecord, asString, type AgentKind, type SessionRecord } from "../types.js";
import { isWithin } from "../util/paths.js";
import { JsonStore } from "../util/json-store.js";

const BACK_SCAN_MIN = 64 * 1024;
const BACK_SCAN_MAX = 16 * 1024 * 1024;
// Watcher refreshes are on the hottest path in the application: an active
// agent can append several times a second. Never re-read the whole preview
// window for a normal append. A small overlap repairs a line that was partial
// at the previous stat, while the cap bounds a single very large tool result.
export const SESSION_APPEND_OVERLAP_BYTES = 64 * 1024;
export const SESSION_APPEND_SCAN_MAX_BYTES = 512 * 1024;
const HEAD_SCAN_MAX = 4 * 1024 * 1024;
export const HEAD_SCAN_CHUNK_BYTES = 64 * 1024;
export const HEAD_SCAN_YIELD_EVERY_BYTES = 256 * 1024;
export const HEAD_SCAN_YIELD_MS = 4;
// Initial discovery must stay cheap even when the archive contains hundreds of
// multi-gigabyte transcripts. A deeper backwards search is done once, on
// demand, when a session is actually opened.
export const SESSION_INITIAL_PREVIEW_BYTES = BACK_SCAN_MIN;
// Cold discovery is intentionally conservative. On Windows, several parallel
// JSONL readers also make Defender inspect several large files at once, which
// can make the entire machine feel stuck even though Node's own RSS is modest.
// One worker is intentional. On Windows, even two independent JSONL opens can
// make Defender and the filesystem race across a large archive, which hurts
// desktop responsiveness far more than it improves the one-time cold scan.
export const SESSION_SCAN_CONCURRENCY = 1;
// Pace only uncached metadata reads. Warm starts still just stat their cached
// paths and do not pay this delay. About 10 cold files/second is intentionally
// conservative: on Windows each new JSONL open can wake Defender, and a burst
// of hundreds of opens is much more disruptive than a longer background scan.
export const SESSION_COLD_SCAN_PACE_MS = 100;
// Directory discovery is also incremental. This is small enough to be
// invisible on a normal archive, while yielding between deep date/project
// directories on very large or network-backed homes.
export const SESSION_DIRECTORY_SCAN_PACE_MS = 2;
// Persist the first successfully parsed cold record immediately, then
// checkpoint in small batches. If the user stops a slow first launch, the next
// launch resumes from the checkpoint instead of cold-scanning from zero.
export const SESSION_COLD_SCAN_CHECKPOINT_EVERY = 16;
// The selected transcript owns its own 2-second tail poller. This archive
// poller is only a fallback for session-list metadata missed by chokidar, so
// keep it deliberately quiet: continuously statting dozens of cold histories
// was visible in Windows Defender/disk usage on large installations.
export const SESSION_POLL_INTERVAL_MS = 10_000;
export const SESSION_POLL_BATCH_SIZE = 8;
export const SESSION_DISCOVERY_EVERY_POLLS = 30;
// Cold archives do not need every historical row's preview immediately. A
// bounded, deliberately slow queue fills only a handful of recent visible rows
// after startup and persists the result. Older rows hydrate immediately when
// selected. A 15-second cadence avoids the almost-continuous file opens that
// can make Windows Defender and network-backed home directories visibly busy.
export const SESSION_PREVIEW_HYDRATE_INTERVAL_MS = 15_000;
export const SESSION_PREVIEW_HYDRATE_LIMIT = 8;

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!items.length) return [];
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(items.length, Math.floor(concurrency) || 1));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!, index);
    }
  }));
  return results;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(finish, ms);
    const abort = () => finish();
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function walkJsonl(
  root: string,
  accept: (path: string) => boolean,
  acceptDirectory: (path: string) => boolean = () => true,
  signal?: AbortSignal,
): Promise<string[]> {
  const found: string[] = [];
  let directories = [root];
  while (directories.length && !signal?.aborted) {
    const levels = await mapWithConcurrency(directories, SESSION_SCAN_CONCURRENCY, async dir => {
      if (signal?.aborted) return [];
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        await delay(SESSION_DIRECTORY_SCAN_PACE_MS, signal);
        return entries;
      } catch {
        return [];
      }
    });
    const next: string[] = [];
    for (let index = 0; index < directories.length; index++) {
      const dir = directories[index]!;
      for (const entry of levels[index]!) {
        const path = join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory() && acceptDirectory(path)) next.push(path);
        else if (entry.isFile() && extname(entry.name) === ".jsonl" && accept(path)) found.push(path);
      }
    }
    directories = next;
  }
  return found;
}

function allowClaudeDirectory(path: string): boolean {
  // Prune the directory before readdir rather than walking every subagent
  // transcript and rejecting only its files. Match the actual directory name
  // so unrelated names such as "subagents-archive" remain discoverable.
  return basename(path).toLowerCase() !== "subagents";
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap(item => {
    const obj = asRecord(item);
    return ["text", "input_text", "output_text"].includes(asString(obj?.type) ?? "") && typeof obj?.text === "string" ? [obj.text] : [];
  }).join("\n").trim();
  return text || undefined;
}

function claudeMeaning(record: Record<string, unknown>): { text?: string; timestamp?: string; priority: number } {
  if (record.isSidechain === true || typeof record.agentId === "string" || record.isMeta === true || record.isCompactSummary === true) return { priority: 0 };
  const message = asRecord(record.message);
  const type = asString(record.type);
  const timestamp = asString(record.timestamp);
  if (type === "assistant" && message) {
    const text = textFromContent(message.content);
    if (text) return { text, timestamp, priority: 2 };
  }
  if (type === "user") {
    const text = textFromContent(message?.content ?? record.content);
    if (text && !text.startsWith("<local-command-")) return { text, timestamp, priority: 1 };
  }
  return { priority: 0 };
}

function codexMeaning(record: Record<string, unknown>): { text?: string; timestamp?: string; priority: number } {
  const payload = asRecord(record.payload);
  const timestamp = asString(record.timestamp);
  if (!payload) return { priority: 0 };
  const kind = asString(payload.type) ?? asString(payload.kind);
  if (record.type === "response_item") {
    if (kind === "message") {
      const role = asString(payload.role);
      const text = textFromContent(payload.content);
      if (text && role === "assistant") return { text, timestamp, priority: 2 };
      if (text && role === "user") return { text, timestamp, priority: 1 };
    }
    if (kind === "user_message") {
      const text = asString(payload.message) ?? asString(payload.text);
      if (text) return { text, timestamp, priority: 1 };
    }
  }
  if (record.type === "event_msg") {
    const text = asString(payload.message) ?? asString(payload.text);
    if (text && (kind === "agent_message" || kind === "assistant_message")) return { text, timestamp, priority: 2 };
    if (text && kind === "user_message") return { text, timestamp, priority: 1 };
  }
  return { priority: 0 };
}

function cleanPreview(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 80 ? `${compact.slice(0, 79)}…` : compact;
}

export interface HeadScanResult {
  bytesRead: number;
  stopped: boolean;
}

export async function scanJsonlHead(
  path: string,
  size: number,
  visit: (line: string) => boolean,
  max = HEAD_SCAN_MAX,
): Promise<HeadScanResult> {
  const limit = Math.max(0, Math.min(size, max));
  if (!limit) return { bytesRead: 0, stopped: false };
  const handle = await open(path, "r");
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let offset = 0;
  try {
    while (offset < limit) {
      const requested = Math.min(HEAD_SCAN_CHUNK_BYTES, limit - offset);
      const chunk = Buffer.allocUnsafe(requested);
      const { bytesRead } = await handle.read(chunk, 0, requested, offset);
      if (!bytesRead) break;
      offset += bytesRead;
      const parts = `${pending}${decoder.write(chunk.subarray(0, bytesRead))}`.split("\n");
      pending = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.endsWith("\r") ? part.slice(0, -1) : part;
        if (visit(line)) return { bytesRead: offset, stopped: true };
      }
      // Most sessions contain cwd/session_meta in the first chunk and never
      // pay this delay. A pathological first record can be several MiB; yield
      // periodically so cold discovery cannot monopolize disk/CPU.
      if (offset < limit && offset % HEAD_SCAN_YIELD_EVERY_BYTES === 0) {
        await new Promise<void>(resolve => setTimeout(resolve, HEAD_SCAN_YIELD_MS));
      }
    }
    pending += decoder.end();
    if (pending && visit(pending.endsWith("\r") ? pending.slice(0, -1) : pending)) {
      return { bytesRead: offset, stopped: true };
    }
    return { bytesRead: offset, stopped: false };
  } finally {
    await handle.close();
  }
}

async function readBackLines(path: string, size: number, maxBytes = BACK_SCAN_MAX): Promise<string[]> {
  const maximum = Math.max(0, Math.min(size, maxBytes, BACK_SCAN_MAX));
  if (!maximum) return [];
  let window = Math.min(maximum, BACK_SCAN_MIN);
  while (true) {
    const start = Math.max(0, size - window);
    const data = Buffer.alloc(size - start); const handle = await open(path, "r");
    try { await handle.read(data, 0, data.length, start); } finally { await handle.close(); }
    const fragment = data.toString("utf8");
    const lines = fragment.split(/\r?\n/);
    if (start > 0) lines.shift();
    let assistant = false;
    let user = false;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const rec = asRecord(JSON.parse(lines[i] ?? ""));
        if (!rec) continue;
        const meaning = basename(path).startsWith("rollout-") ? codexMeaning(rec) : claudeMeaning(rec);
        if (meaning.priority === 2) assistant = true;
        if (meaning.priority === 1) user = true;
      } catch { /* malformed lines are isolated */ }
    }
    if (assistant || user || start === 0 || window >= maximum) return lines;
    window = Math.min(maximum, window * 2);
  }
}

interface LatestMeaning {
  preview: string | null;
  lastTurnAt: string | null;
  priority: 0 | 1 | 2;
}

function latestMeaningDetail(lines: string[], agent: AgentKind): LatestMeaning {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const record = asRecord(JSON.parse(lines[i] ?? ""));
      if (!record) continue;
      const value = agent === "claude" ? claudeMeaning(record) : codexMeaning(record);
      if (value.priority > 0 && value.text) {
        return {
          preview: cleanPreview(value.text),
          lastTurnAt: value.timestamp ?? null,
          priority: value.priority as 1 | 2,
        };
      }
    } catch { /* keep scanning */ }
  }
  return { preview: null, lastTurnAt: null, priority: 0 };
}

function latestMeaning(lines: string[], agent: AgentKind): { preview: string | null; lastTurnAt: string | null } {
  const { priority: _priority, ...summary } = latestMeaningDetail(lines, agent);
  return summary;
}

async function readAppendLines(path: string, previousSize: number, nextSize: number): Promise<string[]> {
  if (nextSize <= previousSize) return [];
  const desiredStart = Math.max(0, previousSize - SESSION_APPEND_OVERLAP_BYTES);
  const start = Math.max(desiredStart, nextSize - SESSION_APPEND_SCAN_MAX_BYTES);
  const length = nextSize - start;
  if (!length) return [];
  const data = Buffer.allocUnsafe(length);
  const handle = await open(path, "r");
  let offset = 0;
  try {
    while (offset < length) {
      const { bytesRead } = await handle.read(data, offset, length - offset, start + offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
  } finally {
    await handle.close();
  }
  const lines = data.subarray(0, offset).toString("utf8").split(/\r?\n/);
  // The first fragment is not parseable when the capped/overlap window starts
  // in the middle of a JSONL record. The final fragment is intentionally kept:
  // it may already be a complete line in a file that does not end in "\n".
  if (start > 0) lines.shift();
  return lines;
}

export async function scanClaudeFile(path: string, previewBytes = BACK_SCAN_MAX): Promise<SessionRecord | null> {
  if (path.replaceAll("\\", "/").includes("/subagents/") || basename(path).startsWith("agent-")) return null;
  const id = basename(path, ".jsonl");
  if (!/^[0-9A-Za-z_-]+$/.test(id)) return null;
  const fileStat = await stat(path);
  let cwd: string | undefined;
  let parentSessionId: string | null = null;
  await scanJsonlHead(path, fileStat.size, line => {
    try {
      const record = asRecord(JSON.parse(line));
      if (!record || !["user", "assistant", "system"].includes(asString(record.type) ?? "")) return false;
      cwd ??= asString(record.cwd);
      parentSessionId ??= asString(record.parentSessionId) ?? null;
      return Boolean(cwd);
    } catch { /* continue */ }
    return false;
  });
  if (!cwd) return null;
  const backLines = await readBackLines(path, fileStat.size, previewBytes);
  for (let i = backLines.length - 1; i >= 0 && !parentSessionId; i--) {
    try {
      const record = asRecord(JSON.parse(backLines[i] ?? ""));
      if (record?.type === "system" && record.subtype === "fork") parentSessionId = asString(record.parentSessionId) ?? null;
    } catch { /* malformed lines are isolated */ }
  }
  const latest = latestMeaning(backLines, "claude");
  return { id, path, cwd, agent: "claude", mtime: fileStat.mtime.toISOString(), size: fileStat.size, parentSessionId, ...latest };
}

export async function scanCodexFile(path: string, previewBytes = BACK_SCAN_MAX): Promise<SessionRecord | null> {
  if (!basename(path).startsWith("rollout-")) return null;
  const fileStat = await stat(path);
  let id: string | undefined;
  let cwd: string | undefined;
  let parentSessionId: string | null = null;
  let subagent = false;
  await scanJsonlHead(path, fileStat.size, line => {
    try {
      const record = asRecord(JSON.parse(line));
      if (record?.type !== "session_meta") return false;
      const payload = asRecord(record.payload);
      id = asString(payload?.id) ?? asString(payload?.thread_id) ?? asString(payload?.session_id);
      cwd = asString(payload?.cwd);
      const source = asRecord(payload?.source);
      const sourceSubagent = asRecord(source?.subagent);
      const threadSpawn = asRecord(sourceSubagent?.thread_spawn);
      subagent = asString(payload?.thread_source) === "subagent" || sourceSubagent !== null;
      const parent = asString(payload?.parent_thread_id)
        ?? asString(threadSpawn?.parent_thread_id)
        ?? asString(payload?.session_id);
      parentSessionId = parent && parent !== id ? parent : null;
      return true;
    } catch { /* continue */ }
    return false;
  });
  if (!id || !cwd || !/^[0-9A-Za-z_-]+$/.test(id)) return null;
  const latest = latestMeaning(await readBackLines(path, fileStat.size, previewBytes), "codex");
  return {
    id,
    path,
    cwd,
    agent: "codex",
    mtime: fileStat.mtime.toISOString(),
    size: fileStat.size,
    parentSessionId,
    subagent,
    ...latest,
  };
}

interface PersistedSessionIndex {
  version: 1;
  records: SessionRecord[];
  previewComplete: string[];
  previewScanned: string[];
}

const emptyPersistedSessionIndex = (): PersistedSessionIndex => ({
  version: 1,
  records: [],
  previewComplete: [],
  previewScanned: [],
});

function optionalString(record: Record<string, unknown>, key: string): string | null | undefined {
  const value = record[key];
  return value === null ? null : asString(value);
}

function normalizeCachedSession(value: unknown): SessionRecord | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = asString(record.id);
  const path = asString(record.path);
  const cwd = asString(record.cwd);
  const mtime = asString(record.mtime);
  const agent = record.agent === "claude" || record.agent === "codex" ? record.agent : undefined;
  const size = typeof record.size === "number" && Number.isFinite(record.size) && record.size >= 0
    ? Math.floor(record.size)
    : undefined;
  if (!id || !/^[0-9A-Za-z_-]+$/.test(id) || !path || !cwd || !mtime || !agent || size === undefined) return null;
  // Older persisted indexes predate Codex subagent classification. Reject
  // those Codex rows once so startup reparses their small session_meta head;
  // otherwise unchanged files would remain misclassified forever.
  if (agent === "codex" && typeof record.subagent !== "boolean") return null;
  return {
    id,
    path,
    cwd,
    mtime,
    size,
    agent,
    ...(agent === "codex" ? { subagent: record.subagent === true } : {}),
    preview: optionalString(record, "preview"),
    lastTurnAt: optionalString(record, "lastTurnAt"),
    parentSessionId: optionalString(record, "parentSessionId"),
  };
}

function normalizePersistedSessionIndex(value: unknown): PersistedSessionIndex {
  const record = asRecord(value);
  const records = Array.isArray(record?.records)
    ? record.records.map(normalizeCachedSession).filter((item): item is SessionRecord => item !== null)
    : [];
  const previewComplete = Array.isArray(record?.previewComplete)
    ? record.previewComplete.filter((item): item is string => typeof item === "string")
    : [];
  const previewScanned = Array.isArray(record?.previewScanned)
    ? record.previewScanned.filter((item): item is string => typeof item === "string")
    : [];
  return { version: 1, records, previewComplete, previewScanned };
}

export interface SessionIndexOptions {
  claudeRoot: string;
  codexRoot: string;
  cachePath?: string;
  deferColdPreviews?: boolean;
  /** Test/embedded callers may override the conservative production cadence. */
  coldScanPaceMs?: number;
}

interface CloseableWatcher {
  close(): void | Promise<void>;
}

export class SessionIndex extends EventEmitter {
  private records = new Map<string, SessionRecord>();
  // Watcher appends are the hottest path in this service. Keep a direct path
  // index instead of allocating/scanning the entire session table on every
  // filesystem change.
  private recordsByPath = new Map<string, SessionRecord>();
  private previewComplete = new Set<string>();
  private previewScanned = new Set<string>();
  private watchers: CloseableWatcher[] = [];
  private timers = new Map<string, NodeJS.Timeout>();
  private refreshes = new Map<string, Promise<void>>();
  private pendingRefreshes = new Map<string, number>();
  private scanWork?: Promise<SessionRecord[]>;
  private poller?: NodeJS.Timeout;
  private polling = false;
  private pollTick = 0;
  private pollCursor = 0;
  private cacheStore?: JsonStore<PersistedSessionIndex>;
  private cacheWriteTimer?: NodeJS.Timeout;
  private previewHydrateTimer?: NodeJS.Timeout;
  private previewHydrateQueue: string[] = [];
  private previewHydrating = false;
  private hasScanned = false;
  private watching = false;
  private scanController?: AbortController;
  constructor(readonly options: SessionIndexOptions) {
    super();
    if (options.cachePath) {
      this.cacheStore = new JsonStore(options.cachePath, emptyPersistedSessionIndex, normalizePersistedSessionIndex);
    }
  }

  async scan(options: { incremental?: boolean } = {}): Promise<SessionRecord[]> {
    if (this.scanWork) return this.scanWork;
    const controller = new AbortController();
    this.scanController = controller;
    const work = this.scanOnce(options.incremental === true, controller.signal);
    this.scanWork = work;
    try {
      return await work;
    } finally {
      if (this.scanWork === work) this.scanWork = undefined;
      if (this.scanController === controller) this.scanController = undefined;
    }
  }

  private async scanOnce(incremental: boolean, signal: AbortSignal): Promise<SessionRecord[]> {
    // Keep archive discovery itself single-file-system-operation-at-a-time.
    // Walking Claude and Codex roots concurrently looks harmless in Node CPU
    // metrics but causes two independent directory/read bursts (and two
    // Defender inspection streams) on Windows.
    const persisted = await (this.cacheStore?.get().catch(emptyPersistedSessionIndex) ?? emptyPersistedSessionIndex());
    const claude = await walkJsonl(
      this.options.claudeRoot,
      path => !path.replaceAll("\\", "/").includes("/subagents/") && !basename(path).startsWith("agent-"),
      allowClaudeDirectory,
      signal,
    );
    const codex = signal.aborted
      ? []
      : await walkJsonl(this.options.codexRoot, path => basename(path).startsWith("rollout-"), undefined, signal);
    if (signal.aborted) return this.list();
    const discovered = new Map<string, AgentKind>([
      ...claude.map(path => [path, "claude" as const] as const),
      ...codex.map(path => [path, "codex" as const] as const),
    ]);
    // A persisted path is only trusted after the symlink-safe directory walk
    // found the same file under the configured source root. The cache saves
    // JSONL parsing, never path validation/discovery.
    const existingByPath = new Map<string, SessionRecord>();
    for (const record of persisted.records) {
      if (discovered.get(record.path) === record.agent) existingByPath.set(record.path, record);
    }
    for (const record of this.records.values()) existingByPath.set(record.path, record);
    const cachedComplete = new Set(
      persisted.previewComplete.filter(path => discovered.has(path)),
    );
    for (const path of this.previewComplete) cachedComplete.add(path);
    this.previewComplete = cachedComplete;
    const cachedScanned = new Set(
      persisted.previewScanned.filter(path => discovered.has(path)),
    );
    for (const path of this.previewScanned) cachedScanned.add(path);
    this.previewScanned = cachedScanned;
    const checkpointByPath = new Map(existingByPath);
    let coldScanned = 0;
    const scanned = await mapWithConcurrency(
      [...claude.map(path => ({ path, agent: "claude" as const })), ...codex.map(path => ({ path, agent: "codex" as const }))],
      SESSION_SCAN_CONCURRENCY,
      async ({ path, agent }) => {
        if (signal.aborted) return null;
        let record: SessionRecord | null = null;
        let didColdScan = false;
        try {
          const existing = existingByPath.get(path);
          if (existing) {
            const info = await stat(path);
            if (info.size === existing.size && info.mtime.toISOString() === existing.mtime) {
              record = existing;
            }
            if (info.size > existing.size) {
              const latest = latestMeaningDetail(await readAppendLines(path, existing.size, info.size), existing.agent);
              const useLatest = latest.priority > 0 && !!latest.preview;
              record = {
                ...existing,
                size: info.size,
                mtime: info.mtime.toISOString(),
                preview: useLatest ? latest.preview : existing.preview,
                lastTurnAt: useLatest && latest.preview ? latest.lastTurnAt : existing.lastTurnAt,
              };
            }
          }
          if (!record) {
            didColdScan = true;
            const previewBytes = this.options.deferColdPreviews ? 0 : SESSION_INITIAL_PREVIEW_BYTES;
            record = agent === "codex"
              ? await scanCodexFile(path, previewBytes)
              : await scanClaudeFile(path, previewBytes);
            if (record && previewBytes > 0) {
              this.previewScanned.add(record.path);
              if (record.preview || record.size <= SESSION_INITIAL_PREVIEW_BYTES) this.previewComplete.add(record.path);
            }
          }
        } catch {
          record = null;
        }

        if (record) checkpointByPath.set(path, record);
        else checkpointByPath.delete(path);
        if (incremental && record && !signal.aborted) this.upsert(record);

        if (didColdScan) {
          coldScanned += 1;
          if (
            coldScanned === 1 ||
            coldScanned % SESSION_COLD_SCAN_CHECKPOINT_EVERY === 0
          ) {
            await this.persistScanCheckpoint(checkpointByPath).catch(() => undefined);
          }
          await delay(
            Math.max(0, this.options.coldScanPaceMs ?? SESSION_COLD_SCAN_PACE_MS),
            signal,
          );
        }
        return record;
      },
    );
    if (signal.aborted) return this.list();
    const next = new Map<string, SessionRecord>();
    for (const record of scanned) if (record) next.set(record.id, record);
    if (incremental) {
      // The watcher starts before initial discovery so a newly-created or
      // appended session cannot fall through the gap. Preserve a watcher
      // refresh that raced a slower scan result instead of replacing it with
      // the older snapshot when the scan commits.
      for (const current of this.records.values()) {
        const candidate = next.get(current.id);
        const currentMtime = Date.parse(current.mtime);
        const candidateMtime = candidate ? Date.parse(candidate.mtime) : Number.NEGATIVE_INFINITY;
        if (
          !candidate
          || current.path !== candidate.path
          || current.size > candidate.size
          || currentMtime > candidateMtime
        ) {
          next.set(current.id, current);
        }
      }
    }
    const presentPaths = new Set([...next.values()].map(record => record.path));
    for (const path of this.previewComplete) if (!presentPaths.has(path)) this.previewComplete.delete(path);
    for (const path of this.previewScanned) if (!presentPaths.has(path)) this.previewScanned.delete(path);
    this.records = next;
    this.recordsByPath = new Map([...next.values()].map(record => [record.path, record]));
    this.previewHydrateQueue = this.options.deferColdPreviews
      ? this.list()
        .filter(record => !this.previewScanned.has(record.path))
        .slice(0, SESSION_PREVIEW_HYDRATE_LIMIT)
        .map(record => record.path)
      : [];
    this.hasScanned = true;
    await this.persistCache();
    return this.list();
  }

  private async persistScanCheckpoint(recordsByPath: ReadonlyMap<string, SessionRecord>): Promise<void> {
    if (!this.cacheStore) return;
    const paths = new Set(recordsByPath.keys());
    await this.cacheStore.put({
      version: 1,
      records: [...recordsByPath.values()],
      previewComplete: [...this.previewComplete].filter(path => paths.has(path)),
      previewScanned: [...this.previewScanned].filter(path => paths.has(path)),
    });
  }

  private async persistCache(): Promise<void> {
    if (!this.cacheStore || !this.hasScanned) return;
    await this.cacheStore.put({
      version: 1,
      records: [...this.records.values()],
      previewComplete: [...this.previewComplete],
      previewScanned: [...this.previewScanned],
    });
  }

  private scheduleCacheWrite(): void {
    if (!this.cacheStore || !this.hasScanned) return;
    if (this.cacheWriteTimer) return;
    this.cacheWriteTimer = setTimeout(() => {
      this.cacheWriteTimer = undefined;
      void this.persistCache().catch(() => undefined);
    }, 2_000);
    this.cacheWriteTimer.unref?.();
  }

  private schedulePreviewHydration(): void {
    if (
      !this.options.deferColdPreviews ||
      this.previewHydrateTimer ||
      this.previewHydrating ||
      !this.previewHydrateQueue.length
    ) return;
    this.previewHydrateTimer = setTimeout(() => {
      this.previewHydrateTimer = undefined;
      void this.hydrateNextPreview();
    }, SESSION_PREVIEW_HYDRATE_INTERVAL_MS);
    this.previewHydrateTimer.unref?.();
  }

  private async hydrateNextPreview(): Promise<void> {
    if (this.previewHydrating) return;
    const path = this.previewHydrateQueue.shift();
    if (!path) return;
    this.previewHydrating = true;
    try {
      const cached = this.recordsByPath.get(path);
      if (!cached || this.previewScanned.has(path)) return;
      const validated = await this.validatedPath(path, cached.agent);
      const refreshed = cached.agent === "codex"
        ? await scanCodexFile(validated.path, SESSION_INITIAL_PREVIEW_BYTES)
        : await scanClaudeFile(validated.path, SESSION_INITIAL_PREVIEW_BYTES);
      if (!refreshed) return;
      this.previewScanned.add(path);
      if (refreshed.preview || refreshed.size <= SESSION_INITIAL_PREVIEW_BYTES) this.previewComplete.add(path);
      if (refreshed.id !== cached.id) {
        const removed = this.deleteRecord(cached.id);
        if (removed) this.emit("removed", removed);
      }
      this.upsert(refreshed);
    } catch {
      // A watcher event or the next backend restart can retry a file that was
      // being replaced while the low-priority hydration read ran.
    } finally {
      this.previewHydrating = false;
      this.schedulePreviewHydration();
    }
  }

  list(): SessionRecord[] {
    return [...this.records.values()].sort((a, b) => {
      const aTime = effectiveSessionTime(a); const bTime = effectiveSessionTime(b);
      return bTime - aTime || a.id.localeCompare(b.id);
    });
  }
  get(id: string): SessionRecord | undefined { return this.records.get(id); }
  private async validatedPath(path: string, expectedAgent?: AgentKind): Promise<{ path: string; agent: AgentKind }> {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("Unsafe session path");
    const [actualPath, claudeRoot, codexRoot] = await Promise.all([
      realpath(path),
      realpath(this.options.claudeRoot).catch(() => resolve(this.options.claudeRoot)),
      realpath(this.options.codexRoot).catch(() => resolve(this.options.codexRoot)),
    ]);
    const inClaude = isWithin(resolve(claudeRoot), resolve(actualPath));
    const inCodex = isWithin(resolve(codexRoot), resolve(actualPath));
    const agent = expectedAgent
      ?? (inCodex && basename(actualPath).startsWith("rollout-") ? "codex" : inClaude ? "claude" : inCodex ? "codex" : undefined);
    if (!agent || (agent === "claude" ? !inClaude : !inCodex)) throw new Error("Session escaped its source root");
    return { path: actualPath, agent };
  }
  async resolve(id: string): Promise<SessionRecord | undefined> {
    const cached = this.records.get(id); if (!cached) return undefined;
    try {
      const validated = await this.validatedPath(cached.path, cached.agent);
      const info = await stat(validated.path);
      if (
        info.size === cached.size
        && info.mtime.toISOString() === cached.mtime
        && this.previewComplete.has(cached.path)
      ) return cached;
      const refreshed = cached.agent === "codex" ? await scanCodexFile(validated.path) : await scanClaudeFile(validated.path);
      if (refreshed) {
        this.previewScanned.add(refreshed.path);
        this.previewComplete.add(refreshed.path);
        if (refreshed.id !== id) {
          this.deleteRecord(id);
          this.emit("removed", cached);
          this.upsert(refreshed);
          return undefined;
        }
        this.upsert(refreshed);
        return refreshed;
      }
    } catch { /* stale cache entry */ }
    this.deleteRecord(id);
    return undefined;
  }
  /**
   * Validate a cached session path without rescanning transcript content.
   *
   * Interactive prompt/tail/subscribe calls only need a trustworthy path,
   * cwd, and agent. Rebuilding an up-to-16-MiB preview here made opening or
   * resuming a cold session contend with historical archive discovery.
   * Watchers continue to hydrate preview/lastTurnAt in the background.
   */
  async resolveLight(id: string): Promise<SessionRecord | undefined> {
    const cached = this.records.get(id);
    if (!cached) return undefined;
    try {
      const validated = await this.validatedPath(cached.path, cached.agent);
      const info = await stat(validated.path);
      const mtime = info.mtime.toISOString();
      if (
        validated.path === cached.path
        && info.size === cached.size
        && mtime === cached.mtime
      ) return cached;

      const refreshed: SessionRecord = {
        ...cached,
        path: validated.path,
        size: info.size,
        mtime,
      };
      if (
        cached.path !== refreshed.path
        && this.recordsByPath.get(cached.path)?.id === id
      ) this.recordsByPath.delete(cached.path);
      this.records.set(id, refreshed);
      this.recordsByPath.set(refreshed.path, refreshed);
      this.scheduleCacheWrite();
      return refreshed;
    } catch {
      this.deleteRecord(id);
      return undefined;
    }
  }
  async indexPath(
    path: string,
    expectedAgent: AgentKind,
    overrides: { parentSessionId?: string | null } = {},
  ): Promise<SessionRecord | undefined> {
    const validated = await this.validatedPath(path, expectedAgent);
    const record = expectedAgent === "codex"
      ? await scanCodexFile(validated.path)
      : await scanClaudeFile(validated.path);
    if (!record) return undefined;
    const indexed = overrides.parentSessionId === undefined
      ? record
      : { ...record, parentSessionId: overrides.parentSessionId };
    this.previewScanned.add(indexed.path);
    this.previewComplete.add(indexed.path);
    this.upsert(indexed);
    return indexed;
  }
  upsert(record: SessionRecord): void {
    const previous = this.records.get(record.id);
    const added = !previous;
    if (previous && previous.path !== record.path && this.recordsByPath.get(previous.path)?.id === record.id) {
      this.recordsByPath.delete(previous.path);
    }
    this.records.set(record.id, record);
    this.recordsByPath.set(record.path, record);
    this.scheduleCacheWrite();
    this.emit(added ? "added" : "touched", record);
  }
  private deleteRecord(id: string): SessionRecord | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    this.records.delete(id);
    if (this.recordsByPath.get(record.path)?.id === id) this.recordsByPath.delete(record.path);
    this.scheduleCacheWrite();
    return record;
  }
  remove(id: string): void {
    const removed = this.deleteRecord(id);
    if (removed) this.emit("removed", removed);
  }

  private async refreshPath(path: string, attempt = 0): Promise<void> {
    const existing = this.refreshes.get(path);
    if (existing) {
      const queuedAttempt = this.pendingRefreshes.get(path);
      this.pendingRefreshes.set(
        path,
        queuedAttempt === undefined ? attempt : Math.min(queuedAttempt, attempt),
      );
      return existing;
    }
    const work = (async () => {
      let nextAttempt = attempt;
      try {
        while (true) {
          await this.refreshPathOnce(path, nextAttempt);
          const queuedAttempt = this.pendingRefreshes.get(path);
          if (queuedAttempt === undefined) return;
          this.pendingRefreshes.delete(path);
          nextAttempt = queuedAttempt;
        }
      } finally {
        this.refreshes.delete(path);
        this.pendingRefreshes.delete(path);
      }
    })();
    this.refreshes.set(path, work);
    return work;
  }

  private async refreshPathOnce(path: string, attempt: number): Promise<void> {
    const cached = this.recordsByPath.get(path);
    if (cached) {
      try {
        const entry = await lstat(path);
        if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("Unsafe session path");
        const nextMtime = entry.mtime.toISOString();
        if (entry.size === cached.size && nextMtime === cached.mtime) return;
        if (entry.size > cached.size) {
          const latest = latestMeaningDetail(await readAppendLines(path, cached.size, entry.size), cached.agent);
          // Preview the latest meaningful visible message regardless of role.
          // A newly-appended user request must not leave an older assistant
          // response in the sidebar until another assistant line arrives.
          const useLatest = latest.priority > 0 && !!latest.preview;
          const updated: SessionRecord = {
            ...cached,
            size: entry.size,
            mtime: nextMtime,
            preview: useLatest ? latest.preview : cached.preview,
            lastTurnAt: useLatest && latest.preview ? latest.lastTurnAt : cached.lastTurnAt,
          };
          this.upsert(updated);
          return;
        }
        // Same-size rewrites and truncations are exceptional mutations. They
        // need a ground-truth rescan, but must not penalize ordinary appends.
      } catch {
        const removed = this.recordsByPath.get(path);
        if (removed) {
          this.deleteRecord(removed.id);
          this.previewComplete.delete(path);
          this.previewScanned.delete(path);
          this.emit("removed", removed);
        }
        return;
      }
    }

    let validated: { path: string; agent: AgentKind };
    try {
      validated = await this.validatedPath(path);
    } catch {
      const removed = this.recordsByPath.get(path);
      if (removed) {
        this.deleteRecord(removed.id);
        this.emit("removed", removed);
      }
      return;
    }
    let file: SessionRecord | null = null;
    try {
      const previewBytes = cached ? BACK_SCAN_MAX : SESSION_INITIAL_PREVIEW_BYTES;
      file = validated.agent === "codex"
        ? await scanCodexFile(validated.path, previewBytes)
        : await scanClaudeFile(validated.path, previewBytes);
    } catch { /* retry add */ }
    if (file) {
      this.previewScanned.add(file.path);
      if (file.preview || cached || file.size <= SESSION_INITIAL_PREVIEW_BYTES) this.previewComplete.add(file.path);
      const duplicate = this.recordsByPath.get(path);
      if (duplicate && duplicate.id !== file.id) {
        this.deleteRecord(duplicate.id);
        this.emit("removed", duplicate);
      }
      this.upsert(file);
      return;
    }
    const retry = [150, 300, 600, 1000, 1500][attempt];
    if (retry !== undefined && this.watching) {
      const key = `retry:${path}`;
      const old = this.timers.get(key);
      if (old) clearTimeout(old);
      const timer = setTimeout(() => {
        this.timers.delete(key);
        if (this.watching) void this.refreshPath(path, attempt + 1);
      }, retry);
      timer.unref?.();
      this.timers.set(key, timer);
    }
  }

  async start(): Promise<void> {
    if (this.watchers.length) return;
    this.watching = true;
    const queue = (path: string) => {
      if (!this.watching) return;
      const old = this.timers.get(path); if (old) clearTimeout(old);
      const timer = setTimeout(() => {
        this.timers.delete(path);
        if (this.watching) void this.refreshPath(path);
      }, 50);
      timer.unref?.();
      this.timers.set(path, timer);
    };
    const ignored = (path: string, isFile = true) => {
      const normalized = path.replaceAll("\\", "/");
      return normalized.includes("/subagents/") || (isFile && extname(path) !== ".jsonl");
    };

    if (process.platform === "win32") {
      // Node's native recursive watcher maps to one ReadDirectoryChangesW
      // subscription per root. Chokidar must first enumerate the whole archive
      // to construct its watcher graph, duplicating the cold scan in the
      // background just after the server appears ready. Avoid that invisible
      // second traversal on Windows; refreshPath still realpath-validates every
      // reported path and the quiet poller remains the NFS/missed-event fallback.
      for (const root of [this.options.claudeRoot, this.options.codexRoot]) {
        try {
          const watcher = watchFs(root, { recursive: true }, (_event, filename) => {
            if (!filename) return;
            const path = resolve(root, filename.toString());
            if (!ignored(path)) queue(path);
          });
          // Filesystem races and disconnected network homes must never surface
          // as an unhandled EventEmitter error.
          watcher.on("error", () => undefined);
          this.watchers.push(watcher);
        } catch {
          // The poller below still provides conservative discovery/refresh.
        }
      }
    } else {
      const watcher = chokidar.watch([this.options.claudeRoot, this.options.codexRoot], {
        ignoreInitial: true, followSymlinks: false, ignored: (path, stats) => {
          return ignored(path, stats?.isFile() === true);
        },
      });
      watcher.on("add", queue).on("change", queue).on("unlink", queue);
      this.watchers.push(watcher);
    }
    this.poller = setInterval(() => void this.poll(), SESSION_POLL_INTERVAL_MS);
    this.poller.unref?.();
    this.schedulePreviewHydration();
  }

  async stop(): Promise<void> {
    this.watching = false;
    this.scanController?.abort();
    this.pendingRefreshes.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.cacheWriteTimer) clearTimeout(this.cacheWriteTimer);
    this.cacheWriteTimer = undefined;
    if (this.previewHydrateTimer) clearTimeout(this.previewHydrateTimer);
    this.previewHydrateTimer = undefined;
    this.previewHydrateQueue = [];
    if (this.poller) clearInterval(this.poller);
    this.poller = undefined;
    const watchers = this.watchers.splice(0);
    await Promise.all(watchers.map(async watcher => {
      try { await watcher.close(); } catch { /* already closed / disconnected */ }
    }));
    await this.persistCache().catch(() => undefined);
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const records = [...this.records.values()];
      const batch: SessionRecord[] = [];
      if (records.length) {
        const start = this.pollCursor % records.length;
        const count = Math.min(SESSION_POLL_BATCH_SIZE, records.length);
        for (let offset = 0; offset < count; offset++) batch.push(records[(start + offset) % records.length]!);
        this.pollCursor = (start + count) % records.length;
      } else {
        this.pollCursor = 0;
      }
      await mapWithConcurrency(batch, SESSION_SCAN_CONCURRENCY, async record => {
        try {
          const info = await stat(record.path);
          if (info.size !== record.size || info.mtime.toISOString() !== record.mtime) await this.refreshPath(record.path);
        } catch {
          if (this.records.get(record.id)?.path === record.path) { this.deleteRecord(record.id); this.emit("removed", record); }
        }
      });
      // Periodically discover a new Codex date directory even if an NFS watcher
      // missed both the directory and file creation events.
      if (++this.pollTick % SESSION_DISCOVERY_EVERY_POLLS === 0) {
        const known = new Set([...this.records.values()].map(record => record.path));
        const [claude, codex] = await Promise.all([
          walkJsonl(
            this.options.claudeRoot,
            path => !path.replaceAll("\\", "/").includes("/subagents/") && !basename(path).startsWith("agent-"),
            allowClaudeDirectory,
          ),
          walkJsonl(this.options.codexRoot, path => basename(path).startsWith("rollout-")),
        ]);
        await mapWithConcurrency(
          [...claude, ...codex].filter(path => !known.has(path)),
          SESSION_SCAN_CONCURRENCY,
          async path => this.refreshPath(path),
        );
      }
    } finally { this.polling = false; }
  }
}

export function effectiveSessionTime(session: Pick<SessionRecord, "lastTurnAt" | "mtime">): number {
  const meaningful = session.lastTurnAt ? Date.parse(session.lastTurnAt) : Number.NaN;
  if (Number.isFinite(meaningful)) return meaningful;
  const modified = Date.parse(session.mtime); return Number.isFinite(modified) ? modified : 0;
}
