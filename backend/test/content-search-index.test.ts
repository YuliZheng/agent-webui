import { appendFile, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { searchSessions } from "../src/actions/sessions.js";
import { ContentSearchIndex } from "../src/services/content-search-index.js";
import { SessionIndex } from "../src/services/session-index.js";

describe("persistent content search index", () => {
  it("covers indexed files, preserves search semantics, and indexes appends", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-content-index-"));
    const claudeRoot = join(root, "claude");
    const codexRoot = join(root, "codex");
    await mkdir(claudeRoot);
    await mkdir(codexRoot);
    const path = join(claudeRoot, "indexed.jsonl");
    await writeFile(path, [
      JSON.stringify({ type: "user", cwd: root, uuid: "u1", message: { content: "英国旅行" } }),
      JSON.stringify({ type: "assistant", cwd: root, uuid: "a1", message: { content: "alpha beta together" } }),
      JSON.stringify({ type: "assistant", cwd: root, uuid: "a2", message: { content: "alpha only" } }),
      "",
    ].join("\n"));
    const sessions = new SessionIndex({ claudeRoot, codexRoot });
    await sessions.scan();
    const contentIndex = await ContentSearchIndex.open(join(root, "content.sqlite"));
    if (!contentIndex) return;
    try {
      contentIndex.sync(sessions.list());
      await contentIndex.waitForIdle();

      const candidates = await contentIndex.candidates(sessions.list(), "英国");
      expect(candidates.coveredPaths.size).toBe(1);
      expect(candidates.candidates.map(item => item.lineIndex)).toEqual([0]);

      const diagnostics: Array<{ strategy: string; scannedArchiveBytes: number }> = [];
      const accelerated = await searchSessions(sessions, "英国", {
        contentIndex,
        rgMinArchiveBytes: Number.POSITIVE_INFINITY,
        onDiagnostic: diagnostic => diagnostics.push(diagnostic),
      });
      const fallback = await searchSessions(sessions, "英国", {
        rgBinary: "missing-rg-agent-webui-test",
        rgMinArchiveBytes: 0,
      });
      expect(accelerated).toEqual(fallback);
      expect(diagnostics).toEqual([expect.objectContaining({
        strategy: "content-index",
        scannedArchiveBytes: 0,
      })]);

      await appendFile(path, `${JSON.stringify({
        type: "assistant",
        cwd: root,
        uuid: "a3",
        message: { content: "加拿大旅行" },
      })}\n`);
      const info = await stat(path);
      const updated = {
        ...sessions.list()[0]!,
        size: info.size,
        mtime: info.mtime.toISOString(),
      };
      sessions.upsert(updated);
      contentIndex.schedule(updated);
      const appendDiagnostics: Array<{
        strategy: string;
        scannedArchiveBytes: number;
        indexCatchupFiles?: number;
      }> = [];
      expect((await searchSessions(sessions, "加拿大", {
        contentIndex,
        rgMinArchiveBytes: Number.POSITIVE_INFINITY,
        onDiagnostic: diagnostic => appendDiagnostics.push(diagnostic),
      })).matches).toEqual([expect.objectContaining({
        id: "indexed",
        lastMatchUuid: "a3",
        lastMatchIndex: 3,
      })]);
      expect(appendDiagnostics).toEqual([expect.objectContaining({
        strategy: "content-index",
        scannedArchiveBytes: 0,
        indexCatchupFiles: 1,
      })]);
    } finally {
      await contentIndex.close();
    }
  });

  it("indexes oversized JSONL records in chunks and verifies the complete record", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-content-index-large-"));
    const claudeRoot = join(root, "claude");
    const codexRoot = join(root, "codex");
    await mkdir(claudeRoot);
    await mkdir(codexRoot);
    const path = join(claudeRoot, "oversized.jsonl");
    await writeFile(path, `${JSON.stringify({
      type: "assistant",
      cwd: root,
      uuid: "large-record",
      message: {
        content: `alpha 英国 ${"x".repeat(2 * 1024 * 1024)} beta`,
      },
    })}\n`);
    const sessions = new SessionIndex({ claudeRoot, codexRoot });
    await sessions.scan();
    const contentIndex = await ContentSearchIndex.open(join(root, "content.sqlite"));
    if (!contentIndex) return;
    try {
      contentIndex.sync(sessions.list());
      await contentIndex.waitForIdle();

      const candidates = await contentIndex.candidates(sessions.list(), "英国");
      expect(candidates.coveredPaths.size).toBe(1);
      expect(candidates.candidates).toEqual([
        expect.objectContaining({ lineIndex: 0, byteOffset: 0 }),
      ]);
      expect((await contentIndex.stats()).unsupportedFiles).toBe(0);

      const query = "alpha 英国 beta";
      const accelerated = await searchSessions(sessions, query, {
        contentIndex,
        rgMinArchiveBytes: Number.POSITIVE_INFINITY,
      });
      const fallback = await searchSessions(sessions, query, {
        rgBinary: "missing-rg-agent-webui-test",
        rgMinArchiveBytes: 0,
      });
      expect(accelerated).toEqual(fallback);
      expect(accelerated.matches).toEqual([
        expect.objectContaining({
          id: "oversized",
          lastMatchUuid: "large-record",
          lastMatchIndex: 0,
        }),
      ]);
    } finally {
      await contentIndex.close();
    }
  });

  it("returns the renderer's stable Codex line id for indexed matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-content-index-codex-"));
    const claudeRoot = join(root, "claude");
    const codexRoot = join(root, "codex");
    await mkdir(claudeRoot);
    await mkdir(codexRoot);
    await writeFile(join(codexRoot, "rollout-search.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { id: "codex-search", cwd: root } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "visible prompt" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "indexed answer target" } }),
      "",
    ].join("\n"));
    const sessions = new SessionIndex({ claudeRoot, codexRoot });
    await sessions.scan();
    const contentIndex = await ContentSearchIndex.open(join(root, "content.sqlite"));
    if (!contentIndex) return;
    try {
      contentIndex.sync(sessions.list());
      await contentIndex.waitForIdle();
      expect((await searchSessions(sessions, "indexed answer target", {
        contentIndex,
        rgMinArchiveBytes: Number.POSITIVE_INFINITY,
      })).matches).toEqual([
        expect.objectContaining({
          id: "codex-search",
          lastMatchUuid: "a-2",
          lastMatchIndex: 2,
        }),
      ]);
    } finally {
      await contentIndex.close();
    }
  });
});
