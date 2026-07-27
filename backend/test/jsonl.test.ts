import { describe, expect, it } from "vitest";
import { appendFile, mkdtemp, readFile, truncate, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearLineIndexMemoryCache,
  configureLineIndexPersistence,
  flushLineIndexPersistence,
  isRenderableClaudeLine,
  JsonlTailer,
  jsonlColdIndexConcurrency,
  jsonlIndexIoCounters,
  jsonlIndexCachePaths,
  jsonlIndexCacheSize,
  lineIndexCacheBytes,
  MAX_JSONL_RECORD_BYTES,
  MAX_LINE_INDEX_CACHE_ENTRIES,
  MAX_LINE_INDEX_CACHE_BYTES,
  MAX_READ_RANGE_LINES,
  MAX_READ_RESPONSE_BYTES,
  MAX_STREAM_BATCH_LINES,
  preserveIndexes,
  readRange,
  readTail,
  resetJsonlIndexIoCounters,
  snapshotJsonl,
  streamJsonlLines,
} from "../src/services/jsonl.js";

describe("JSONL indexing and tails", () => {
  it("filters Claude display records without renumbering physical indexes", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-render-filter-"));
    const path = join(root, "a.jsonl");
    const records = [
      { type: "user", message: { content: "hello" } },
      { type: "file-history-snapshot", snapshot: "large" },
      { type: "attachment", attachment: { type: "queued_command", prompt: "later" } },
      { type: "attachment", attachment: { type: "other" } },
      { type: "assistant", message: { content: [] } },
    ];
    await writeFile(path, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
    expect(preserveIndexes(await readRange(path, 0), isRenderableClaudeLine).map(line => line.index)).toEqual([0, 2, 4]);

    const events: any[] = [];
    const tailer = new JsonlTailer(path, {
      from: 0,
      pollMs: 60_000,
      filter: isRenderableClaudeLine,
    }, event => events.push(event));
    await tailer.start();
    expect(events.filter(event => event.type === "stream-batch").flatMap(event => event.lines).map(line => line.index)).toEqual([0, 2, 4]);
    await appendFile(path, `${JSON.stringify({ type: "file-history-snapshot" })}\n${JSON.stringify({ type: "system" })}\n`);
    await tailer.check();
    expect(events.at(-1)).toEqual({ type: "stream-line", index: 6, data: JSON.stringify({ type: "system" }) });
    // A filtered physical record still has to advance the browser's source
    // cursor (and prove the tail is alive). Without this signal the frontend
    // mistakes every hidden Claude bookkeeping append for a stalled tail and
    // tears down/rebuilds the subscription after three seconds.
    await appendFile(path, `${JSON.stringify({ type: "file-history-snapshot", snapshot: "next" })}\n`);
    await tailer.check();
    expect(events.at(-1)).toEqual({ type: "stream-cursor", nextIndex: 8 });
    await tailer.stop();
  });

  it("emits a liveness cursor while an appended physical record is still partial", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-tail-partial-cursor-"));
    const path = join(root, "a.jsonl");
    await writeFile(path, `${JSON.stringify({ type: "user", message: { content: "hello" } })}\n`);
    const events: any[] = [];
    const tailer = new JsonlTailer(path, {
      from: 0,
      pollMs: 60_000,
      filter: isRenderableClaudeLine,
    }, event => events.push(event));
    await tailer.start();
    await appendFile(path, "{\"type\":\"file-history-snapshot\"");
    await tailer.check();
    expect(events.at(-1)).toEqual({ type: "stream-cursor", nextIndex: 1 });
    await tailer.stop();
  });

  it("keeps physical indexes through filtering and ignores a partial final line", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-jsonl-")); const path = join(root, "a.jsonl");
    await writeFile(path, "a\nignore\nc\npartial");
    expect(await readTail(path, 2)).toEqual([{ index: 1, raw: "ignore" }, { index: 2, raw: "c" }]);
    expect(preserveIndexes(await readRange(path, 0), raw => raw !== "ignore")).toEqual([{ index: 0, raw: "a" }, { index: 2, raw: "c" }]);
  });

  it("invalidates its line index after append and keeps tail indexes absolute", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-index-")); const path = join(root, "a.jsonl");
    await writeFile(path, `${"x".repeat(1024 * 1024)}\none\ntwo\n`);
    expect(await readTail(path, 2)).toEqual([{ index: 1, raw: "one" }, { index: 2, raw: "two" }]);
    await appendFile(path, "three\n");
    expect(await readTail(path, 2)).toEqual([{ index: 2, raw: "two" }, { index: 3, raw: "three" }]);
  });

  it("extends a warm line index from appended bytes instead of rescanning the transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-index-incremental-")); const path = join(root, "a.jsonl");
    const original = `${Array.from({ length: 20_000 }, (_, index) => `line-${index}`).join("\n")}\n`;
    await writeFile(path, original);
    resetJsonlIndexIoCounters();
    await readTail(path, 2);
    expect(jsonlIndexIoCounters().fullBytes).toBe(Buffer.byteLength(original));

    resetJsonlIndexIoCounters();
    const appended = "next-one\nnext-two\n";
    await appendFile(path, appended);
    expect(await readTail(path, 2)).toEqual([
      { index: 20_000, raw: "next-one" },
      { index: 20_001, raw: "next-two" },
    ]);
    expect(jsonlIndexIoCounters()).toEqual({
      fullBytes: 0,
      appendedBytes: Buffer.byteLength(appended),
    });
  });

  it("serializes cold full-file indexes across different sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-index-serial-"));
    const paths = [join(root, "a.jsonl"), join(root, "b.jsonl"), join(root, "c.jsonl")];
    await Promise.all(paths.map((path, index) => writeFile(
      path,
      `${"x".repeat(2 * 1024 * 1024)}\n${index}\n`,
    )));
    resetJsonlIndexIoCounters();
    await Promise.all(paths.map(path => readTail(path, 1)));
    expect(jsonlColdIndexConcurrency()).toEqual({ active: 0, peak: 1 });
  });

  it("restores a sparse index after a backend restart and scans only appended bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-index-persist-"));
    const path = join(root, "large.jsonl");
    const cachePath = join(root, "line-index.json");
    const original = `${Array.from({ length: 100_000 }, (_, index) => `line-${index}`).join("\n")}\n`;
    await writeFile(path, original);

    await configureLineIndexPersistence(cachePath);
    resetJsonlIndexIoCounters();
    expect((await readTail(path, 1))[0]).toEqual({ index: 99_999, raw: "line-99999" });
    expect(jsonlIndexIoCounters().fullBytes).toBe(Buffer.byteLength(original));
    await flushLineIndexPersistence();

    // Switching away and back simulates a fresh backend process loading the
    // persisted sidecar instead of retaining the module's in-memory index.
    clearLineIndexMemoryCache();
    await configureLineIndexPersistence(join(root, "other-index.json"));
    await configureLineIndexPersistence(cachePath);
    resetJsonlIndexIoCounters();
    expect((await readTail(path, 1))[0]).toEqual({ index: 99_999, raw: "line-99999" });
    expect(jsonlIndexIoCounters()).toEqual({ fullBytes: 0, appendedBytes: 0 });

    const appended = "after-restart\n";
    await appendFile(path, appended);
    expect((await readTail(path, 1))[0]).toEqual({ index: 100_000, raw: "after-restart" });
    expect(jsonlIndexIoCounters()).toEqual({
      fullBytes: 0,
      appendedBytes: Buffer.byteLength(appended),
    });
  });

  it("persists exact tail boundaries so a warm tail can skip a giant record", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-index-giant-tail-"));
    const path = join(root, "large.jsonl");
    const cachePath = join(root, "line-index.json");
    await writeFile(path, `${"x".repeat(MAX_JSONL_RECORD_BYTES + 1_024)}\nsmall\n`);

    await configureLineIndexPersistence(cachePath);
    const cold = await readTail(path, 2);
    expect(JSON.parse(cold[0]!.raw).type).toBe("agent-webui-record-omitted");
    expect(cold[1]).toEqual({ index: 1, raw: "small" });
    await flushLineIndexPersistence();
    const persisted = JSON.parse(await readFile(cachePath, "utf8"));
    expect(persisted.version).toBe(2);
    expect(persisted.entries[0].tailOffsets).toHaveLength(3);

    clearLineIndexMemoryCache();
    await configureLineIndexPersistence(join(root, "other-index.json"));
    await configureLineIndexPersistence(cachePath);
    resetJsonlIndexIoCounters();
    const warm = await readTail(path, 2);
    expect(JSON.parse(warm[0]!.raw)).toMatchObject({
      type: "agent-webui-record-omitted",
      bytes: MAX_JSONL_RECORD_BYTES + 1_024,
    });
    expect(warm[1]).toEqual({ index: 1, raw: "small" });
    expect(jsonlIndexIoCounters()).toEqual({ fullBytes: 0, appendedBytes: 0 });
  });

  it("keeps line indexes in a strict least-recently-used resident bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-index-lru-"));
    const paths = await Promise.all(Array.from({ length: MAX_LINE_INDEX_CACHE_ENTRIES + 2 }, async (_, index) => {
      const path = join(root, `${index}.jsonl`);
      await writeFile(path, `${index}\n`);
      return path;
    }));
    for (const path of paths) await readTail(path, 1);
    expect(jsonlIndexCacheSize()).toBe(MAX_LINE_INDEX_CACHE_ENTRIES);
    expect(jsonlIndexCachePaths()).toEqual(paths.slice(-MAX_LINE_INDEX_CACHE_ENTRIES));

    const touched = paths[2]!;
    await readTail(touched, 1);
    const extra = join(root, "extra.jsonl");
    await writeFile(extra, "extra\n");
    await readTail(extra, 1);
    expect(jsonlIndexCacheSize()).toBe(MAX_LINE_INDEX_CACHE_ENTRIES);
    expect(jsonlIndexCachePaths()).toContain(touched);
    expect(jsonlIndexCachePaths()).not.toContain(paths[3]);
  });

  it("uses sparse anchors for a 100k-line transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-index-sparse-"));
    const path = join(root, "large.jsonl");
    await writeFile(path, `${Array.from({ length: 100_000 }, (_, index) => `line-${index}`).join("\n")}\n`);
    expect(await readTail(path, 2)).toEqual([
      { index: 99_998, raw: "line-99998" },
      { index: 99_999, raw: "line-99999" },
    ]);
    expect(lineIndexCacheBytes()).toBeLessThanOrEqual(MAX_LINE_INDEX_CACHE_BYTES);
  });

  it("caps range line count and serialized payload bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-range-cap-"));
    const path = join(root, "large.jsonl");
    const line = "x".repeat(5_000);
    await writeFile(path, `${Array.from({ length: MAX_READ_RANGE_LINES + 500 }, () => line).join("\n")}\n`);
    const lines = await readRange(path, 0, Number.MAX_SAFE_INTEGER);
    expect(lines.length).toBeLessThanOrEqual(MAX_READ_RANGE_LINES);
    expect(lines.reduce((total, item) => total + Buffer.byteLength(item.raw), 0)).toBeLessThanOrEqual(MAX_READ_RESPONSE_BYTES);
  });

  it("bounds a giant partial record and resumes at the next newline", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-giant-partial-"));
    const path = join(root, "a.jsonl");
    await writeFile(path, "x".repeat(MAX_JSONL_RECORD_BYTES + 1_024));
    const events: any[] = [];
    const tailer = new JsonlTailer(path, { from: 0, pollMs: 60_000 }, event => events.push(event));
    await tailer.start();
    await appendFile(path, "\nok\n");
    await tailer.check();
    const streamed = events.flatMap(event => event.type === "stream-batch"
      ? event.lines
      : event.type === "stream-line"
        ? [{ index: event.index, raw: event.data }]
        : []);
    expect(JSON.parse(streamed[0]!.raw).type).toBe("agent-webui-record-omitted");
    expect(streamed[0]!.index).toBe(0);
    expect(streamed[1]).toEqual({ index: 1, raw: "ok" });
    await tailer.stop();
  });

  it("streams initial catch-up in bounded batches with stable indexes", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-initial-batches-"));
    const path = join(root, "a.jsonl");
    await writeFile(path, `${Array.from({ length: 501 }, (_, index) => `line-${index}`).join("\n")}\n`);
    const events: any[] = [];
    const tailer = new JsonlTailer(path, { from: 0, pollMs: 60_000 }, event => events.push(event));
    await tailer.start();
    const batches = events.filter(event => event.type === "stream-batch");
    expect(batches.every(event => event.lines.length <= MAX_STREAM_BATCH_LINES)).toBe(true);
    expect(batches.flatMap(event => event.lines).map(line => line.index)).toEqual(
      Array.from({ length: 501 }, (_, index) => index),
    );
    await tailer.stop();
  });

  it("stops itself when the tailed file is removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-tail-unlink-"));
    const path = join(root, "a.jsonl");
    await writeFile(path, "zero\n");
    const events: any[] = [];
    const tailer = new JsonlTailer(path, { from: 1, pollMs: 60_000 }, event => events.push(event));
    await tailer.start();
    await unlink(path);
    await tailer.check();
    expect(events.some(event => event.type === "error")).toBe(true);
    expect((tailer as unknown as { stopped: boolean }).stopped).toBe(true);
  });

  it("keeps exact oversized source records in explicit mutation snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-exact-snapshot-"));
    const path = join(root, "a.jsonl");
    const raw = "x".repeat(MAX_JSONL_RECORD_BYTES + 1_024);
    await writeFile(path, `${raw}\n`);
    const snapshot = await snapshotJsonl(path);
    expect(snapshot.lines).toEqual([{ index: 0, raw }]);
  });

  it("streams exact byte offsets while omitting records above a finite cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-bounded-stream-"));
    const path = join(root, "a.jsonl");
    const first = JSON.stringify({ type: "user", message: { content: "你好" } });
    const oversized = JSON.stringify({ type: "file-history-snapshot", data: "x".repeat(512) });
    const complete = `${first}\r\n${oversized}\n`;
    await writeFile(path, `${complete}unfinished`);

    const lines = [];
    for await (const line of streamJsonlLines(path, { maxRecordBytes: 128, prefixBytes: 64 })) {
      lines.push(line);
    }

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      index: 0,
      startByte: 0,
      endByte: Buffer.byteLength(`${first}\r\n`),
      bytes: Buffer.byteLength(`${first}\r`),
      raw: first,
    });
    expect(lines[1]).toMatchObject({
      index: 1,
      startByte: Buffer.byteLength(`${first}\r\n`),
      endByte: Buffer.byteLength(complete),
      bytes: Buffer.byteLength(oversized),
      raw: undefined,
    });
    expect(lines[1]?.prefix).toContain('"type":"file-history-snapshot"');
  });

  it("resumes from from, completes partial bytes, and emits confirmed truncation", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-tail-")); const path = join(root, "a.jsonl");
    await writeFile(path, "zero\none\npart"); const events: any[] = [];
    const tailer = new JsonlTailer(path, { from: 1, pollMs: 60_000, truncateVerifyMs: 5 }, event => events.push(event));
    await tailer.start();
    expect(events[0]).toEqual({ type: "stream-truncate", keepCount: 2 });
    expect(events[1].lines).toEqual([{ index: 1, raw: "one" }]);
    await appendFile(path, "ial\nnext\n"); await tailer.check();
    expect(events.at(-1).lines).toEqual([{ index: 2, raw: "partial" }, { index: 3, raw: "next" }]);
    await truncate(path, Buffer.byteLength("zero\n")); await tailer.check();
    expect(events.some(event => event.type === "stream-truncate" && event.keepCount === 1)).toBe(true);
    await tailer.stop();
  });

  it("polls for appends when filesystem watch delivery is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-poll-")); const path = join(root, "a.jsonl");
    await writeFile(path, "zero\n"); const events: any[] = [];
    const tailer = new JsonlTailer(path, { from: 1, pollMs: 20 }, event => events.push(event));
    await tailer.start();
    await (tailer as any).watcher?.close();
    await appendFile(path, "polled\n");
    const deadline = Date.now() + 500;
    while (!events.some(event => event.type === "stream-line" && event.data === "polled") && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(events).toContainEqual({ type: "stream-line", index: 1, data: "polled" });
    await tailer.stop();
  });

  it("rescans when a confirmed truncation regrows past the old byte offset", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-regrow-")); const path = join(root, "a.jsonl");
    await writeFile(path, "old-zero\nold-one\nold-two\n"); const events: any[] = [];
    const tailer = new JsonlTailer(path, { from: 0, pollMs: 60_000, truncateVerifyMs: 25 }, event => events.push(event));
    await tailer.start(); events.length = 0;
    await writeFile(path, "new\n");
    const checking = tailer.check();
    await new Promise(resolve => setTimeout(resolve, 5));
    await writeFile(path, "new-zero\nnew-one\nnew-two\nnew-three\n");
    await checking;
    expect(events.some(event => event.type === "stream-reset")).toBe(true);
    expect(events.some(event => event.type === "stream-batch" && event.lines[0]?.raw === "new-zero")).toBe(true);
    await tailer.stop();
  });

  it("detects truncate-and-regrow completed entirely between polls", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-regrow-between-")); const path = join(root, "a.jsonl");
    await writeFile(path, "old-zero\nold-one\nold-two\n"); const events: any[] = [];
    const tailer = new JsonlTailer(path, { from: 0, pollMs: 60_000, truncateVerifyMs: 5 }, event => events.push(event));
    await tailer.start(); events.length = 0;
    await writeFile(path, "new-zero\nnew-one\nnew-two\nnew-three\n");
    await tailer.check();
    expect(events.some(event => event.type === "stream-reset")).toBe(true);
    expect(events.some(event => event.type === "stream-batch" && event.lines[0]?.raw === "new-zero")).toBe(true);
    await tailer.stop();
  });
});
