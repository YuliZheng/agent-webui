import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  ClaudeDriver,
  claudeExitStatus,
  claudeInteractionResponse,
  claudeSpawnArgs,
} from "../src/services/claude-driver.js";
import { AppState } from "../src/services/state.js";

function fakeClaudeChild(onKill?: (child: any) => void) {
  const child = new EventEmitter() as any;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = vi.fn(() => {
    onKill?.(child);
    return true;
  });
  return child;
}

describe("Claude ownership and interactions", () => {
  it("reports malformed stdout without emitting Node's fatal error event", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-claude-malformed-"));
    const driver = new ClaudeDriver("claude", join(root, "sessions"), new AppState(root)) as any;
    const warning = vi.fn();
    driver.on("driver-error", warning);

    expect(() => driver.stdout({ sessionId: "session", buffer: "" }, "not-json\n")).not.toThrow();
    expect(warning).toHaveBeenCalledWith({
      sessionId: "session",
      message: "Malformed Claude stream record",
    });
  });

  it("terminates and cleans up a new process that never initializes", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-claude-init-timeout-"));
    const child = fakeClaudeChild(proc => {
      proc.exitCode = 143;
      queueMicrotask(() => proc.emit("close", 143, null));
    });
    const driver = new ClaudeDriver(
      "claude",
      join(root, "sessions"),
      new AppState(root),
      vi.fn(() => child) as any,
      100,
    ) as any;

    const operation = driver.newSession(root, "hello");
    await vi.waitFor(() => expect(driver.all.size).toBe(1));
    const proc = [...driver.all][0];
    await expect(operation).rejects.toThrow(/did not initialize in time/);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(driver.all.size).toBe(0);
    expect(driver.owned.size).toBe(0);

    driver.handle(proc, { type: "system", subtype: "init", session_id: "ghost" });
    expect(driver.owned.has("ghost")).toBe(false);
  });

  it("clears the initialization timer after Claude reports a session", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-claude-init-success-"));
    const child = fakeClaudeChild();
    const driver = new ClaudeDriver(
      "claude",
      join(root, "sessions"),
      new AppState(root),
      vi.fn(() => child) as any,
    ) as any;
    const clearTimer = vi.spyOn(globalThis, "clearTimeout");
    const operation = driver.newSession(root, "hello");
    await vi.waitFor(() => expect(driver.all.size).toBe(1));
    const proc = [...driver.all][0];
    driver.handle(proc, { type: "system", subtype: "init", session_id: "ready" });
    await expect(operation).resolves.toEqual({ sessionId: "ready" });
    expect(clearTimer).toHaveBeenCalled();
    clearTimer.mockRestore();
  });

  it("cleans up spawn errors and close-without-exit idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-claude-spawn-error-"));
    const failedChild = fakeClaudeChild();
    const closedChild = fakeClaudeChild();
    const spawnProcess = vi.fn()
      .mockReturnValueOnce(failedChild)
      .mockReturnValueOnce(closedChild);
    const driver = new ClaudeDriver(
      "claude",
      join(root, "sessions"),
      new AppState(root),
      spawnProcess as any,
    ) as any;

    const failed = driver.newSession(root, "hello");
    await vi.waitFor(() => expect(driver.all.size).toBe(1));
    failedChild.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    await expect(failed).rejects.toThrow(/ENOENT/);
    expect(driver.all.size).toBe(0);

    await driver.start(root, "resumed");
    expect(driver.owned.get("resumed")?.child).toBe(closedChild);
    closedChild.emit("close", 1, null);
    closedChild.emit("error", new Error("late error"));
    expect(driver.all.size).toBe(0);
    expect(driver.owned.has("resumed")).toBe(false);
  });

  it("uses the supported Claude stream flags and never passes effort", () => {
    const args = claudeSpawnArgs("session", "opus", "acceptEdits");
    expect(args).toEqual([
      "--print",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--permission-prompt-tool", "stdio",
      "--resume", "session",
      "--model", "opus",
      "--permission-mode", "acceptEdits",
    ]);
    expect(args).not.toContain("--effort");
  });

  it("classifies normal numeric signal exits neutrally", () => {
    for (const code of [0, 130, 137, 143]) expect(claudeExitStatus(code, null)).toBe("exited");
    expect(claudeExitStatus(null, null)).toBe("exited");
    expect(claudeExitStatus(1, "SIGTERM")).toBe("exited");
    expect(claudeExitStatus(1, null, true)).toBe("exited");
    expect(claudeExitStatus(1, null)).toBe("failed");
  });

  it("maps reference interaction answer kinds onto Claude control responses", () => {
    const interaction = {
      sessionId: "session",
      requestId: "question",
      agent: "claude" as const,
      kind: "question" as const,
      createdAt: new Date().toISOString(),
      input: {
        questions: [
          { question: "Choose a branch", header: "Branch" },
          { question: "Add a note", header: "Note" },
        ],
      },
    };
    expect(claudeInteractionResponse(interaction, {
      kind: "ask-answers",
      answers: [
        { selectedLabel: "main" },
        { selectedLabel: "Other", otherText: "release" },
      ],
    })).toEqual({
      behavior: "allow",
      updatedInput: {
        questions: interaction.input.questions,
        answers: {
          "Choose a branch": "main",
          "Add a note": "release",
        },
      },
    });
    expect(claudeInteractionResponse(interaction, {
      kind: "deny",
      message: "not now",
    })).toEqual({ behavior: "deny", message: "not now" });
  });

  it("resets an oversized unframed stdout buffer without killing the process", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-buffer-"));
    const driver = new ClaudeDriver("claude", join(root, "sessions"), new AppState(root)) as any;
    const errors: unknown[] = [];
    driver.on("driver-error", (error: unknown) => errors.push(error));
    const kill = vi.fn();
    const proc = { sessionId: "session", buffer: "", child: { kill } };
    driver.stdout(proc, "x".repeat(4 * 1024 * 1024 + 1));
    expect(proc.buffer).toBe("");
    expect(kill).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
  });

  it("conservatively conflicts with a live foreign registration", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-owner-")); const registrations = join(root, "sessions"); await mkdir(registrations);
    await writeFile(join(registrations, "foreign.json"), JSON.stringify({ sessionId: "foreign", pid: process.pid }));
    const driver = new ClaudeDriver("claude", registrations, new AppState(join(root, "state")));
    await expect(driver.assertMutable("foreign")).rejects.toMatchObject({ code: 409 });
  });

  it("uses watcher-backed ownership truth without rescanning registration files", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-owner-cache-"));
    const driver = new ClaudeDriver("claude", join(root, "missing-sessions"), new AppState(join(root, "state")));
    driver.setForeignAttachmentLookup(() => false);
    await expect(driver.assertMutable("free")).resolves.toBeUndefined();
    driver.setForeignAttachmentLookup(sessionId => sessionId === "foreign");
    await expect(driver.assertMutable("foreign")).rejects.toMatchObject({ code: 409 });
  });

  it("adds one interaction, lets the first answer win, and removes it", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-interaction-")); const state = new AppState(root); const driver = new ClaudeDriver("claude", join(root, "sessions"), state) as any;
    const written: string[] = [];
    const proc = { sessionId: "session", interactions: new Set(), child: { stdin: { writable: true, write: (value: string) => written.push(value) } } };
    driver.owned.set("session", proc);
    driver.controlRequest(proc, { request_id: "request", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "pwd" } } });
    expect(state.interactions.size).toBe(1);
    driver.respond("session", "request", { behavior: "allow" });
    expect(state.interactions.size).toBe(0); expect(JSON.parse(written[0]!).response.response.behavior).toBe("allow");
    expect(() => driver.respond("session", "request", { behavior: "deny" })).toThrowError(/no longer pending/);
  });
  it("uses Claude's durable queue, deduplicates client retries, and separates stop from kill", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-queue-")); const driver = new ClaudeDriver("claude", join(root, "sessions"), new AppState(root)) as any;
    const written: string[] = []; const kill = vi.fn();
    const proc = { sessionId: "session", cwd: root, buffer: "", active: true, compacting: false, interactions: new Set(), child: { exitCode: null, stdin: { writable: true, write: (value: string) => written.push(value) }, kill } };
    driver.owned.set("session", proc);
    const first = await driver.prompt("session", root, "queued prompt", { clientUuid: "client-1" });
    const retry = await driver.prompt("session", root, "queued prompt", { clientUuid: "client-1" });
    expect(first).toEqual({ sessionId: "session", queued: true }); expect(retry).toEqual(first);
    expect(written).toHaveLength(1);
    driver.stop("session");
    expect(JSON.parse(written[1]!).request.subtype).toBe("interrupt"); expect(kill).not.toHaveBeenCalled(); expect(proc.active).toBe(true);
    driver.kill("session"); expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(() => driver.kill("foreign")).toThrowError(/Only WebUI-owned/);
  });
  it("serializes concurrent resumes and rejects stop while the reusable process is idle", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-resume-lock-")); const driver = new ClaudeDriver("claude", join(root, "sessions"), new AppState(root)) as any;
    let release!: () => void; const written: string[] = [];
    const proc = { sessionId: "session", active: false, compacting: false, child: { exitCode: null, stdin: { writable: true, write: (value: string) => written.push(value) } } };
    driver.startProcess = vi.fn(() => new Promise(resolve => { release = () => resolve({ process: proc, sessionId: Promise.resolve("session") }); }));
    const first = driver.start(root, "session");
    const second = driver.start(root, "session");
    expect(driver.startProcess).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    driver.owned.set("session", proc);
    expect(() => driver.stop("session")).toThrowError(/not active/);
    await driver.compact("session", root);
    expect(JSON.parse(written[0]!).message.content.at(-1).text).toBe("/compact");
    expect(proc.active).toBe(true);
  });
  it("coalesces the same client UUID while its first resume is still in flight", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-claude-idempotent-")); const driver = new ClaudeDriver("claude", join(root, "sessions"), new AppState(root)) as any;
    const writes: string[] = []; let release!: () => void;
    const proc = { sessionId: "session", cwd: root, buffer: "", active: false, compacting: false, interactions: new Set(), child: { exitCode: null, stdin: { writable: true, write: (value: string) => writes.push(value) } } };
    driver.start = vi.fn(() => new Promise(resolve => { release = () => resolve({ process: proc, sessionId: Promise.resolve("session") }); }));
    const first = driver.prompt("session", root, "only once", { clientUuid: "same-client" });
    const retry = driver.prompt("session", root, "only once", { clientUuid: "same-client" });
    expect(driver.start).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all([first, retry])).resolves.toHaveLength(2);
    expect(writes).toHaveLength(1);
  });
});
