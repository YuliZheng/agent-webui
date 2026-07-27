import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { CodexDriver } from "../src/services/codex-driver.js";
import { AppState } from "../src/services/state.js";

function fakeCodexChild() {
  const child = new EventEmitter() as any;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = vi.fn(() => true);
  return child;
}

describe("Codex steer semantics", () => {
  it("surfaces collaboration-agent item lifecycle as background work", async () => {
    const state = new AppState(await mkdtemp(join(tmpdir(), "agent-webui-codex-collab-")));
    const driver = new CodexDriver("codex", state) as any;
    driver.threads.set("thread", { active: true, turnId: "turn", steers: [] });
    const background = vi.fn();
    driver.on("background", background);

    driver.notification("item/started", {
      threadId: "thread",
      item: { id: "agent-call-1", type: "collabAgentToolCall", description: "Inspect code" },
    });

    expect(background).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "thread",
      method: "item/started",
    }));
  });

  it("discards a child whose initialize RPC fails and cleanly starts another", async () => {
    const state = new AppState(await mkdtemp(join(tmpdir(), "agent-webui-codex-init-error-")));
    const firstChild = fakeCodexChild();
    const secondChild = fakeCodexChild();
    const spawnProcess = vi.fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const driver = new CodexDriver("codex", state, spawnProcess as any) as any;
    driver.resolvedBinary = Promise.resolve("codex");

    const first = driver.ensure();
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1));
    const firstId = [...driver.pending.keys()][0];
    driver.message({ id: firstId, error: { code: -32000, message: "initialize rejected" } });
    await expect(first).rejects.toThrow(/initialize rejected/);
    expect(firstChild.kill).toHaveBeenCalledWith("SIGTERM");
    expect(driver.child).toBeUndefined();

    const second = driver.ensure();
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(2));
    const secondId = [...driver.pending.keys()][0];
    driver.message({ id: secondId, result: {} });
    await expect(second).resolves.toBeUndefined();
    expect(driver.child).toBe(secondChild);

    firstChild.emit("exit", 1, null);
    expect(driver.child).toBe(secondChild);
    expect(driver.initializedChild).toBe(secondChild);
  });

  it("invalidates and terminates a child when initialize times out", async () => {
    vi.useFakeTimers();
    try {
      const state = new AppState(await mkdtemp(join(tmpdir(), "agent-webui-codex-init-timeout-")));
      const child = fakeCodexChild();
      const driver = new CodexDriver("codex", state, vi.fn(() => child) as any) as any;
      driver.resolvedBinary = Promise.resolve("codex");

      const initializing = driver.ensure();
      const rejected = expect(initializing).rejects.toThrow(/initialize timed out/);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(20_000);
      await rejected;
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(driver.child).toBeUndefined();
      expect(driver.pending.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("force-kills the shared app-server and lazily starts a clean replacement", async () => {
    const state = new AppState(await mkdtemp(join(tmpdir(), "agent-webui-codex-kill-")));
    const firstChild = fakeCodexChild();
    const secondChild = fakeCodexChild();
    const spawnProcess = vi.fn(() => secondChild);
    const driver = new CodexDriver("codex", state, spawnProcess as any) as any;
    driver.child = firstChild;
    driver.initializedChild = firstChild;
    driver.resolvedBinary = Promise.resolve("codex");
    driver.threads.set("thread-a", { active: true, turnId: "turn-a", steers: [], attached: true });
    driver.threads.set("thread-b", { active: true, turnId: "turn-b", steers: [], attached: true });
    const status = vi.fn();
    driver.on("status", status);

    driver.kill();

    expect(firstChild.kill).toHaveBeenCalledWith("SIGTERM");
    expect(driver.child).toBeUndefined();
    expect(driver.threads.get("thread-a")).toMatchObject({ active: false, attached: false });
    expect(driver.threads.get("thread-b")).toMatchObject({ active: false, attached: false });
    expect(status).toHaveBeenCalledTimes(2);

    const restarting = driver.ensure();
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1));
    const initializeId = [...driver.pending.keys()][0];
    driver.message({ id: initializeId, result: {} });
    await expect(restarting).resolves.toBeUndefined();
    expect(driver.child).toBe(secondChild);
  });

  it("coalesces transcript prewarm and prompt-side thread resume", async () => {
    const state = new AppState(await mkdtemp(join(tmpdir(), "agent-webui-codex-resume-"))); const driver = new CodexDriver("codex", state) as any;
    let release!: (value: unknown) => void;
    const request = vi.fn(() => new Promise<unknown>(resolve => { release = resolve; })); driver.request = request;

    const prewarm = driver.resume("thread");
    const promptResume = driver.resume("thread");
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("thread/resume", { threadId: "thread" });

    release({ thread: { cwd: "C:\\work" } });
    await Promise.all([prewarm, promptResume]);
    expect(driver.threads.get("thread")).toMatchObject({ attached: true, cwd: "C:\\work" });
  });

  it("steers an active turn and resends only after interrupted completion", async () => {
    const state = new AppState(await mkdtemp(join(tmpdir(), "agent-webui-codex-"))); const driver = new CodexDriver("codex", state) as any;
    driver.threads.set("thread", { active: true, turnId: "turn", steers: [] });
    const request = vi.fn(async () => ({})); driver.request = request;
    const result = await driver.prompt("thread", "steered text"); expect(result.steered).toBe(true);
    expect(request).toHaveBeenCalledWith("turn/steer", expect.objectContaining({ threadId: "thread", expectedTurnId: "turn" }));
    request.mockClear(); driver.notification("turn/completed", { threadId: "thread", turn: { status: "interrupted" } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(request).toHaveBeenCalledWith("turn/start", expect.objectContaining({ input: [{ type: "text", text: "steered text", text_elements: [] }] }));
  });
  it("deduplicates a retried browser prompt by client UUID", async () => {
    const state = new AppState(await mkdtemp(join(tmpdir(), "agent-webui-codex-idempotent-"))); const driver = new CodexDriver("codex", state) as any;
    driver.threads.set("thread", { active: true, attached: true, turnId: "turn", steers: [] });
    const request = vi.fn(async () => ({})); driver.request = request;
    const first = await driver.prompt("thread", "same text", undefined, [], "client-1");
    const second = await driver.prompt("thread", "same text", undefined, [], "client-1");
    expect(first).toEqual({ sessionId: "thread", steered: true });
    expect(second).toEqual(first);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("turn/steer", expect.objectContaining({ clientUserMessageId: "client-1" }));
    expect(driver.threads.get("thread").steers).toEqual([{ text: "same text", images: [], clientUuid: "client-1" }]);
  });
  it("coalesces concurrent UUID retries and preserves steered images after interrupt", async () => {
    const state = new AppState(await mkdtemp(join(tmpdir(), "agent-webui-codex-concurrent-"))); const driver = new CodexDriver("codex", state) as any;
    driver.threads.set("thread", { active: true, attached: true, turnId: "turn", steers: [] });
    let release!: () => void;
    const request = vi.fn(() => new Promise<void>(resolve => { release = resolve; })); driver.request = request;
    const first = driver.prompt("thread", "with image", undefined, ["C:\\safe\\one.png"], "client-image");
    const retry = driver.prompt("thread", "with image", undefined, ["C:\\safe\\one.png"], "client-image");
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all([first, retry])).resolves.toEqual([{ sessionId: "thread", steered: true }, { sessionId: "thread", steered: true }]);
    request.mockClear(); request.mockResolvedValue({});
    driver.notification("turn/completed", { threadId: "thread", turn: { status: "interrupted" } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(request).toHaveBeenCalledWith("turn/start", expect.objectContaining({ input: [
      { type: "localImage", path: "C:\\safe\\one.png" },
      { type: "text", text: "with image", text_elements: [] },
    ] }));
  });
  it("waits for a delayed turn/started notification before steering", async () => {
    const state = new AppState(await mkdtemp(join(tmpdir(), "agent-webui-codex-turn-ready-"))); const driver = new CodexDriver("codex", state) as any;
    driver.threads.set("thread", { active: false, attached: true, steers: [] });
    const request = vi.fn(async () => ({})); driver.request = request;
    await driver.prompt("thread", "first");
    const second = driver.prompt("thread", "second");
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    driver.notification("turn/started", { threadId: "thread", turn: { id: "turn-late" } });
    await expect(second).resolves.toEqual({ sessionId: "thread", steered: true });
    expect(request).toHaveBeenLastCalledWith("turn/steer", expect.objectContaining({ expectedTurnId: "turn-late" }));
  });
  it("keeps Fast service tier separate from reasoning effort", async () => {
    const state = new AppState(await mkdtemp(join(tmpdir(), "agent-webui-codex-tier-"))); const driver = new CodexDriver("codex", state) as any;
    driver.threads.set("thread", { active: false, attached: true, steers: [], cwd: "C:\\work" });
    const request = vi.fn(async (method: string) => method === "turn/start" ? { turn: { id: "turn" } } : {});
    driver.request = request;

    await driver.prompt("thread", "hello", { effort: "medium", serviceTier: "priority", cwd: "C:\\work" });
    expect(request).toHaveBeenCalledWith("turn/start", expect.objectContaining({
      threadId: "thread",
      effort: "medium",
      serviceTier: "priority",
    }));

    request.mockClear();
    await driver.updateSettings("thread", { serviceTier: null, cwd: "C:\\work" });
    expect(request).toHaveBeenCalledWith("thread/settings/update", {
      threadId: "thread",
      serviceTier: null,
    });
  });
  it("surfaces the app-server error from a failed turn", async () => {
    const state = new AppState(await mkdtemp(join(tmpdir(), "agent-webui-codex-turn-error-"))); const driver = new CodexDriver("codex", state) as any;
    const errors: unknown[] = [];
    driver.on("turn-error", (event: unknown) => errors.push(event));
    driver.notification("turn/completed", {
      threadId: "thread",
      turn: {
        id: "turn",
        status: "failed",
        error: { message: "Invalid reasoning effort", additionalDetails: "Use medium" },
      },
    });
    expect(errors).toEqual([{
      sessionId: "thread",
      turnId: "turn",
      message: "Invalid reasoning effort",
      details: "Use medium",
    }]);
  });
  it("uses the installed compact and goal method contracts", async () => {
    const state = new AppState(await mkdtemp(join(tmpdir(), "agent-webui-codex-methods-"))); const driver = new CodexDriver("codex", state) as any;
    const request = vi.fn(async () => ({})); driver.request = request;
    await driver.compact("thread");
    await driver.goalGet("thread");
    await driver.goalSet("thread", { objective: "ship", status: "active", tokenBudget: 123 });
    await driver.goalClear("thread");
    expect(request.mock.calls).toEqual([
      ["thread/compact/start", { threadId: "thread" }],
      ["thread/goal/get", { threadId: "thread" }],
      ["thread/goal/set", { threadId: "thread", objective: "ship", status: "active", tokenBudget: 123 }],
      ["thread/goal/clear", { threadId: "thread" }],
    ]);
  });
  it("creates a persistent fork and immediately registers it for prompting", async () => {
    const state = new AppState(await mkdtemp(join(tmpdir(), "agent-webui-codex-fork-"))); const driver = new CodexDriver("codex", state) as any;
    driver.threads.set("source", { active: false, attached: true, steers: [], cwd: "C:\\work" });
    const request = vi.fn(async () => ({
      thread: {
        id: "forked",
        path: "C:\\rollouts\\forked.jsonl",
        cwd: "C:\\work",
      },
    }));
    driver.request = request;
    await driver.fork("source", { beforeTurnId: "turn-7" });
    expect(request).toHaveBeenCalledWith("thread/fork", {
      threadId: "source",
      beforeTurnId: "turn-7",
      ephemeral: false,
    });
    expect(driver.threads.get("forked")).toEqual({
      active: false,
      steers: [],
      cwd: "C:\\work",
      attached: true,
    });
  });
  it("normalizes command and user-input server responses", async () => {
    const state = new AppState(await mkdtemp(join(tmpdir(), "agent-webui-codex-approval-"))); const driver = new CodexDriver("codex", state) as any;
    const sent: any[] = []; driver.send = (value: unknown) => sent.push(value);
    driver.inboundRequest(10, "item/commandExecution/requestApproval", { threadId: "thread", command: "echo hi" });
    driver.respond("thread", "codex-10", true);
    expect(sent.at(-1).result).toEqual({ decision: "accept" });
    driver.inboundRequest(11, "item/tool/requestUserInput", { threadId: "thread", questions: [{ id: "q1", header: "Choice", question: "Pick", options: [{ label: "A", description: "" }] }] });
    driver.respond("thread", "codex-11", "A");
    expect(sent.at(-1).result).toEqual({ answers: { q1: { answers: ["A"] } } });
    expect(() => driver.respond("thread", "codex-11", "A")).toThrowError(/no longer pending/);
    driver.inboundRequest(12, "item/tool/requestUserInput", {
      threadId: "thread",
      questions: [
        { id: "target", header: "Target", question: "Where?" },
        { id: "features", header: "Features", question: "Which?", multiSelect: true },
      ],
    });
    driver.respond("thread", "codex-12", { target: "Local", features: ["Tests", "Docs"] });
    expect(sent.at(-1).result).toEqual({
      answers: {
        target: { answers: ["Local"] },
        features: { answers: ["Tests", "Docs"] },
      },
    });
  });
  it("clears non-durable steers after an app-server crash", async () => {
    const state = new AppState(await mkdtemp(join(tmpdir(), "agent-webui-codex-crash-"))); const driver = new CodexDriver("codex", state) as any;
    driver.threads.set("thread", { active: true, attached: true, steers: [{ text: "lost", images: [] }] });
    driver.failed(new Error("crash"));
    expect(driver.threads.get("thread")).toMatchObject({ active: false, attached: false, steers: [] });
  });
  it("lists canonical names from active and archived Codex state pages", async () => {
    const state = new AppState(await mkdtemp(join(tmpdir(), "agent-webui-codex-names-")));
    const driver = new CodexDriver("codex", state) as any;
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      expect(method).toBe("thread/list");
      expect(params).toMatchObject({ limit: 100, useStateDbOnly: true });
      if (params.archived === false && params.cursor === undefined) {
        return {
          data: [
            { id: "active-1", name: "  Shared \n name  " },
            { id: "active-2", name: null },
          ],
          nextCursor: "next-active",
        };
      }
      if (params.archived === false && params.cursor === "next-active") {
        return { data: [{ id: "active-3", name: "Third" }], nextCursor: null };
      }
      return { data: [{ id: "archived-1", name: "Archived" }], nextCursor: null };
    });
    driver.request = request;

    await expect(driver.threadNames()).resolves.toEqual(new Map([
      ["active-1", "Shared name"],
      ["active-2", null],
      ["active-3", "Third"],
      ["archived-1", "Archived"],
    ]));
    expect(request).toHaveBeenCalledTimes(3);
  });
  it("reads and writes one canonical Codex thread name", async () => {
    const state = new AppState(await mkdtemp(join(tmpdir(), "agent-webui-codex-name-")));
    const driver = new CodexDriver("codex", state) as any;
    const request = vi.fn(async (method: string) => (
      method === "thread/read" ? { thread: { name: "  Shared \n title  " } } : {}
    ));
    driver.request = request;

    await expect(driver.threadName("thread")).resolves.toBe("Shared title");
    await driver.setThreadName("thread", `  ${"x".repeat(130)}  `);
    expect(request.mock.calls).toEqual([
      ["thread/read", { threadId: "thread", includeTurns: false }],
      ["thread/name/set", { threadId: "thread", name: "x".repeat(120) }],
    ]);
  });
  it("reads and normalizes Codex account rate-limit windows", async () => {
    const state = new AppState(await mkdtemp(join(tmpdir(), "agent-webui-codex-limits-")));
    const driver = new CodexDriver("codex", state) as any;
    const request = vi.fn(async () => ({
      rateLimits: {
        planType: "plus",
        primary: { usedPercent: 91, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 27.5, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
      },
      rateLimitsByLimitId: {
        codex: {
          plan_type: "team",
          primary: { used_percent: 30, window_duration_mins: 300, resets_at: 1_900_000_000 },
          secondary: { used_percent: 8, window_duration_mins: 10_080, resets_at: 1_900_500_000 },
        },
      },
    }));
    driver.request = request;

    await expect(driver.rateLimits()).resolves.toEqual({
      planType: "team",
      primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1_900_000_000 },
      secondary: { usedPercent: 8, windowDurationMins: 10_080, resetsAt: 1_900_500_000 },
    });
    expect(request).toHaveBeenCalledWith("account/rateLimits/read", undefined);
  });
});
