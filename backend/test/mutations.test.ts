import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionIndex } from "../src/services/session-index.js";
import {
  autoTitle,
  autoTitleFromText,
  forkClaude,
  forkSession,
  getUserMessages,
  markdownExport,
  rewindClaude,
  rewindSession,
  searchSessions,
} from "../src/actions/sessions.js";
import type { ClaudeDriver } from "../src/services/claude-driver.js";
import type { CodexDriver } from "../src/services/codex-driver.js";
import { AppState } from "../src/services/state.js";
import { jsonlIndexIoCounters, resetJsonlIndexIoCounters } from "../src/services/jsonl.js";

describe("session mutations/search/export", () => {
  it("forks and rewinds exactly before a selected Claude user record", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-mutate-")); const claudeRoot = join(root, "claude"); const codexRoot = join(root, "codex"); await mkdir(claudeRoot); await mkdir(codexRoot);
    const path = join(claudeRoot, "session.jsonl");
    await writeFile(path, [
      JSON.stringify({ type: "user", cwd: root, uuid: "u1", message: { content: "first prompt" } }),
      JSON.stringify({ type: "assistant", cwd: root, uuid: "a1", message: { content: [{ type: "text", text: "answer needle" }] } }),
      JSON.stringify({ type: "user", cwd: root, uuid: "u2", message: { content: "second prompt needle beta" } }),
      JSON.stringify({ type: "assistant", cwd: root, uuid: "a2", message: { content: [{ type: "text", text: "needle only" }] } }),
      "",
    ].join("\n"));
    const index = new SessionIndex({ claudeRoot, codexRoot }); await index.scan();
    const driver = { isActive: () => false, isOwned: () => false, assertMutable: async () => undefined } as unknown as ClaudeDriver;
    const active = { isActive: () => true, isOwned: () => true, assertMutable: async () => undefined } as unknown as ClaudeDriver;
    await expect(rewindClaude(index, active, "session", "u2")).rejects.toMatchObject({ code: 409 });
    const owned = { isActive: () => false, isOwned: () => true, assertMutable: async () => undefined } as unknown as ClaudeDriver;
    await expect(rewindClaude(index, owned, "session", "u2")).rejects.toMatchObject({ code: 409 });
    const fork = await forkClaude(index, driver, "session", "u2"); expect(fork.prefillText).toBe("second prompt needle beta");
    expect(await readFile(join(claudeRoot, `${fork.newSessionId}.jsonl`), "utf8")).toContain('"parentSessionId":"session"');
    expect(index.get(fork.newSessionId)).toMatchObject({ id: fork.newSessionId, parentSessionId: "session", cwd: root });
    expect((await searchSessions(index, "needle")).matches[0]?.id).toBe("session");
    expect((await searchSessions(index, "needle beta")).matches[0]).toMatchObject({
      id: "session",
      lastMatchUuid: "u2",
      lastMatchIndex: 2,
    });
    expect((await searchSessions(index, "first beta")).matches).toEqual([]);
    expect(await markdownExport(index, "session")).toContain("## Assistant\n\nanswer needle");
    expect(await markdownExport(index, "session", "  UI resolved title  ")).toMatch(/^# UI resolved title\n/);
    const rewind = await rewindClaude(index, driver, "session", "u2"); expect(rewind.prefillText).toBe("second prompt needle beta");
    expect(await readFile(path, "utf8")).not.toContain("second prompt");
  });

  it("exports newer Codex messages once without injected context", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-codex-export-"));
    const claudeRoot = join(root, "claude");
    const codexRoot = join(root, "codex");
    await mkdir(claudeRoot);
    await mkdir(codexRoot);
    await writeFile(join(codexRoot, "rollout-export.jsonl"), [
      JSON.stringify({ timestamp: "2026-08-28T00:00:00Z", type: "session_meta", payload: { id: "codex-export", cwd: root } }),
      JSON.stringify({ timestamp: "2026-08-28T00:00:01Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "hidden developer text" }] } }),
      JSON.stringify({ timestamp: "2026-08-28T00:00:02Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<permissions instructions>hidden</permissions instructions>" }] } }),
      JSON.stringify({ timestamp: "2026-08-28T00:00:03Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "visible prompt" }] } }),
      JSON.stringify({ timestamp: "2026-08-28T00:00:04Z", type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", id: "u1", content: [{ type: "text", text: "visible prompt" }] } } }),
      JSON.stringify({ timestamp: "2026-08-28T00:00:05Z", type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", id: "a1", content: [{ type: "Text", text: "visible answer" }] } } }),
      JSON.stringify({ timestamp: "2026-08-28T00:00:06Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "visible answer" }] } }),
      JSON.stringify({ timestamp: "2026-08-28T00:00:07Z", type: "event_msg", payload: { type: "agent_message", message: "visible answer" } }),
      "",
    ].join("\n"));
    const index = new SessionIndex({ claudeRoot, codexRoot });
    await index.scan();

    const markdown = await markdownExport(index, "codex-export");
    expect(markdown.match(/^## User$/gm)).toHaveLength(1);
    expect(markdown.match(/^## Assistant$/gm)).toHaveLength(1);
    expect(markdown).toContain("visible prompt");
    expect(markdown).toContain("visible answer");
    expect(markdown).not.toContain("hidden developer text");
    expect(markdown).not.toContain("permissions instructions");
  });

  it("streams past oversized bookkeeping records for export, fork, and rewind", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-large-mutate-"));
    const claudeRoot = join(root, "claude");
    const codexRoot = join(root, "codex");
    await mkdir(claudeRoot);
    await mkdir(codexRoot);
    const path = join(claudeRoot, "large.jsonl");
    const largePayload = `nested text may contain {"type":"user"} ${"x".repeat((16 * 1024 * 1024) + 1_024)}`;
    await writeFile(path, [
      JSON.stringify({ type: "user", cwd: root, uuid: "u1", message: { content: "first 你好" } }),
      JSON.stringify({ type: "file-history-snapshot", snapshot: largePayload }),
      JSON.stringify({ type: "user", cwd: root, uuid: "u2", message: { content: "second prompt" } }),
      JSON.stringify({ type: "assistant", cwd: root, uuid: "a2", message: { content: "second answer" } }),
      "",
    ].join("\n"));
    const index = new SessionIndex({ claudeRoot, codexRoot });
    await index.scan();
    const driver = {
      isActive: () => false,
      isOwned: () => false,
      assertMutable: async () => undefined,
    } as unknown as ClaudeDriver;

    expect(await getUserMessages(index, "large")).toEqual([
      { uuid: "u1", parentUuid: null, type: "user", text: "first 你好" },
      { uuid: "u2", parentUuid: null, type: "user", text: "second prompt" },
    ]);
    expect(await markdownExport(index, "large")).toContain("## Assistant\n\nsecond answer");
    const fork = await forkClaude(index, driver, "large", "u2");
    expect(index.get(fork.newSessionId)).toMatchObject({ parentSessionId: "large" });
    await rewindClaude(index, driver, "large", "u2");
    expect(await getUserMessages(index, "large")).toEqual([
      { uuid: "u1", parentUuid: null, type: "user", text: "first 你好" },
    ]);

    await writeFile(path, [
      JSON.stringify({ type: "user", cwd: root, uuid: "small", message: { content: "small" } }),
      JSON.stringify({
        type: "user",
        cwd: root,
        uuid: "too-large",
        message: { content: largePayload },
      }),
      "",
    ].join("\n"));
    await expect(getUserMessages(index, "large")).rejects.toMatchObject({
      code: 413,
      message: expect.stringContaining("per-record limit"),
    });
  }, 30_000);

  it("keeps record-level search semantics with rg candidates and its fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-rg-search-"));
    const claudeRoot = join(root, "claude");
    const codexRoot = join(root, "codex");
    await mkdir(claudeRoot);
    await mkdir(codexRoot);
    await writeFile(join(claudeRoot, "together.jsonl"), [
      JSON.stringify({ type: "user", cwd: root, uuid: "u1", message: { content: "unrelated" } }),
      JSON.stringify({ type: "assistant", cwd: root, uuid: "a1", message: { content: "alpha and beta occur together" } }),
      "",
    ].join("\n"));
    await writeFile(join(claudeRoot, "separate.jsonl"), [
      JSON.stringify({ type: "user", cwd: root, uuid: "u2", message: { content: "alpha only" } }),
      JSON.stringify({ type: "assistant", cwd: root, uuid: "a2", message: { content: "beta only" } }),
      "",
    ].join("\n"));
    await writeFile(join(codexRoot, "rollout-search.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { id: "codex-search", cwd: root } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "codex user target" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "codex agent target" } }),
      "",
    ].join("\n"));
    const index = new SessionIndex({ claudeRoot, codexRoot });
    await index.scan();

    const accelerated = await searchSessions(index, "alpha beta", { rgMinArchiveBytes: 0 });
    expect(accelerated.matches).toEqual([expect.objectContaining({
      id: "together",
      lastMatchUuid: "a1",
      lastMatchIndex: 1,
    })]);
    expect((await searchSessions(index, "message", { rgMinArchiveBytes: 0 })).matches).toEqual([]);
    expect((await searchSessions(index, "codex user target", { rgMinArchiveBytes: 0 })).matches).toEqual([
      expect.objectContaining({
        id: "codex-search",
        lastMatchUuid: "codex-line-1",
        lastMatchIndex: 1,
      }),
    ]);
    expect((await searchSessions(index, "codex agent target", { rgMinArchiveBytes: 0 })).matches).toEqual([
      expect.objectContaining({
        id: "codex-search",
        lastMatchUuid: "a-2",
        lastMatchIndex: 2,
      }),
    ]);

    const fallback = await searchSessions(index, "alpha beta", {
      rgBinary: "missing-rg-agent-webui-test",
      rgMinArchiveBytes: 0,
    });
    expect(fallback).toEqual(accelerated);
  }, 10_000);

  it("uses Codex turn_context for image prompts without loading thread history", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-codex-mutate-"));
    const claudeRoot = join(root, "claude");
    const codexRoot = join(root, "codex");
    await mkdir(claudeRoot);
    await mkdir(codexRoot);
    await writeFile(join(codexRoot, "rollout-test.jsonl"), [
      JSON.stringify({ timestamp: "2026-07-24T00:00:00Z", type: "session_meta", payload: { id: "codex-session", cwd: root } }),
      JSON.stringify({ timestamp: "2026-07-24T00:00:01Z", type: "turn_context", payload: { turn_id: "turn-1", cwd: root } }),
      JSON.stringify({ timestamp: "2026-07-24T00:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "first prompt" }] } }),
      JSON.stringify({ timestamp: "2026-07-24T00:00:01Z", type: "event_msg", payload: { type: "user_message", message: "first prompt" } }),
      JSON.stringify({ timestamp: "2026-07-24T00:00:02Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "first answer" }] } }),
      JSON.stringify({ timestamp: "2026-07-24T00:00:02Z", type: "turn_context", payload: { turn_id: "automatic-turn", cwd: root } }),
      JSON.stringify({ timestamp: "2026-07-24T00:00:02Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<codex_internal_context source=\"goal\">continue</codex_internal_context>" }] } }),
      JSON.stringify({ timestamp: "2026-07-24T00:00:03Z", type: "turn_context", payload: { turn_id: "turn-2", cwd: root } }),
      JSON.stringify({ timestamp: "2026-07-24T00:00:03Z", type: "response_item", payload: { type: "message", role: "user", content: [
        { type: "input_text", text: "<image name=[Image #1] path=\"C:\\temp\\prompt.png\">\n</image>" },
        { type: "input_image", image_url: "file://C:/temp/prompt.png" },
        { type: "input_text", text: "[Image #1]second prompt" },
      ] } }),
      JSON.stringify({ timestamp: "2026-07-24T00:00:03Z", type: "event_msg", payload: { type: "user_message", message: "[Image #1]second prompt" } }),
      JSON.stringify({ timestamp: "2026-07-24T00:00:04Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "second answer" }] } }),
      "",
    ].join("\n"));
    const index = new SessionIndex({ claudeRoot, codexRoot });
    await index.scan();
    const claude = { isActive: () => false, isOwned: () => false, assertMutable: async () => undefined } as unknown as ClaudeDriver;
    const forkPath = join(codexRoot, "rollout-fork.jsonl");
    await writeFile(forkPath, [
      JSON.stringify({ timestamp: "2026-07-24T00:00:00Z", type: "session_meta", payload: { id: "codex-fork", cwd: root, parent_thread_id: "codex-session" } }),
      JSON.stringify({ timestamp: "2026-07-24T00:00:01Z", type: "event_msg", payload: { type: "user_message", message: "first prompt" } }),
      "",
    ].join("\n"));
    const rollback = vi.fn(async (threadId: string) => threadId === "codex-fork"
      ? { thread: { id: "codex-fork", path: forkPath } }
      : {});
    const fork = vi.fn(async () => ({ thread: { id: "codex-fork", path: forkPath, cwd: root } }));
    const threadTurns = vi.fn(async () => {
      throw new Error("thread/read should not be needed when turn_context is present");
    });
    const codex = {
      isActive: () => false,
      threadTurns,
      rollback,
      fork,
    } as unknown as CodexDriver;

    expect(await getUserMessages(index, "codex-session")).toEqual([
      { uuid: "line-2", parentUuid: null, type: "user", text: "first prompt" },
      { uuid: "line-8", parentUuid: null, type: "user", text: "[Image #1]second prompt" },
    ]);

    // The visible bubble comes from the clean event_msg and the frontend
    // prefixes its fallback source ID with `codex-`.
    const rewind = await rewindSession(index, claude, codex, "codex-session", "codex-line-9");
    expect(rewind).toMatchObject({ removedRecords: 1, truncatedBytes: 0, prefillText: "[Image #1]second prompt" });
    expect(rollback).toHaveBeenLastCalledWith("codex-session", 1);

    rollback.mockClear();
    const forked = await forkSession(index, claude, codex, "codex-session", "codex-line-9");
    expect(forked).toEqual({ newSessionId: "codex-fork", prefillText: "[Image #1]second prompt" });
    expect(fork).toHaveBeenCalledWith("codex-session", { beforeTurnId: "turn-2" });
    expect(rollback).not.toHaveBeenCalled();
    expect(threadTurns).not.toHaveBeenCalled();
    expect(index.get("codex-fork")).toMatchObject({
      id: "codex-fork",
      parentSessionId: "codex-session",
      cwd: root,
      path: forkPath,
    });
  });

  it("rejects Codex rewind but allows a non-mutating fork while a turn is active", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-codex-active-"));
    const claudeRoot = join(root, "claude");
    const codexRoot = join(root, "codex");
    await mkdir(claudeRoot);
    await mkdir(codexRoot);
    await writeFile(join(codexRoot, "rollout-active.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { id: "active-codex", cwd: root } }),
      JSON.stringify({ type: "turn_context", payload: { turn_id: "active-turn", cwd: root } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "do work" } }),
      "",
    ].join("\n"));
    const forkPath = join(codexRoot, "rollout-active-fork.jsonl");
    await writeFile(forkPath, [
      JSON.stringify({ type: "session_meta", payload: { id: "active-fork", cwd: root, parent_thread_id: "active-codex" } }),
      "",
    ].join("\n"));
    const index = new SessionIndex({ claudeRoot, codexRoot });
    await index.scan();
    const claude = {} as ClaudeDriver;
    const fork = vi.fn(async () => ({ thread: { id: "active-fork", path: forkPath, cwd: root } }));
    const rollback = vi.fn(async () => ({ thread: { id: "active-fork", path: forkPath } }));
    const codex = { isActive: () => true, fork, rollback } as unknown as CodexDriver;
    await expect(rewindSession(index, claude, codex, "active-codex", "line-2"))
      .rejects.toMatchObject({ code: 409 });
    await expect(forkSession(index, claude, codex, "active-codex", "line-2"))
      .resolves.toEqual({ newSessionId: "active-fork", prefillText: "do work" });
    expect(fork).toHaveBeenCalledWith("active-codex", { beforeTurnId: "active-turn" });
    expect(rollback).not.toHaveBeenCalled();
  });

  it("forks a line-addressed Codex prompt without scanning a huge suffix", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-codex-fast-fork-"));
    const claudeRoot = join(root, "claude");
    const codexRoot = join(root, "codex");
    await mkdir(claudeRoot);
    await mkdir(codexRoot);
    const sourcePath = join(codexRoot, "rollout-large-suffix.jsonl");
    const suffix = Array.from(
      { length: 20_100 },
      (_, index) => JSON.stringify({
        type: "event_msg",
        payload: { type: "user_message", message: `irrelevant-${index}` },
      }),
    );
    await writeFile(sourcePath, [
      JSON.stringify({ type: "session_meta", payload: { id: "fast-source", cwd: root } }),
      JSON.stringify({ type: "turn_context", payload: { turn_id: "target-turn", cwd: root } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "target prompt" } }),
      ...suffix,
      "",
    ].join("\n"));
    const forkPath = join(codexRoot, "rollout-fast-fork.jsonl");
    await writeFile(forkPath, [
      JSON.stringify({
        type: "session_meta",
        payload: { id: "fast-fork", cwd: root, parent_thread_id: "fast-source" },
      }),
      "",
    ].join("\n"));
    const index = new SessionIndex({ claudeRoot, codexRoot });
    await index.scan();
    const fork = vi.fn(async () => ({
      thread: { id: "fast-fork", path: forkPath, cwd: root },
    }));
    const codex = { isActive: () => false, fork } as unknown as CodexDriver;

    await expect(
      forkSession(index, {} as ClaudeDriver, codex, "fast-source", "codex-line-2"),
    ).resolves.toEqual({ newSessionId: "fast-fork", prefillText: "target prompt" });
    expect(fork).toHaveBeenCalledWith("fast-source", { beforeTurnId: "target-turn" });
  });

  it("writes an automatic title from the observed prompt without reading the transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-title-"));
    const claudeRoot = join(root, "claude");
    const codexRoot = join(root, "codex");
    const stateDir = join(root, "state");
    await mkdir(claudeRoot);
    await mkdir(codexRoot);
    await writeFile(join(claudeRoot, "session.jsonl"), [
      JSON.stringify({ type: "user", cwd: root, uuid: "u1", message: { content: "large historical prompt" } }),
      `${JSON.stringify({ type: "assistant", cwd: root, uuid: "a1", message: { content: [{ type: "text", text: "x".repeat(1024 * 1024) }] } })}\n`,
    ].join("\n"));
    const index = new SessionIndex({ claudeRoot, codexRoot });
    await index.scan();
    resetJsonlIndexIoCounters();
    const state = new AppState(stateDir);
    state.titleGenerator = vi.fn(async () => ({
      title: "Fix streaming watcher",
      emoji: "🛠️",
      summary: "Improve the streaming watcher without reading full transcripts.",
    }));
    expect(await autoTitleFromText(index, state, "session", "Fix the streaming watcher hot path")).toBe("Fix streaming watcher");
    expect(jsonlIndexIoCounters()).toEqual({ fullBytes: 0, appendedBytes: 0 });
    expect(state.titleGenerator).toHaveBeenCalledWith({
      text: "Fix the streaming watcher hot path",
      language: "auto",
    });
    expect((await state.titles.get()).session).toMatchObject({
      source: "auto",
      title: "Fix streaming watcher",
      emoji: "🛠️",
      topicSummary: "Improve the streaming watcher without reading full transcripts.",
    });
    expect((await new AppState(stateDir).titles.get()).session?.topicSummary)
      .toBe("Improve the streaming watcher without reading full transcripts.");

    vi.mocked(state.titleGenerator).mockClear();
    resetJsonlIndexIoCounters();
    expect(await autoTitle(index, state, "session", true)).toBe("Fix streaming watcher");
    expect(jsonlIndexIoCounters()).toEqual({ fullBytes: 0, appendedBytes: 0 });
    expect(state.titleGenerator).toHaveBeenCalledWith({
      text: expect.stringMatching(
        /^CONVERSATION-WIDE USER REQUEST SAMPLE[\s\S]*large historical prompt/,
      ),
      language: "auto",
      previousSummary: "Improve the streaming watcher without reading full transcripts.",
    });

    vi.mocked(state.titleGenerator).mockRejectedValueOnce(new Error("titler unavailable"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(autoTitle(index, state, "session", true)).resolves.toBe("large historical prompt");
    errorLog.mockRestore();

    let finishTitle: ((value: {
      title: string;
      emoji: string;
      summary: string;
    }) => void) | undefined;
    state.titleGenerator = vi.fn(() => new Promise(resolve => {
      finishTitle = resolve;
    }));
    const delayedAutoTitle = autoTitleFromText(
      index,
      state,
      "session",
      "Generate a stale automatic title",
      true,
    );
    await vi.waitFor(() => expect(state.titleGenerator).toHaveBeenCalledOnce());
    await state.titles.update(all => {
      all.session = { title: "User manual title", source: "manual", emoji: "✍️" };
    });
    finishTitle?.({
      title: "Stale generated title",
      emoji: "🤖",
      summary: "This result must not overwrite a later manual rename.",
    });
    await expect(delayedAutoTitle).resolves.toBe("User manual title");
    expect((await state.titles.get()).session).toEqual({
      title: "User manual title",
      source: "manual",
      emoji: "✍️",
    });

    await state.titles.update(all => {
      all.session = { title: "Existing automatic title", source: "auto" };
    });
    await state.prefs.update(prefs => {
      prefs.autoTitleEnabled = true;
    });
    finishTitle = undefined;
    state.titleGenerator = vi.fn(() => new Promise(resolve => {
      finishTitle = resolve;
    }));
    const disabledWhileRunning = autoTitleFromText(
      index,
      state,
      "session",
      "Do not commit after auto-title is disabled",
    );
    await vi.waitFor(() => expect(state.titleGenerator).toHaveBeenCalledOnce());
    await state.prefs.update(prefs => {
      prefs.autoTitleEnabled = false;
    });
    finishTitle?.({
      title: "Late disabled title",
      emoji: "⏰",
      summary: "This result must be discarded.",
    });
    await expect(disabledWhileRunning).resolves.toBe("Existing automatic title");
    expect((await state.titles.get()).session?.title).toBe("Existing automatic title");
  });
});
