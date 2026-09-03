import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { SessionRecord } from "../types.js";
import { searchableRecordPrefix, searchableRecordText } from "./search-text.js";

const SCHEMA_VERSION = 7;
const INDEX_READ_CHUNK_BYTES = 256 * 1024;
const INDEX_PARSE_LINE_MAX_BYTES = 2 * 1024 * 1024;
const INDEX_TEXT_CHUNK_CHARS = 128 * 1024;
const INDEX_TEXT_CHUNK_OVERLAP_CHARS = 256;
const INDEX_YIELD_EVERY_BYTES = 4 * 1024 * 1024;
const INDEX_MAX_CANDIDATES = 100_000;
const INDEX_MAX_CANDIDATE_ROWS = 200_000;
const INDEX_MAX_QUERY_GRAMS = 12;
const INDEX_GRAM_HASH_MASK = 0xfffff;
const INDEX_BIGRAM_HASH_FLAG = INDEX_GRAM_HASH_MASK + 1;
const INDEX_GRAM_BITMAP_WORDS = INDEX_BIGRAM_HASH_FLAG * 2 / 32;
const INDEX_SIGNATURE_BYTES = 64;
const INDEX_MAX_DATABASE_BYTES = 8 * 1024 * 1024 * 1024;
const INDEX_SEARCH_CATCHUP_MAX_FILES = 8;
const INDEX_SEARCH_CATCHUP_MAX_APPEND_BYTES = 32 * 1024 * 1024;
const INDEX_SEARCH_CATCHUP_WAIT_MS = 500;

interface IndexedFileRow {
  path_key: string;
  source_path: string;
  session_id: string;
  source_size: number;
  source_mtime: string;
  indexed_size: number;
  line_count: number;
  status: "ready" | "partial";
  tail_signature: Uint8Array | null;
}

interface CandidateRow {
  path_key: string;
  line_index: number;
  byte_offset: number;
  byte_length: number;
}

export interface ContentIndexCandidate {
  path: string;
  lineIndex: number;
  byteOffset: number;
  byteLength: number;
}

export interface ContentIndexCandidateResult {
  coveredPaths: Set<string>;
  candidates: ContentIndexCandidate[];
  overflowed: boolean;
  elapsedMs: number;
}

export interface ContentSearchIndexStats {
  readyFiles: number;
  unsupportedFiles: number;
  indexedBytes: number;
  records: number;
  databaseBytes: number;
  pendingFiles: number;
  building: boolean;
}

export interface ContentSearchIndexCatchup {
  eligibleFiles: number;
  freshenedFiles: number;
  elapsedMs: number;
}

export type ContentSearchIndexEvent =
  | ({ type: "progress" } & ContentSearchIndexStats)
  | { type: "disabled"; reason: string }
  | { type: "error"; path?: string; message: string };

function pathKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLocaleLowerCase() : absolute;
}

function asNumber(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value);
}

function isAsciiDigit(value: number): boolean {
  return value >= 0x30 && value <= 0x39;
}

function isAsciiLetter(value: number): boolean {
  return (value >= 0x41 && value <= 0x5a)
    || (value >= 0x61 && value <= 0x7a);
}

function shouldIndexBigram(left: number, right: number): boolean {
  return left > 0x7f
    || right > 0x7f
    || (isAsciiDigit(left) && isAsciiLetter(right))
    || (isAsciiLetter(left) && isAsciiDigit(right));
}

function encodedBigram(left: string, right: string): string {
  return `g${Buffer.from(`${left}${right}`, "utf8").toString("hex")}`;
}

function gramHashCodePoints(first: number, second: number, third?: number): number {
  return third === undefined
    ? (Math.imul(first, 257) + second) & INDEX_GRAM_HASH_MASK
    : (Math.imul(first, 66_049) + Math.imul(second, 257) + third) & INDEX_GRAM_HASH_MASK;
}

