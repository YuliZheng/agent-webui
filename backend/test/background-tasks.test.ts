import { describe, expect, it } from "vitest";
import { failRunningClaudeBackgroundTasks, mergeClaudeBackgroundTasks, mergeCodexBackgroundTask } from "../src/services/background-tasks.js";

describe("Codex background task lifecycle", () => {
  it("updates one stable task from running to completed instead of leaving a stale spinner", () => {
    const running = mergeCodexBackgroundTask([], "item/commandExecution/started", { itemId: "cmd-1", command: "npm test" }, "2026-01-01T00:00:00Z");
    const completed = mergeCodexBackgroundTask(running, "item/commandExecution/completed", { itemId: "cmd-1", output: "ok" }, "2026-01-01T00:00:05Z");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ id: "cmd-1", status: "completed", startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:05Z" });
  });

  it("maps failed and cancelled lifecycle events explicitly", () => {
    expect(mergeCodexBackgroundTask([], "task/failed", { task: { id: "t1" }, error: "boom" })[0]).toMatchObject({ id: "t1", status: "failed", error: "boom" });
    expect(mergeCodexBackgroundTask([], "task/cancelled", { taskId: "t2" })[0]).toMatchObject({ id: "t2", status: "cancelled" });
  });
});

describe("Claude background task lifecycle", () => {
  it("keeps a Task tool invocation stable across start, progress, and completion events", () => {
    const started = mergeClaudeBackgroundTasks([], {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tool-1", name: "Task", input: { description: "Run tests", run_in_background: true } }] },
    }, "2026-01-01T00:00:00Z");
    expect(started).toEqual([expect.objectContaining({ id: "tool-1", toolUseId: "tool-1", title: "Run tests", status: "running" })]);

    const progressed = mergeClaudeBackgroundTasks(started, {
      type: "system", subtype: "task_progress", task_id: "task-9", tool_use_id: "tool-1", message: "2/3 suites",
    }, "2026-01-01T00:00:03Z");
    const completed = mergeClaudeBackgroundTasks(progressed, {
      type: "system", subtype: "task_completed", task_id: "task-9", tool_use_id: "tool-1", output: "All passed",
    }, "2026-01-01T00:00:05Z");

    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      id: "tool-1", toolUseId: "tool-1", title: "Run tests", status: "completed",
      startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:05Z",
    });
  });

  it("ignores unrelated tool results and keeps async launch results running", () => {
    const untouched: unknown[] = [];
    expect(mergeClaudeBackgroundTasks(untouched, {
      type: "user", message: { content: [{ type: "tool_result", tool_use_id: "unknown", content: "ok" }] },
    })).toBe(untouched);

    const started = mergeClaudeBackgroundTasks([], {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "agent-1", name: "Agent", input: { prompt: "Inspect code", background: true } }] },
    });
    const launched = mergeClaudeBackgroundTasks(started, {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "agent-1", content: "Background agent launched successfully" }] },
    });
    expect(launched[0]).toMatchObject({ id: "agent-1", status: "running", title: "Inspect code" });
    const completed = mergeClaudeBackgroundTasks(launched, {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "agent-1", content: "inspection complete" }] },
    });
    expect(completed[0]).toMatchObject({ id: "agent-1", status: "completed", title: "Inspect code" });
  });

  it("fails only still-running tasks when the owned process exits", () => {
    const existing = [
      { id: "running", title: "Running", status: "running", startedAt: "2026-01-01T00:00:00Z" },
      { id: "done", title: "Done", status: "completed", finishedAt: "2026-01-01T00:00:01Z" },
    ];
    const failed = failRunningClaudeBackgroundTasks(existing, "2026-01-01T00:00:02Z");
    expect(failed).toEqual([
      expect.objectContaining({ id: "running", status: "failed", finishedAt: "2026-01-01T00:00:02Z", error: "Claude process exited" }),
      existing[1],
    ]);
  });
});
