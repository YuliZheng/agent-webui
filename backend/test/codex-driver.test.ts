import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexDriver } from "../src/services/codex-driver.js";
import { AppState } from "../src/services/state.js";

describe("Codex steer semantics", () => {
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
    await driver.fork("source", "turn-7");
    expect(request).toHaveBeenCalledWith("thread/fork", {
      threadId: "source",
      lastTurnId: "turn-7",
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
});