function gramHash(value: string): number {
  const characters = [...value];
  return gramHashCodePoints(
    characters[0]!.codePointAt(0)!,
    characters[1]!.codePointAt(0)!,
    characters[2]?.codePointAt(0),
  );
}

function encodedGramHash(prefix: "b" | "t", value: string): string {
  return `${prefix}${gramHash(value).toString(16).padStart(5, "0")}`;
}

function encodedStoredGramHash(value: number): string {
  const bigram = value >= INDEX_BIGRAM_HASH_FLAG;
  const hash = bigram ? value - INDEX_BIGRAM_HASH_FLAG : value;
  return `${bigram ? "b" : "t"}${hash.toString(16).padStart(5, "0")}`;
}

function indexedBigramTerms(text: string): string {
  const terms = new Set<string>();
  let previous: string | undefined;
  for (const current of text) {
    if (
      previous !== undefined
      && shouldIndexBigram(
        previous.codePointAt(0)!,
        current.codePointAt(0)!,
      )
    ) {
      terms.add(encodedBigram(previous, current));
    }
    previous = current;
  }
  return [...terms].join(" ");
}

function characterCountAtLeast(text: string, minimum: number): boolean {
  let count = 0;
  for (const _character of text) {
    if (++count >= minimum) return true;
  }
  return false;
}

function trailingCharacters(text: string, count: number): string {
  if (text.length <= count) return text;
  const characters = [...text];
  return characters.slice(-count).join("");
}

function selectedTrigrams(token: string): string[] {
  const characters = [...token];
  const all: string[] = [];
  for (let index = 0; index + 2 < characters.length; index++) {
    all.push(`${characters[index]}${characters[index + 1]}${characters[index + 2]}`);
  }
  const unique = [...new Set(all)];
  if (unique.length <= INDEX_MAX_QUERY_GRAMS) return unique;
  const selected = new Set<string>();
  for (let index = 0; index < INDEX_MAX_QUERY_GRAMS; index++) {
    selected.add(unique[Math.round(index * (unique.length - 1) / (INDEX_MAX_QUERY_GRAMS - 1))]!);
  }
  return [...selected];
}

