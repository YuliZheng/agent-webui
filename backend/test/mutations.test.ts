import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionIndex } from "../src/services/session-index.js";
import {
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
    const rewind = await rewindClaude(index, driver, "session", "u2"); expect(rewind.prefillText).toBe("second prompt needle beta");
    expect(await readFile(path, "utf8")).not.toContain("second prompt");
  });

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

    // The clean event_msg alias is what the second visible bubble used before
    // frontend de-duplication, so it must resolve to the same Codex turn.
    const rewind = await rewindSession(index, claude, codex, "codex-session", "line-9");
    expect(rewind).toMatchObject({ removedRecords: 1, truncatedBytes: 0, prefillText: "[Image #1]second prompt" });
    expect(rollback).toHaveBeenLastCalledWith("codex-session", 1);

    rollback.mockClear();
    const forked = await forkSession(index, claude, codex, "codex-session", "line-9");
    expect(forked).toEqual({ newSessionId: "codex-fork", prefillText: "[Image #1]second prompt" });
    expect(fork).toHaveBeenCalledWith("codex-session", "turn-2");
    expect(rollback).toHaveBeenCalledWith("codex-fork", 1);
    expect(threadTurns).not.toHaveBeenCalled();
    expect(index.get("codex-fork")).toMatchObject({
      id: "codex-fork",
      parentSessionId: "codex-session",
      cwd: root,
      path: forkPath,
    });
  });

  it("rejects Codex history mutations while a turn is active", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-codex-active-"));
    const claudeRoot = join(root, "claude");
    const codexRoot = join(root, "codex");
    await mkdir(claudeRoot);
    await mkdir(codexRoot);
    await writeFile(join(codexRoot, "rollout-active.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { id: "active-codex", cwd: root } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "do work" } }),
      "",
    ].join("\n"));
    const index = new SessionIndex({ claudeRoot, codexRoot });
    await index.scan();
    const claude = {} as ClaudeDriver;
    const codex = { isActive: () => true } as unknown as CodexDriver;
    await expect(rewindSession(index, claude, codex, "active-codex", "line-1"))
      .rejects.toMatchObject({ code: 409 });
    await expect(forkSession(index, claude, codex, "active-codex", "line-1"))
      .rejects.toMatchObject({ code: 409 });
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
    expect(await autoTitleFromText(index, state, "session", "Fix the streaming watcher hot path")).toBe("Fix the streaming watcher hot path");
    expect(jsonlIndexIoCounters()).toEqual({ fullBytes: 0, appendedBytes: 0 });
    expect((await state.titles.get()).session).toMatchObject({ source: "auto", title: "Fix the streaming watcher hot path" });
  });
});
