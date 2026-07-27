import { describe, expect, it } from "vitest";
import { currentTurnBackgroundTasks, runtimeBackgroundTasks, runtimeChecklist } from "../src/util/runtime-work.js";

describe("runtime work indicators", () => {
  it("hides stale running wire tasks from an earlier turn", () => {
    const tasks = currentTurnBackgroundTasks([
      {
        taskId: "stale",
        kind: "shell",
        label: "item/started",
        startedAt: "2026-07-26T18:39:56Z",
        status: "running",
      },
      {
        taskId: "current",
        kind: "shell",
        label: "npm test",
        startedAt: "2026-07-26T18:53:10Z",
        status: "running",
      },
      {
        taskId: "history",
        kind: "shell",
        label: "done",
        startedAt: "2026-07-26T18:39:56Z",
        completedAt: "2026-07-26T18:40:00Z",
        status: "completed",
      },
    ], "2026-07-26T18:53:00Z");

    expect(tasks.map(task => task.taskId)).toEqual(["current", "history"]);
  });

  it("does not present Codex update_plan steps as subagents or tasks", () => {
    const lines = [
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "update_plan",
          arguments: JSON.stringify({
            plan: [
              { step: "Inspect", status: "completed" },
              { step: "Implement", status: "in_progress" },
            ],
          }),
        },
      }),
    ];

    expect(runtimeChecklist(lines)).toEqual([]);
  });

  it("adds running subagent worker sessions to the parent task list", () => {
    const tasks = runtimeBackgroundTasks([], [{
      id: "worker-1",
      cwd: "C:\\work",
      mtime: "2026-07-26T00:00:00Z",
      size: 1,
      agent: "codex",
      subagent: true,
      parentSessionId: "parent",
      title: "Inspect code",
    }], { "worker-1": "running" }, "parent");

    expect(tasks).toEqual([
      expect.objectContaining({
        taskId: "worker-1",
        kind: "agent",
        label: "Inspect code",
        status: "running",
      }),
    ]);
  });

  it("does not duplicate an indexed worker already correlated to a wire task", () => {
    const tasks = runtimeBackgroundTasks([{
      taskId: "agent-call-1",
      kind: "agent",
      relatedSessionIds: ["worker-1"],
      label: "Inspect code",
      startedAt: "2026-07-26T00:00:00Z",
      status: "running",
    }], [{
      id: "worker-1",
      cwd: "C:\\work",
      mtime: "2026-07-26T00:00:01Z",
      size: 1,
      agent: "codex",
      subagent: true,
      parentSessionId: "parent",
      title: "Inspect code",
    }], { "worker-1": "running" }, "parent");

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.taskId).toBe("agent-call-1");
  });
});