function quoteFts(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

async function readTailSignature(path: string, end: number): Promise<Buffer> {
  const length = Math.min(INDEX_SIGNATURE_BYTES, Math.max(0, end));
  if (!length) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(length);
  const handle = await open(path, "r");
  try {
    const result = await handle.read(buffer, 0, length, end - length);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

function sameBytes(left: Uint8Array | null, right: Uint8Array): boolean {
  return left !== null && Buffer.from(left).equals(right);
}

export class ContentSearchIndex {
  static async open(
    databasePath: string,
    onEvent?: (event: ContentSearchIndexEvent) => void,
  ): Promise<ContentSearchIndex | null> {
    try {
      const sqlite = await import("node:sqlite");
      const database = new sqlite.DatabaseSync(databasePath);
      const index = new ContentSearchIndex(databasePath, database, onEvent);
      index.initialize();
      return index;
    } catch (error) {
      onEvent?.({
        type: "disabled",
        reason: error instanceof Error ? error.message : "node:sqlite is unavailable",
      });
      return null;
    }
  }

  private readonly pending = new Map<string, SessionRecord | null>();
  private readonly abortController = new AbortController();
  private work: Promise<void> | undefined;
  private active: { key: string; session: SessionRecord | null } | undefined;
  private closed = false;
  private disabled = false;
  private lastProgressAt = 0;

  private constructor(
    private readonly databasePath: string,
    private readonly database: DatabaseSync,
    private readonly onEvent?: (event: ContentSearchIndexEvent) => void,
  ) {}

  private initialize(): void {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;
      PRAGMA cache_size = -65536;
    `);
    const version = asNumber((this.database.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined)?.user_version);
    if (version !== SCHEMA_VERSION) {
      this.database.exec(`
        DROP TABLE IF EXISTS record_trigrams;
        DROP TABLE IF EXISTS record_bigrams;
        DROP TABLE IF EXISTS record_oversized_grams;
        DROP TABLE IF EXISTS records;
        DROP TABLE IF EXISTS files;
      `);
    }
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path_key TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        session_id TEXT NOT NULL,
        source_size INTEGER NOT NULL,
        source_mtime TEXT NOT NULL,
        indexed_size INTEGER NOT NULL,
        line_count INTEGER NOT NULL,
        status TEXT NOT NULL,
        tail_signature BLOB
      );
      CREATE TABLE IF NOT EXISTS records (
        record_id INTEGER PRIMARY KEY AUTOINCREMENT,
        path_key TEXT NOT NULL,
        line_index INTEGER NOT NULL,
        byte_offset INTEGER NOT NULL,
        byte_length INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS records_path ON records(path_key);
      CREATE VIRTUAL TABLE IF NOT EXISTS record_trigrams USING fts5(
        text,
        content='',
        tokenize='trigram',
        detail='none',
        contentless_delete=1
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS record_bigrams USING fts5(
        grams,
        content='',
        tokenize='unicode61',
        detail='none',
        contentless_delete=1
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS record_oversized_grams USING fts5(
        grams,
        content='',
        tokenize='unicode61',
        detail='none',
        contentless_delete=1
      );
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  }

  sync(sessions: readonly SessionRecord[]): void {
    if (this.closed || this.disabled) return;
    const current = new Set(sessions.map(session => pathKey(session.path)));
    const existing = this.database.prepare("SELECT path_key FROM files").all() as Array<{ path_key: string }>;
    for (const row of existing) {
      if (!current.has(row.path_key)) this.pending.set(row.path_key, null);
    }
    const ordered = [...sessions].sort((left, right) => right.size - left.size);
    for (const session of ordered) this.schedule(session, false);
    this.startWork();
  }

  schedule(session: SessionRecord, start = true): void {
    if (this.closed || this.disabled) return;
    const key = pathKey(session.path);
    if (
      this.active?.key === key
      && this.active.session?.size === session.size
      && this.active.session.mtime === session.mtime
    ) return;
    const row = this.fileRow(key);
    if (
      row
      && row.source_size === session.size
      && row.source_mtime === session.mtime
      && row.status === "ready"
    ) return;
    this.pending.set(key, session);
    if (start) this.startWork();
  }

  remove(path: string): void {
    if (this.closed || this.disabled) return;
    this.pending.set(pathKey(path), null);
    this.startWork();
  }

  private startWork(): void {
    if (this.closed || this.disabled || this.work || !this.pending.size) return;
    const work = this.runWork();
    this.work = work;
    void work.finally(() => {
      if (this.work === work) this.work = undefined;
      if (!this.closed && !this.disabled && this.pending.size) this.startWork();
    }).catch(() => undefined);
  }

  private async runWork(): Promise<void> {
    while (!this.closed && !this.disabled && this.pending.size) {
      const entry = this.pending.entries().next().value as [string, SessionRecord | null] | undefined;
      if (!entry) return;
      const [key, session] = entry;
      this.pending.delete(key);
      this.active = { key, session };
      try {
        if (session) await this.indexSession(session);
        else this.deleteFile(key);
      } catch (error) {
        this.onEvent?.({
          type: "error",
          path: session?.path,
          message: error instanceof Error ? error.message : "content index update failed",
        });
      } finally {
        if (this.active?.key === key) this.active = undefined;
      }
      await this.emitProgress();
      await new Promise<void>(resolveImmediate => setImmediate(resolveImmediate));
    }
  }

  private fileRow(key: string): IndexedFileRow | undefined {
    return this.database.prepare("SELECT * FROM files WHERE path_key = ?").get(key) as IndexedFileRow | undefined;
  }

  private deleteFile(key: string): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const selectIds = "SELECT record_id FROM records WHERE path_key = ?";
      this.database.prepare(`DELETE FROM record_trigrams WHERE rowid IN (${selectIds})`).run(key);
      this.database.prepare(`DELETE FROM record_bigrams WHERE rowid IN (${selectIds})`).run(key);
      this.database.prepare(`DELETE FROM record_oversized_grams WHERE rowid IN (${selectIds})`).run(key);
      this.database.prepare("DELETE FROM records WHERE path_key = ?").run(key);
      this.database.prepare("DELETE FROM files WHERE path_key = ?").run(key);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private async indexSession(session: SessionRecord): Promise<void> {
    if (this.abortController.signal.aborted) return;
    const key = pathKey(session.path);
    const previous = this.fileRow(key);
    let append = false;
    let startOffset = 0;
    let lineIndex = 0;
    if (
      previous
      && session.size > previous.source_size
      && session.size >= previous.indexed_size
    ) {
      const signature = await readTailSignature(session.path, previous.indexed_size);
      append = sameBytes(previous.tail_signature, signature);
      if (append) {
        startOffset = previous.indexed_size;
        lineIndex = previous.line_count;
      }
    }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!append) {
        const selectIds = "SELECT record_id FROM records WHERE path_key = ?";
        this.database.prepare(`DELETE FROM record_trigrams WHERE rowid IN (${selectIds})`).run(key);
        this.database.prepare(`DELETE FROM record_bigrams WHERE rowid IN (${selectIds})`).run(key);
        this.database.prepare(`DELETE FROM record_oversized_grams WHERE rowid IN (${selectIds})`).run(key);
        this.database.prepare("DELETE FROM records WHERE path_key = ?").run(key);
      }
      const scanned = await this.scanFile(session, key, startOffset, lineIndex);
      const signature = await readTailSignature(session.path, scanned.indexedSize);
      this.database.prepare(`
        INSERT INTO files (
          path_key, source_path, session_id, source_size, source_mtime,
          indexed_size, line_count, status, tail_signature
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path_key) DO UPDATE SET
          source_path=excluded.source_path,
          session_id=excluded.session_id,
          source_size=excluded.source_size,
          source_mtime=excluded.source_mtime,
          indexed_size=excluded.indexed_size,
          line_count=excluded.line_count,
          status=excluded.status,
          tail_signature=excluded.tail_signature
      `).run(
        key,
        session.path,
        session.id,
        session.size,
        session.mtime,
        scanned.indexedSize,
        scanned.lineCount,
        scanned.indexedSize === session.size ? "ready" : "partial",
        signature,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private async scanFile(
    session: SessionRecord,
    key: string,
    startOffset: number,
    initialLineIndex: number,
  ): Promise<{ indexedSize: number; lineCount: number }> {
    if (startOffset >= session.size) {
      return { indexedSize: session.size, lineCount: initialLineIndex };
    }
    const insertRecord = this.database.prepare(`
      INSERT INTO records(path_key, line_index, byte_offset, byte_length)
      VALUES (?, ?, ?, ?)
    `);
    const insertTrigrams = this.database.prepare("INSERT INTO record_trigrams(rowid, text) VALUES (?, ?)");
    const insertBigrams = this.database.prepare("INSERT INTO record_bigrams(rowid, grams) VALUES (?, ?)");
    const insertOversizedGrams = this.database.prepare(
      "INSERT INTO record_oversized_grams(rowid, grams) VALUES (?, ?)",
    );
    let absoluteOffset = startOffset;
    let lineStart = startOffset;
    let lineIndex = initialLineIndex;
    let indexedSize = startOffset;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let rawDecoder: StringDecoder | null = null;
    let rawOversized = false;
    let rawSearchable = false;
    let rawPrevious: number | undefined;
    let rawBeforePrevious: number | undefined;
    let rawGramBitmap: Uint32Array | null = null;
    let bytesSinceYield = 0;

    const insertText = (
      text: string,
      byteOffset: number,
      byteLength: number,
      overlap: string,
    ): string => {
      let cursor = 0;
      let currentOverlap = overlap;
      while (cursor < text.length) {
        let end = Math.min(text.length, cursor + INDEX_TEXT_CHUNK_CHARS);
        if (
          end < text.length
          && end > cursor
          && /[\uD800-\uDBFF]/u.test(text[end - 1]!)
          && /[\uDC00-\uDFFF]/u.test(text[end]!)
        ) end--;
        const indexedText = `${currentOverlap}${text.slice(cursor, end)}`;
        const hasTrigrams = characterCountAtLeast(indexedText, 3);
        const bigrams = characterCountAtLeast(indexedText, 2)
          ? indexedBigramTerms(indexedText)
          : "";
        if (hasTrigrams || bigrams) {
          const inserted = insertRecord.run(key, lineIndex, byteOffset, byteLength);
          const recordId = inserted.lastInsertRowid;
          if (hasTrigrams) insertTrigrams.run(recordId, indexedText);
          if (bigrams) insertBigrams.run(recordId, bigrams);
        }
        currentOverlap = trailingCharacters(indexedText, INDEX_TEXT_CHUNK_OVERLAP_CHARS);
        cursor = end;
      }
      return currentOverlap;
    };

    const processBufferedLine = (lineBuffer: Buffer, byteOffset: number, byteLength: number) => {
      let raw = lineBuffer.toString("utf8");
      if (raw.endsWith("\r")) raw = raw.slice(0, -1);
      const parsed = searchableRecordText(raw);
      if (parsed) insertText(parsed.haystack, byteOffset, byteLength, "");
    };

    const collectRawGrams = (text: string) => {
      if (!text) return;
      if (!rawGramBitmap) rawGramBitmap = new Uint32Array(INDEX_GRAM_BITMAP_WORDS);
      for (let index = 0; index < text.length; index++) {
        const firstUnit = text.charCodeAt(index);
        const current = (
          firstUnit >= 0xd800
          && firstUnit <= 0xdbff
          && index + 1 < text.length
          && text.charCodeAt(index + 1) >= 0xdc00
          && text.charCodeAt(index + 1) <= 0xdfff
        )
          ? text.codePointAt(index++)!
          : firstUnit;
        if (rawPrevious !== undefined) {
          if (shouldIndexBigram(rawPrevious, current)) {
            const bigram = INDEX_BIGRAM_HASH_FLAG + gramHashCodePoints(rawPrevious, current);
            const word = bigram >>> 5;
            rawGramBitmap[word] = rawGramBitmap[word]! | (1 << (bigram & 31));
          }
          if (rawBeforePrevious !== undefined) {
            const trigram = gramHashCodePoints(rawBeforePrevious, rawPrevious, current);
            const word = trigram >>> 5;
            rawGramBitmap[word] = rawGramBitmap[word]! | (1 << (trigram & 31));
          }
        }
        rawBeforePrevious = rawPrevious;
        rawPrevious = current;
      }
    };

    const feedRawBuffer = (buffer: Buffer) => {
      if (!buffer.length) return;
      if (!rawDecoder) rawDecoder = new StringDecoder("utf8");
      collectRawGrams(rawDecoder.write(buffer).toLocaleLowerCase());
    };

    const feedLineSegment = (segment: Buffer) => {
      if (rawOversized) {
        if (rawSearchable) feedRawBuffer(segment);
        return;
      }
      if (pendingBytes + segment.length <= INDEX_PARSE_LINE_MAX_BYTES) {
        if (segment.length) pending.push(segment);
        pendingBytes += segment.length;
        return;
      }
      rawOversized = true;
      const prefix = Buffer.concat(pending, pendingBytes)
        .subarray(0, 64 * 1024)
        .toString("utf8");
      rawSearchable = searchableRecordPrefix(prefix);
      if (rawSearchable) {
        rawDecoder = new StringDecoder("utf8");
        for (const buffered of pending) feedRawBuffer(buffered);
      }
      pending = [];
      pendingBytes = 0;
      if (rawSearchable) feedRawBuffer(segment);
    };

    const finishLine = (byteLength: number) => {
      if (rawOversized) {
        if (rawSearchable && rawDecoder) {
          collectRawGrams(rawDecoder.end().replace(/\r$/u, "").toLocaleLowerCase());
          if (rawGramBitmap) {
            const terms: string[] = [];
            for (let value = 0; value < INDEX_BIGRAM_HASH_FLAG * 2; value++) {
              if ((rawGramBitmap[value >>> 5]! & (1 << (value & 31))) !== 0) {
                terms.push(encodedStoredGramHash(value));
              }
            }
            const inserted = insertRecord.run(key, lineIndex, lineStart, byteLength);
            insertOversizedGrams.run(
              inserted.lastInsertRowid,
              terms.join(" "),
            );
          }
        }
      } else {
        const lineBuffer = pending.length === 1
          ? pending[0]!
          : Buffer.concat(pending, pendingBytes);
        processBufferedLine(lineBuffer, lineStart, byteLength);
      }
      pending = [];
      pendingBytes = 0;
      rawDecoder = null;
      rawOversized = false;
      rawSearchable = false;
      rawPrevious = undefined;
      rawBeforePrevious = undefined;
      rawGramBitmap = null;
    };

    const stream = createReadStream(session.path, {
      start: startOffset,
      end: session.size - 1,
      highWaterMark: INDEX_READ_CHUNK_BYTES,
      signal: this.abortController.signal,
    });
    for await (const value of stream) {
      if (this.abortController.signal.aborted) throw new Error("content index stopped");
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const chunkStart = absoluteOffset;
      let cursor = 0;
      for (let newline = chunk.indexOf(0x0a, cursor); newline >= 0; newline = chunk.indexOf(0x0a, cursor)) {
        const segment = chunk.subarray(cursor, newline);
        const byteLength = chunkStart + newline - lineStart;
        feedLineSegment(segment);
        finishLine(byteLength);
        lineIndex++;
        indexedSize = chunkStart + newline + 1;
        lineStart = indexedSize;
        cursor = newline + 1;
      }
      if (cursor < chunk.length) {
        feedLineSegment(chunk.subarray(cursor));
      }
      absoluteOffset += chunk.length;
      bytesSinceYield += chunk.length;
      if (bytesSinceYield >= INDEX_YIELD_EVERY_BYTES) {
        bytesSinceYield = 0;
        await new Promise<void>(resolveImmediate => setImmediate(resolveImmediate));
      }
    }
    if (pendingBytes || rawOversized) {
      const byteLength = session.size - lineStart;
      finishLine(byteLength);
      lineIndex++;
      indexedSize = session.size;
    }
    return { indexedSize, lineCount: lineIndex };
  }

  async catchUpAppends(
    sessions: readonly SessionRecord[],
    signal?: AbortSignal,
    waitMs = INDEX_SEARCH_CATCHUP_WAIT_MS,
  ): Promise<ContentSearchIndexCatchup> {
    const startedAt = Date.now();
    if (this.closed || this.disabled || signal?.aborted) {
      return { eligibleFiles: 0, freshenedFiles: 0, elapsedMs: 0 };
    }
    const eligible = sessions.filter(session => {
      const row = this.fileRow(pathKey(session.path));
      return Boolean(
        row
        && row.status === "ready"
        && row.indexed_size === row.source_size
        && session.size > row.source_size
        && session.size - row.source_size <= INDEX_SEARCH_CATCHUP_MAX_APPEND_BYTES,
      );
    });
    if (!eligible.length || eligible.length > INDEX_SEARCH_CATCHUP_MAX_FILES) {
      return { eligibleFiles: eligible.length, freshenedFiles: 0, elapsedMs: Date.now() - startedAt };
    }
    for (const session of eligible) this.schedule(session, false);
    this.startWork();
    const deadline = startedAt + Math.max(0, waitMs);
    let freshenedFiles = 0;
    while (!signal?.aborted && Date.now() < deadline) {
      freshenedFiles = eligible.filter(session => {
        const row = this.fileRow(pathKey(session.path));
        return Boolean(
          row
          && row.status === "ready"
          && row.source_size === session.size
          && row.source_mtime === session.mtime
          && row.indexed_size === session.size,
        );
      }).length;
      if (freshenedFiles === eligible.length) break;
      await new Promise<void>(resolveDelay => setTimeout(resolveDelay, 10));
    }
    return {
      eligibleFiles: eligible.length,
      freshenedFiles,
      elapsedMs: Date.now() - startedAt,
    };
  }

  async candidates(
    sessions: readonly SessionRecord[],
    token: string,
    signal?: AbortSignal,
  ): Promise<ContentIndexCandidateResult> {
    const startedAt = Date.now();
    if (signal?.aborted) throw Object.assign(new Error("Search superseded"), { name: "AbortError" });
    const rows = this.database.prepare("SELECT * FROM files WHERE status = 'ready'").all() as unknown as IndexedFileRow[];
    const byKey = new Map(sessions.map(session => [pathKey(session.path), session]));
    const coveredPaths = new Set<string>();
    for (const row of rows) {
      const session = byKey.get(row.path_key);
      if (
        session
        && row.source_size === session.size
        && row.source_mtime === session.mtime
        && row.indexed_size === session.size
      ) coveredPaths.add(row.path_key);
    }
    if (!coveredPaths.size) {
      return { coveredPaths, candidates: [], overflowed: false, elapsedMs: Date.now() - startedAt };
    }

    const characters = [...token.toLocaleLowerCase()];
    if (characters.length > INDEX_TEXT_CHUNK_OVERLAP_CHARS + 1) {
      return { coveredPaths: new Set(), candidates: [], overflowed: false, elapsedMs: Date.now() - startedAt };
    }
    const searches: Array<{ statement: StatementSync; matchQuery: string }> = [];
    if (characters.length >= 3) {
      const trigrams = selectedTrigrams(characters.join(""));
      if (!trigrams.length) {
        return { coveredPaths: new Set(), candidates: [], overflowed: false, elapsedMs: Date.now() - startedAt };
      }
      searches.push(
        {
          matchQuery: trigrams.map(quoteFts).join(" AND "),
          statement: this.database.prepare(`
            SELECT records.path_key, records.line_index, records.byte_offset, records.byte_length
            FROM record_trigrams
            JOIN records ON records.record_id = record_trigrams.rowid
            WHERE record_trigrams MATCH ?
            LIMIT ?
          `),
        },
        {
          matchQuery: trigrams.map(trigram => encodedGramHash("t", trigram)).join(" AND "),
          statement: this.database.prepare(`
            SELECT records.path_key, records.line_index, records.byte_offset, records.byte_length
            FROM record_oversized_grams
            JOIN records ON records.record_id = record_oversized_grams.rowid
            WHERE record_oversized_grams MATCH ?
            LIMIT ?
          `),
        },
      );
    } else if (
      characters.length === 2
      && shouldIndexBigram(
        characters[0]!.codePointAt(0)!,
        characters[1]!.codePointAt(0)!,
      )
    ) {
      const bigram = `${characters[0]!}${characters[1]!}`;
      searches.push(
        {
          matchQuery: encodedBigram(characters[0]!, characters[1]!),
          statement: this.database.prepare(`
            SELECT records.path_key, records.line_index, records.byte_offset, records.byte_length
            FROM record_bigrams
            JOIN records ON records.record_id = record_bigrams.rowid
            WHERE record_bigrams MATCH ?
            LIMIT ?
          `),
        },
        {
          matchQuery: encodedGramHash("b", bigram),
          statement: this.database.prepare(`
            SELECT records.path_key, records.line_index, records.byte_offset, records.byte_length
            FROM record_oversized_grams
            JOIN records ON records.record_id = record_oversized_grams.rowid
            WHERE record_oversized_grams MATCH ?
            LIMIT ?
          `),
        },
      );
    } else {
      return { coveredPaths: new Set(), candidates: [], overflowed: false, elapsedMs: Date.now() - startedAt };
    }

    const raw: CandidateRow[] = [];
    for (const search of searches) {
      const remaining = INDEX_MAX_CANDIDATE_ROWS - raw.length;
      const rowsForSearch = search.statement.all(
        search.matchQuery,
        remaining + 1,
      ) as unknown as CandidateRow[];
      if (rowsForSearch.length > remaining) {
        return {
          coveredPaths: new Set(),
          candidates: [],
          overflowed: true,
          elapsedMs: Date.now() - startedAt,
        };
      }
      raw.push(...rowsForSearch);
    }
    const candidates: ContentIndexCandidate[] = [];
    const seenCandidates = new Set<string>();
    for (const row of raw) {
      if (!coveredPaths.has(row.path_key)) continue;
      const session = byKey.get(row.path_key);
      if (!session) continue;
      const lineIndex = asNumber(row.line_index);
      const byteOffset = asNumber(row.byte_offset);
      const byteLength = asNumber(row.byte_length);
      const candidateKey = `${row.path_key}\0${lineIndex}\0${byteOffset}\0${byteLength}`;
      if (seenCandidates.has(candidateKey)) continue;
      seenCandidates.add(candidateKey);
      candidates.push({
        path: session.path,
        lineIndex,
        byteOffset,
        byteLength,
      });
      if (candidates.length > INDEX_MAX_CANDIDATES) {
        return {
          coveredPaths: new Set(),
          candidates: [],
          overflowed: true,
          elapsedMs: Date.now() - startedAt,
        };
      }
    }
    return { coveredPaths, candidates, overflowed: false, elapsedMs: Date.now() - startedAt };
  }

  async stats(): Promise<ContentSearchIndexStats> {
    const files = this.database.prepare(`
      SELECT
        SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready_files,
        SUM(CASE WHEN status = 'unsupported' THEN 1 ELSE 0 END) AS unsupported_files,
        SUM(CASE WHEN status = 'ready' THEN indexed_size ELSE 0 END) AS indexed_bytes
      FROM files
    `).get() as { ready_files?: unknown; unsupported_files?: unknown; indexed_bytes?: unknown } | undefined;
    const records = this.database.prepare("SELECT COUNT(*) AS count FROM records").get() as { count?: unknown } | undefined;
    let databaseBytes = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
      try { databaseBytes += (await stat(`${this.databasePath}${suffix}`)).size; } catch { /* absent */ }
    }
    return {
      readyFiles: asNumber(files?.ready_files ?? 0),
      unsupportedFiles: asNumber(files?.unsupported_files ?? 0),
      indexedBytes: asNumber(files?.indexed_bytes ?? 0),
      records: asNumber(records?.count ?? 0),
      databaseBytes,
      pendingFiles: this.pending.size,
      building: Boolean(this.work),
    };
  }

  private async emitProgress(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastProgressAt < 5_000) return;
    this.lastProgressAt = now;
    const stats = await this.stats();
    this.onEvent?.({ type: "progress", ...stats });
    if (stats.databaseBytes > INDEX_MAX_DATABASE_BYTES) {
      this.disabled = true;
      this.pending.clear();
      this.onEvent?.({
        type: "disabled",
        reason: `content index reached its ${Math.round(INDEX_MAX_DATABASE_BYTES / 1024 / 1024 / 1024)} GiB safety limit`,
      });
    }
  }

  async waitForIdle(): Promise<void> {
    while (this.work || (!this.disabled && this.pending.size)) {
      await this.work;
      if (!this.work && !this.disabled && this.pending.size) this.startWork();
    }
    await this.emitProgress(true);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.pending.clear();
    this.abortController.abort();
    await this.work;
    try { this.database.exec("PRAGMA optimize"); } catch { /* best effort */ }
    try { this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* best effort */ }
    this.database.close();
  }
}
