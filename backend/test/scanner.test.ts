import { describe, expect, it } from "vitest";
import { appendFile, mkdtemp, mkdir, readFile, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HEAD_SCAN_CHUNK_BYTES,
  HEAD_SCAN_YIELD_EVERY_BYTES,
  HEAD_SCAN_YIELD_MS,
  mapWithConcurrency,
  SESSION_APPEND_SCAN_MAX_BYTES,
  SESSION_COLD_SCAN_CHECKPOINT_EVERY,
  SESSION_COLD_SCAN_PACE_MS,
  SESSION_INITIAL_PREVIEW_BYTES,
  SESSION_POLL_BATCH_SIZE,
  SESSION_SCAN_CONCURRENCY,
  SessionIndex,
  scanClaudeFile,
  scanCodexFile,
  scanJsonlHead,
} from "../src/services/session-index.js";

describe("session scanning", () => {
  it("bounds concurrent file work and preserves input order", async () => {
    let active = 0;
    let peak = 0;
    const values = await mapWithConcurrency(
      Array.from({ length: 25 }, (_, index) => index),
      2,
      async value => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, value % 3));
        active -= 1;
        return value * 2;
      },
    );
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1);
    expect(SESSION_SCAN_CONCURRENCY).toBe(1);
    expect(values).toEqual(Array.from({ length: 25 }, (_, index) => index * 2));
  });

  it("paces and checkpoints cold archive discovery", () => {
    expect(SESSION_COLD_SCAN_PACE_MS).toBeGreaterThanOrEqual(80);
    expect(SESSION_COLD_SCAN_CHECKPOINT_EVERY).toBeGreaterThanOrEqual(8);
    expect(SESSION_COLD_SCAN_CHECKPOINT_EVERY).toBeLessThanOrEqual(32);
  });

  it("persists a resumable checkpoint before a large cold scan finishes", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-checkpoint-"));
    const claudeRoot = join(root, "claude");
    const codexRoot = join(root, "codex");
    const stateRoot = join(root, "state");
    const cachePath = join(stateRoot, "session-index.json");
    await Promise.all([mkdir(claudeRoot), mkdir(codexRoot), mkdir(stateRoot)]);
    const count = 80;
    await Promise.all(Array.from({ length: count }, async (_, index) => {
      const id = `checkpoint_${String(index).padStart(3, "0")}`;
      await writeFile(join(claudeRoot, `${id}.jsonl`), `${JSON.stringify({
        type: "user",
        cwd: root,
        message: { content: id },
      })}\n`);
    }));

    const index = new SessionIndex({
      claudeRoot,
      codexRoot,
      cachePath,
      deferColdPreviews: true,
      coldScanPaceMs: 5,
    });
    const scan = index.scan();
    let checkpoint: { records?: unknown[] } | undefined;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try {
        checkpoint = JSON.parse(await readFile(cachePath, "utf8")) as { records?: unknown[] };
        if (checkpoint.records?.length) break;
      } catch { /* first checkpoint is still being written */ }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(checkpoint?.records?.length).toBeGreaterThan(0);
    expect(checkpoint?.records?.length).toBeLessThan(count);
    await scan;
    const complete = JSON.parse(await readFile(cachePath, "utf8")) as { records?: unknown[] };
    expect(complete.records).toHaveLength(count);
  });

  it("publishes cold sessions incrementally instead of holding the list until EOF", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-incremental-scan-"));
    const claudeRoot = join(root, "claude");
    const codexRoot = join(root, "codex");
    await Promise.all([mkdir(claudeRoot), mkdir(codexRoot)]);
    await Promise.all(Array.from({ length: 4 }, async (_, index) => {
      const id = `incremental_${index}`;
      await writeFile(join(claudeRoot, `${id}.jsonl`), `${JSON.stringify({
        type: "user",
        cwd: root,
        message: { content: id },
      })}\n`);
    }));
    const index = new SessionIndex({
      claudeRoot,
      codexRoot,
      deferColdPreviews: true,
      coldScanPaceMs: 40,
    });
    let settled = false;
    const firstAdded = new Promise<void>(resolve => index.once("added", () => resolve()));
    const scan = index.scan({ incremental: true }).finally(() => { settled = true; });
    await firstAdded;
    expect(settled).toBe(false);
    expect(index.list()).toHaveLength(1);
    await scan;
    expect(index.list()).toHaveLength(4);
  });

  it("aborts a paced cold scan promptly when the backend closes", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-abort-scan-"));
    const claudeRoot = join(root, "claude");
    const codexRoot = join(root, "codex");
    await Promise.all([mkdir(claudeRoot), mkdir(codexRoot)]);
    await Promise.all(Array.from({ length: 20 }, async (_, index) => {
      const id = `abort_${String(index).padStart(2, "0")}`;
      await writeFile(join(claudeRoot, `${id}.jsonl`), `${JSON.stringify({
        type: "user",
        cwd: root,
        message: { content: id },
      })}\n`);
    }));
    const index = new SessionIndex({
      claudeRoot,
      codexRoot,
      deferColdPreviews: true,
      coldScanPaceMs: 1_000,
    });
    const firstAdded = new Promise<void>(resolve => index.once("added", () => resolve()));
    const scan = index.scan({ incremental: true });
    await firstAdded;
    const stoppedAt = performance.now();
    await index.stop();
    await scan;
    expect(performance.now() - stoppedAt).toBeLessThan(500);
    expect(index.list().length).toBeLessThan(20);
  });

  it("observes a newly-created session after the initial scan", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-native-watch-"));
    const claudeRoot = join(root, "claude");
    const codexRoot = join(root, "codex");
    await Promise.all([mkdir(claudeRoot), mkdir(codexRoot)]);
    const index = new SessionIndex({ claudeRoot, codexRoot });
    await index.scan();
    await index.start();
    try {
      await writeFile(join(claudeRoot, "watched_session.jsonl"), `${JSON.stringify({
        type: "user",
        cwd: root,
        message: { content: "watch me" },
      })}\n`);
      const deadline = Date.now() + 2_000;
      while (!index.get("watched_session") && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(index.get("watched_session")).toMatchObject({ cwd: root, agent: "claude" });
    } finally {
      await index.stop();
    }
  });

  it("paces pathological metadata records without delaying normal first-chunk metadata", () => {
    expect(HEAD_SCAN_YIELD_EVERY_BYTES).toBe(256 * 1024);
    expect(HEAD_SCAN_YIELD_MS).toBeGreaterThanOrEqual(4);
    expect(HEAD_SCAN_YIELD_EVERY_BYTES % HEAD_SCAN_CHUNK_BYTES).toBe(0);
  });

  it("stops the head scan after the first metadata chunk", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-head-"));
    const session = join(root, "large.jsonl");
    const metadata = JSON.stringify({ type: "user", cwd: root, message: { content: "hello" } });
    await writeFile(session, `${metadata}\n${"x".repeat(HEAD_SCAN_CHUNK_BYTES * 8)}\n`);
    const seen: string[] = [];
    const result = await scanJsonlHead(session, (await stat(session)).size, line => {
      seen.push(line);
      return true;
    });
    expect(result).toEqual({ bytesRead: expect.any(Number), stopped: true });
    expect(result.bytesRead).toBeLessThanOrEqual(HEAD_SCAN_CHUNK_BYTES);
    expect(seen).toEqual([metadata]);
  });

  it("takes cwd from records and prefers Codex payload.id", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-scan-"));
    const claude = join(root, "abc_123.jsonl");
    await writeFile(claude, [
      JSON.stringify({ type: "system", cwd: join(root, "work"), timestamp: "2026-01-01T00:00:00Z" }),
      JSON.stringify({ type: "assistant", cwd: join(root, "work"), message: { content: [{ type: "text", text: "answer text" }] }, timestamp: "2026-01-02T00:00:00Z" }),
      "",
    ].join("\n"));
    expect((await scanClaudeFile(claude))?.cwd).toBe(join(root, "work"));
    expect((await scanClaudeFile(claude))?.preview).toBe("answer text");

    const codex = join(root, "rollout-test.jsonl");
    await writeFile(codex, `${JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", type: "session_meta", payload: { id: "current-id", session_id: "parent-id", cwd: join(root, "codex") } })}\n`);
    const item = await scanCodexFile(codex);
    expect(item?.id).toBe("current-id");
    expect(item?.parentSessionId).toBe("parent-id");
    expect(item?.subagent).toBe(false);
  });

  it("distinguishes Codex subagent workers from ordinary forks", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-codex-source-"));
    const subagentPath = join(root, "rollout-subagent.jsonl");
    await writeFile(subagentPath, `${JSON.stringify({
      timestamp: "2026-07-26T00:00:00Z",
      type: "session_meta",
      payload: {
        id: "worker-id",
        cwd: root,
        thread_source: "subagent",
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: "root-id",
              depth: 1,
              agent_nickname: "scanner",
            },
          },
        },
      },
    })}\n`);

    const worker = await scanCodexFile(subagentPath);
    expect(worker?.subagent).toBe(true);
    expect(worker?.parentSessionId).toBe("root-id");

    const forkPath = join(root, "rollout-fork.jsonl");
    await writeFile(forkPath, `${JSON.stringify({
      timestamp: "2026-07-26T00:00:01Z",
      type: "session_meta",
      payload: {
        id: "fork-id",
        cwd: root,
        parent_thread_id: "root-id",
      },
    })}\n`);
    const fork = await scanCodexFile(forkPath);
    expect(fork?.subagent).toBe(false);
    expect(fork?.parentSessionId).toBe("root-id");
  });

  it("excludes subagents and does not follow symlink directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-walk-")); const claudeRoot = join(root, "claude"); const codexRoot = join(root, "codex");
    await mkdir(join(claudeRoot, "project", "subagents"), { recursive: true }); await mkdir(codexRoot, { recursive: true });
    await writeFile(join(claudeRoot, "project", "good.jsonl"), `${JSON.stringify({ type: "user", cwd: root, uuid: "u", message: { content: "hello" } })}\n`);
    await writeFile(join(claudeRoot, "project", "subagents", "agent-bad.jsonl"), `${JSON.stringify({ type: "user", cwd: root, uuid: "u", message: { content: "bad" } })}\n`);
    const outside = join(root, "outside"); await mkdir(outside); await writeFile(join(outside, "linked.jsonl"), `${JSON.stringify({ type: "user", cwd: root, uuid: "u", message: { content: "linked" } })}\n`);
    try { await symlink(outside, join(claudeRoot, "linked"), "junction"); } catch { /* CI may forbid symlinks; subagent assertion remains */ }
    const index = new SessionIndex({ claudeRoot, codexRoot }); const sessions = await index.scan();
    expect(sessions.map(item => item.id)).toEqual(["good"]);
  });

  it("reuses unchanged records instead of reparsing every JSONL on refresh", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-reuse-"));
    const claudeRoot = join(root, "claude");
    const codexRoot = join(root, "codex");
    await mkdir(claudeRoot);
    await mkdir(codexRoot);
    const session = join(claudeRoot, "reused.jsonl");
    await writeFile(session, `${JSON.stringify({ type: "user", cwd: root, timestamp: "2026-01-01T00:00:00Z", message: { content: "first" } })}\n`);
    const index = new SessionIndex({ claudeRoot, codexRoot });
    await index.scan();
    const original = index.get("reused");
    await index.scan();
    expect(index.get("reused")).toBe(original);

    await appendFile(session, `${JSON.stringify({ type: "assistant", cwd: root, timestamp: "2026-01-02T00:00:00Z", message: { content: "changed" } })}\n`);
    await index.scan();
    expect(index.get("reused")).not.toBe(original);
    expect(index.get("reused")?.preview).toBe("changed");
  });

  it("reuses a persisted metadata index across backend restarts", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-persisted-index-"));
    const claudeRoot = join(root, "claude");
    const codexRoot = join(root, "codex");
    const stateRoot = join(root, "state");
    const cachePath = join(stateRoot, "session-index.json");
    await mkdir(claudeRoot);
    await mkdir(codexRoot);
    await mkdir(stateRoot);
    const session = join(claudeRoot, "warm_cache.jsonl");
    const source = `${JSON.stringify({
      type: "user",
      cwd: root,
      timestamp: "2026-01-01T00:00:00Z",
      message: { content: "persist me" },
    })}\n`;
    await writeFile(session, source);

    const first = new SessionIndex({ claudeRoot, codexRoot, cachePath });
    await first.scan();
    const cached = first.get("warm_cache")!;
    expect(cached.preview).toBe("persist me");

    // Keep the exact stat signature but replace the source with unparsable
    // bytes. A fresh index can still list the session only if it reused the
    // persisted metadata instead of reparsing the JSONL.
    await writeFile(session, "x".repeat(Buffer.byteLength(source)));
    await utimes(session, new Date(cached.mtime), new Date(cached.mtime));
    const second = new SessionIndex({ claudeRoot, codexRoot, cachePath });
    await second.scan();
    expect(second.get("warm_cache")).toMatchObject({
      id: "warm_cache",
      cwd: root,
      preview: "persist me",
      size: Buffer.byteLength(source),
    });
  });

  it("keeps initial discovery shallow and deepens only when a session is opened", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-lazy-preview-"));
    const claudeRoot = join(root, "claude");
    const codexRoot = join(root, "codex");
    await mkdir(claudeRoot);
    await mkdir(codexRoot);
    const session = join(claudeRoot, "lazy_preview.jsonl");
    await writeFile(session, [
      JSON.stringify({ type: "system", cwd: root }),
      JSON.stringify({ type: "assistant", cwd: root, timestamp: "2026-01-02T00:00:00Z", message: { content: [{ type: "text", text: "older meaningful answer" }] } }),
      "x".repeat(SESSION_INITIAL_PREVIEW_BYTES + 8_192),
      "",
    ].join("\n"));
    const index = new SessionIndex({ claudeRoot, codexRoot });
    await index.scan();
    expect(index.get("lazy_preview")?.preview).toBeNull();

    const opened = await index.resolve("lazy_preview");
    expect(opened?.preview).toBe("older meaningful answer");
  });

  it("validates an interactive session path without deepening its cold preview", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-light-resolve-"));
    const claudeRoot = join(root, "claude");
    const codexRoot = join(root, "codex");
    await mkdir(claudeRoot);
    await mkdir(codexRoot);
    const session = join(claudeRoot, "light_resolve.jsonl");
    await writeFile(session, [
      JSON.stringify({ type: "system", cwd: root }),
      JSON.stringify({ type: "assistant", cwd: root, message: { content: [{ type: "text", text: "hidden in the cold tail" }] } }),
      "x".repeat(SESSION_INITIAL_PREVIEW_BYTES + 8_192),
      "",
    ].join("\n"));
    const index = new SessionIndex({ claudeRoot, codexRoot });
    await index.scan();
    expect(index.get("light_resolve")?.preview).toBeNull();

    const light = await index.resolveLight("light_resolve");
    expect(light).toMatchObject({
      id: "light_resolve",
      path: session,
      cwd: root,
      preview: null,
    });
    expect((await index.resolve("light_resolve"))?.preview).toBe("hidden in the cold tail");
  });

  it("coalesces concurrent full scans", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-scan-dedupe-"));
    const claudeRoot = join(root, "claude");
    const codexRoot = join(root, "codex");
    await mkdir(claudeRoot);
    await mkdir(codexRoot);
    await writeFile(join(claudeRoot, "one.jsonl"), `${JSON.stringify({ type: "user", cwd: root, message: { content: "first" } })}\n`);
    const index = new SessionIndex({ claudeRoot, codexRoot });
    const [first, second] = await Promise.all([index.scan(), index.scan()]);
    expect(first).toBe(second);
    expect(first).toHaveLength(1);
  });

  it("deduplicates concurrent watcher and poll refreshes for one path", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-refresh-dedupe-"));
    const claudeRoot = join(root, "claude");
    const codexRoot = join(root, "codex");
    await mkdir(claudeRoot);
    await mkdir(codexRoot);
    const session = join(claudeRoot, "deduped.jsonl");
    await writeFile(session, `${JSON.stringify({ type: "user", cwd: root, message: { content: "first" } })}\n`);
    const index = new SessionIndex({ claudeRoot, codexRoot });
    await index.scan();
    await appendFile(session, `${JSON.stringify({ type: "assistant", cwd: root, message: { content: "changed" } })}\n`);
    let touches = 0;
    index.on("touched", () => { touches += 1; });
    const refresh = (index as unknown as { refreshPath(path: string): Promise<void> }).refreshPath.bind(index);
    await Promise.all(Array.from({ length: 12 }, () => refresh(session)));
    expect(touches).toBe(1);
    expect(index.get("deduped")?.preview).toBe("changed");
  });

  it("repairs a partial JSONL record from overlap without a deep watcher rescan", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-refresh-partial-"));
    const claudeRoot = join(root, "claude");
    const codexRoot = join(root, "codex");
    await mkdir(claudeRoot);
    await mkdir(codexRoot);
    const session = join(claudeRoot, "partial_append.jsonl");
    const first = `${JSON.stringify({ type: "assistant", cwd: root, timestamp: "2026-01-01T00:00:00Z", message: { content: "old answer" } })}\n`;
    const next = JSON.stringify({ type: "assistant", cwd: root, timestamp: "2026-01-02T00:00:00Z", message: { content: "new answer" } });
    await writeFile(session, `${first}${next.slice(0, Math.floor(next.length / 2))}`);
    const index = new SessionIndex({ claudeRoot, codexRoot });
    await index.scan();
    expect(index.get("partial_append")?.preview).toBe("old answer");

    await appendFile(session, `${next.slice(Math.floor(next.length / 2))}\n`);
    await (index as unknown as { refreshPath(path: string): Promise<void> }).refreshPath(session);
    expect(index.get("partial_append")?.preview).toBe("new answer");
    expect(index.get("partial_append")?.lastTurnAt).toBe("2026-01-02T00:00:00Z");
  });

  it("caps hot append preview work while still finding the latest bounded-tail message", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-refresh-capped-"));
    const claudeRoot = join(root, "claude");
    const codexRoot = join(root, "codex");
    await mkdir(claudeRoot);
    await mkdir(codexRoot);
    const session = join(claudeRoot, "capped_append.jsonl");
    await writeFile(session, `${JSON.stringify({ type: "assistant", cwd: root, message: { content: "old answer" } })}\n`);
    const index = new SessionIndex({ claudeRoot, codexRoot });
    await index.scan();
    await appendFile(session, `${"x".repeat(SESSION_APPEND_SCAN_MAX_BYTES * 3)}\n${JSON.stringify({
      type: "assistant",
      cwd: root,
      timestamp: "2026-01-03T00:00:00Z",
      message: { content: "bounded latest answer" },
    })}\n`);
    await (index as unknown as { refreshPath(path: string): Promise<void> }).refreshPath(session);
    expect(index.get("capped_append")?.preview).toBe("bounded latest answer");
  });

  it("rotates fallback polling through a bounded batch", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-poll-batch-"));
    const claudeRoot = join(root, "claude");
    const codexRoot = join(root, "codex");
    await mkdir(claudeRoot);
    await mkdir(codexRoot);
    const count = SESSION_POLL_BATCH_SIZE + 3;
    const paths = Array.from({ length: count }, (_, index) => join(claudeRoot, `session_${String(index).padStart(2, "0")}.jsonl`));
    await Promise.all(paths.map((path, index) => writeFile(path, `${JSON.stringify({ type: "user", cwd: root, message: { content: `first ${index}` } })}\n`)));
    const index = new SessionIndex({ claudeRoot, codexRoot });
    await index.scan();
    await Promise.all(paths.map((path, value) => appendFile(path, `${JSON.stringify({ type: "assistant", cwd: root, message: { content: `changed ${value}` } })}\n`)));
    let touches = 0;
    index.on("touched", () => { touches += 1; });
    const poll = (index as unknown as { poll(): Promise<void> }).poll.bind(index);
    await poll();
    expect(touches).toBe(SESSION_POLL_BATCH_SIZE);
    await poll();
    expect(touches).toBe(count);
  });

  it("sorts concurrent sessions only by meaningful activity, not sidechains or mtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-order-")); const claudeRoot = join(root, "claude"); const codexRoot = join(root, "codex"); await mkdir(claudeRoot); await mkdir(codexRoot);
    const a = join(claudeRoot, "a.jsonl"); const b = join(claudeRoot, "b.jsonl");
    await writeFile(a, [
      JSON.stringify({ type: "assistant", cwd: root, uuid: "a1", timestamp: "2026-01-01T10:00:00Z", message: { content: [{ type: "text", text: "A meaningful" }] } }),
      JSON.stringify({ type: "assistant", cwd: root, uuid: "a-side", agentId: "subagent", timestamp: "2026-01-01T15:00:00Z", message: { content: [{ type: "text", text: "sidechain noise" }] } }), "",
    ].join("\n"));
    await writeFile(b, [
      JSON.stringify({ type: "assistant", cwd: root, uuid: "b1", timestamp: "2026-01-01T11:00:00Z", message: { content: [{ type: "text", text: "B meaningful" }] } }),
      JSON.stringify({ type: "assistant", cwd: root, uuid: "b-empty", timestamp: "2026-01-01T16:00:00Z", message: { content: [] } }), "",
    ].join("\n"));
    await utimes(a, new Date("2026-01-03T00:00:00Z"), new Date("2026-01-03T00:00:00Z"));
    await utimes(b, new Date("2026-01-02T00:00:00Z"), new Date("2026-01-02T00:00:00Z"));
    const index = new SessionIndex({ claudeRoot, codexRoot }); await index.scan();
    expect(index.list().map(item => item.id)).toEqual(["b", "a"]);
    expect(index.get("a")?.lastTurnAt).toBe("2026-01-01T10:00:00Z");
    await Promise.all([
      appendFile(a, `${JSON.stringify({ type: "assistant", cwd: root, isSidechain: true, timestamp: "2026-01-04T00:00:00Z", message: { content: [{ type: "text", text: "more noise" }] } })}\n`),
      appendFile(b, `${JSON.stringify({ type: "queue-operation", cwd: root, timestamp: "2026-01-04T00:00:00Z" })}\n`),
    ]);
    await index.scan();
    expect(index.list().map(item => item.id)).toEqual(["b", "a"]);
  });

  it("does not use Codex developer or system messages as the preview", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-codex-preview-"));
    const codex = join(root, "rollout-preview.jsonl");
    await writeFile(codex, [
      JSON.stringify({ timestamp: "2026-07-23T00:00:00.000Z", type: "session_meta", payload: { id: "codex_preview", cwd: root } }),
      JSON.stringify({ timestamp: "2026-07-23T00:00:01.000Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "text", text: "hidden developer instructions" }] } }),
      JSON.stringify({ timestamp: "2026-07-23T00:00:02.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "visible user request" }] } }),
      "",
    ].join("\n"));
    const item = await scanCodexFile(codex);
    expect(item?.preview).toBe("visible user request");
    expect(item?.lastTurnAt).toBe("2026-07-23T00:00:02.000Z");
  });

  it("invalidates an old Codex ID when session_meta changes in place", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-id-change-"));
    const claudeRoot = join(root, "claude");
    const codexRoot = join(root, "codex");
    await mkdir(claudeRoot);
    await mkdir(codexRoot);
    const rollout = join(codexRoot, "rollout-changing.jsonl");
    await writeFile(rollout, `${JSON.stringify({ type: "session_meta", payload: { id: "old_id", cwd: root } })}\n`);
    const index = new SessionIndex({ claudeRoot, codexRoot });
    await index.scan();
    expect(index.get("old_id")?.id).toBe("old_id");

    await writeFile(rollout, `${JSON.stringify({ type: "session_meta", payload: { id: "new_longer_id", cwd: root } })}\n`);
    expect(await index.resolve("old_id")).toBeUndefined();
    expect(index.get("old_id")).toBeUndefined();
    expect(index.get("new_longer_id")?.id).toBe("new_longer_id");
  });

  it("does not follow a cached session path replaced by a file symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-resolve-link-"));
    const claudeRoot = join(root, "claude");
    const codexRoot = join(root, "codex");
    await mkdir(claudeRoot);
    await mkdir(codexRoot);
    const session = join(claudeRoot, "safe_id.jsonl");
    await writeFile(session, `${JSON.stringify({ type: "user", cwd: root, message: { content: "safe" } })}\n`);
    const outside = join(root, "outside.jsonl");
    await writeFile(outside, `${JSON.stringify({ type: "user", cwd: root, message: { content: "outside" } })}\n`);
    const index = new SessionIndex({ claudeRoot, codexRoot });
    await index.scan();

    await unlink(session);
    try {
      await symlink(outside, session, "file");
    } catch {
      // Some Windows CI accounts cannot create file symlinks. The directory
      // symlink exclusion is still covered above.
      return;
    }
    expect(await index.resolve("safe_id")).toBeUndefined();
    expect(index.get("safe_id")).toBeUndefined();
  });

  it("does not let the watcher refresh path bypass symlink containment", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-refresh-link-"));
    const claudeRoot = join(root, "claude");
    const codexRoot = join(root, "codex");
    await mkdir(claudeRoot);
    await mkdir(codexRoot);
    const session = join(claudeRoot, "refresh_id.jsonl");
    await writeFile(session, `${JSON.stringify({ type: "user", cwd: root, message: { content: "safe" } })}\n`);
    const outside = join(root, "outside-refresh.jsonl");
    await writeFile(outside, `${JSON.stringify({ type: "user", cwd: root, message: { content: "outside-via-refresh" } })}\n`);
    const index = new SessionIndex({ claudeRoot, codexRoot });
    await index.scan();

    await unlink(session);
    try {
      await symlink(outside, session, "file");
    } catch {
      return;
    }
    await (index as unknown as { refreshPath(path: string): Promise<void> }).refreshPath(session);
    expect(index.get("refresh_id")).toBeUndefined();
    expect(index.list().some(item => item.preview === "outside-via-refresh")).toBe(false);
  });

  it("cancels metadata retry timers when the watcher stops", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-stop-retries-"));
    const claudeRoot = join(root, "claude");
    const codexRoot = join(root, "codex");
    await mkdir(claudeRoot);
    await mkdir(codexRoot);
    const incomplete = join(claudeRoot, "pending_id.jsonl");
    await writeFile(incomplete, "");
    const index = new SessionIndex({ claudeRoot, codexRoot });
    await index.start();
    await (index as unknown as { refreshPath(path: string): Promise<void> }).refreshPath(incomplete);
    expect((index as unknown as { timers: Map<string, NodeJS.Timeout> }).timers.size).toBeGreaterThan(0);
    await index.stop();
    expect((index as unknown as { timers: Map<string, NodeJS.Timeout> }).timers.size).toBe(0);
    expect((index as unknown as { watching: boolean }).watching).toBe(false);
  });
});
