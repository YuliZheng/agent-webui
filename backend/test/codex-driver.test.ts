import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  CODEX_THREAD_RESUME_TIMEOUT_MS,
  CODEX_REASONING_EFFORTS,
  CodexDriver,
  DEFAULT_CODEX_APP_SERVER_MAX_RECORD_BYTES,
} from "../src/services/codex-driver.js";
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
  it("reports malformed stdout without emitting Node's fatal error event", async () => {
    const state = new AppState(await mkdtemp(join(tmpdir(), "agent-webui-codex-malformed-")));
    const driver = new CodexDriver("codex", state) as any;
    const warning = vi.fn();
    driver.on("driver-error", warning);

    expect(() => driver.stdout("not-json\n")).not.toThrow();
    expect(warning).toHaveBeenCalledWith("Malformed Codex app-server record");
  });

  it("uses a 128 MiB app-server record limit and parses fragmented records", async () => {
    expect(DEFAULT_CODEX_APP_SERVER_MAX_RECORD_BYTES).toBe(128 * 1024 * 1024);
    const state = new AppState(await mkdtemp(join(tmpdir(), "agent-webui-codex-record-")));
    const child = fakeCodexChild();
    const driver = new CodexDriver("codex", state, vi.fn(() => child) as any, 256) as any;
    driver.child = child;
    driver.initializedChild = child;

    const request = driver.rawRequest("thread/resume", { threadId: "thread" });
    const id = [...driver.pending.keys()][0];
    const record = `${JSON.stringify({ id, result: { thread: { id: "thread", name: "x".repeat(80) } } })}\n`;
    driver.stdout(record.slice(0, 47));
    driver.stdout(record.slice(47));

    await expect(request).resolves.toMatchObject({ thread: { id: "thread" } });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("surfaces a specific error before terminating an oversized app-server record", async () => {
    const state = new AppState(await mkdtemp(join(tmpdir(), "agent-webui-codex-oversized-")));
    const child = fakeCodexChild();
    const driver = new CodexDriver("codex", state, vi.fn(() => child) as any, 1024 * 1024) as any;
    driver.child = child;
    driver.initializedChild = child;
    const warning = vi.fn();
    driver.on("driver-error", warning);

    const request = driver.rawRequest("thread/resume", { threadId: "thread" });
    const rejected = expect(request).rejects.toThrow(/response exceeded the 1 MiB safety limit/);
    driver.stdout("x".repeat(1024 * 1024 + 1));

    await rejected;
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("AGENT_WEBUI_CODEX_MAX_RECORD_BYTES"));
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(driver.child).toBeUndefined();
  });

  it("reconciles a matching durable terminal exactly once without clearing a newer turn", async () => {
    const state = new AppState(await mkdtemp(join(tmpdir(), "agent-webui-codex-durable-terminal-")));
    const driver = new CodexDriver("codex", state) as any;
    driver.threads.set("thread", { active: true, attached: true, turnId: "turn-a", steers: [] });
    const statuses = vi.fn();
    driver.on("status", statuses);

    expect(driver.reconcileDurableTerminal(
      "thread",
      "turn-a",
      "completed",
      "2026-01-02T03:04:05Z",
    )).toBe(true);
    expect(driver.threads.get("thread")).toMatchObject({ active: false, turnId: undefined });
    expect(statuses).toHaveBeenCalledTimes(1);
    expect(statuses).toHaveBeenCalledWith({
      id: "thread",
      status: "exited",
      webuiAlive: true,
      lastBoundaryAt: "2026-01-02T03:04:05Z",
    });

    expect(driver.reconcileDurableTerminal("thread", "turn-a", "completed")).toBe(false);
    driver.threads.set("thread", { active: true, attached: true, turnId: "turn-b", steers: [] });
    expect(driver.reconcileDurableTerminal("thread", "turn-a", "completed")).toBe(false);
    expect(driver.threads.get("thread")).toMatchObject({ active: true, turnId: "turn-b" });
    expect(statuses).toHaveBeenCalledTimes(1);
  });

  it("clears running status when turn/start rejects", async () => {
    const state = new AppState(await mkdtemp(join(tmpdir(), "agent-webui-codex-start-reject-")));
    const driver = new CodexDriver("codex", state) as any;
    const statuses: unknown[] = [];
    driver.on("status", (event: unknown) => statuses.push(event));
    driver.threads.set("thread", { active: false, attached: true, steers: [] });
    driver.request = vi.fn(async () => { throw new Error("start rejected"); });

    await expect(driver.prompt("thread", "hello")).rejects.toThrow("start rejected");
    expect(driver.threads.get("thread")).toMatchObject({ active: false, turnId: undefined });
    expect(statuses).toEqual([
      expect.objectContaining({ id: "thread", status: "running", webuiAlive: true }),
      expect.objectContaining({ id: "thread", status: "failed", webuiAlive: true }),
    ]);
  });

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

  it("reports the official contextCompaction item lifecycle as a live compacting state", async () => {
    const state = new AppState(await mkdtemp(join(tmpdir(), "agent-webui-codex-compacting-")));
    const driver = new CodexDriver("codex", state) as any;
    driver.threads.set("thread", { active: true, turnId: "turn", steers: [] });
    const statuses: unknown[] = [];
    driver.on("status", (event: unknown) => statuses.push(event));

    driver.notification("item/started", {
      threadId: "thread",
      turnId: "turn",
      item: { id: "compact-1", type: "contextCompaction" },
    });
    expect(driver.threads.get("thread").compacting).toBe(true);
    expect(statuses.at(-1)).toEqual(expect.objectContaining({
      id: "thread",
      status: "running",
      compacting: true,
    }));

    driver.notification("item/completed", {
      threadId: "thread",
      turnId: "turn",
      item: { id: "compact-1", type: "contextCompaction" },
    });
    expect(driver.threads.get("thread").compacting).toBe(false);
    expect(statuses.at(-1)).toEqual(expect.objectContaining({
      id: "thread",
      status: "running",
      compacting: false,
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

  it("uses a thin local proxy for a persistent Codex runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-codex-persistent-"));
    const state = new AppState(root);
    const child = fakeCodexChild();
    const spawnProcess = vi.fn(() => child);
    const runtime = {
      proxyPath: join(root, "codex-app-server-proxy.js"),
      endpoint: "ws://127.0.0.1:3458/",
      tokenPath: join(root, "runtime.token"),
      logPath: join(root, "runtime.log"),
      pidPath: join(root, "runtime.pid"),
    };
    const driver = new CodexDriver(
      "codex",
      state,
      spawnProcess as any,
      DEFAULT_CODEX_APP_SERVER_MAX_RECORD_BYTES,
      join(root, "visualizations"),
      runtime,
    ) as any;
    driver.resolvedBinary = Promise.resolve("C:\\Codex\\codex.exe");

    const initializing = driver.ensure();
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1));
    const initializeId = [...driver.pending.keys()][0];
    driver.message({ id: initializeId, result: {} });
    await initializing;

    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      [
        runtime.proxyPath,
        "--binary", "C:\\Codex\\codex.exe",
        "--endpoint", runtime.endpoint,
        "--token-file", runtime.tokenPath,
        "--log-file", runtime.logPath,
        "--pid-file", runtime.pidPath,
      ],
      expect.objectContaining({ shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }),
    );
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
    expect(request).toHaveBeenCalledWith("thread/resume", {
      threadId: "thread",
      excludeTurns: true,
      initialTurnsPage: { limit: 1, itemsView: "notLoaded" },
    });

    release({ thread: { cwd: "C:\\work" } });
    await Promise.all([prewarm, promptResume]);
    expect(driver.threads.get("thread")).toMatchObject({ attached: true, cwd: "C:\\work" });
  });

  it("rehydrates an in-progress turn from the itemless initial resume page", async () => {
    const state = new AppState(await mkdtemp(join(tmpdir(), "agent-webui-codex-rehydrate-")));
    const driver = new CodexDriver("codex", state) as any;
    driver.request = vi.fn(async () => ({
      thread: {
        cwd: "C:\\work",
        status: { type: "active", activeFlags: [] },
      },
      initialTurnsPage: {
        data: [{ id: "turn-live", status: "inProgress", items: [] }],
      },
    }));
    const statuses = vi.fn();
    driver.on("status", statuses);

    await driver.resume("thread");

    expect(driver.threads.get("thread")).toMatchObject({
      attached: true,
      active: true,
      turnId: "turn-live",
      cwd: "C:\\work",
    });
    expect(statuses).toHaveBeenLastCalledWith(expect.objectContaining({
      id: "thread",
      status: "running",
      webuiAlive: true,
    }));
  });

  it("gives thread resume a longer RPC deadline without changing ordinary requests", async () => {
    const state = new AppState(await mkdtemp(join(tmpdir(), "agent-webui-codex-resume-timeout-")));
    const child = fakeCodexChild();
    const driver = new CodexDriver("codex", state) as any;
    driver.child = child;
    driver.initializedChild = child;
    driver.rawRequest = vi.fn(async () => ({}));

    await driver.request("thread/resume", { threadId: "thread" });
    await driver.request("turn/start", { threadId: "thread", input: [] });

    expect(driver.rawRequest).toHaveBeenNthCalledWith(
      1,
      "thread/resume",
      { threadId: "thread" },
      CODEX_THREAD_RESUME_TIMEOUT_MS,
    );
    expect(driver.rawRequest).toHaveBeenNthCalledWith(
      2,
      "turn/start",
      { threadId: "thread", input: [] },
      20_000,
    );
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
    driver.threads.set("thread", { active: false, attached: true, steers: [], cwd: "C:\\work" });
    await driver.prompt("thread", "standard", { serviceTier: null, cwd: "C:\\work" });
    expect(request).toHaveBeenCalledWith("turn/start", expect.objectContaining({
      threadId: "thread",
      serviceTier: null,
    }));

    request.mockClear();
    await driver.updateSettings("thread", { serviceTier: null, cwd: "C:\\work" });
    expect(request).toHaveBeenCalledWith("thread/settings/update", {
      threadId: "thread",
      serviceTier: null,
    });

    request.mockClear();
    request.mockImplementation(async (method: string) => method === "thread/start" ? { thread: { id: "new-thread" } } : {});
    await driver.newSession("C:\\work", "", { serviceTier: null });
    expect(request).toHaveBeenCalledWith("thread/start", expect.objectContaining({
      cwd: "C:\\work",
      serviceTier: null,
    }));
  });
  it("binds every turn to an authoritative thread-scoped visualization directory", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 28, 12, 0, 0));
    try {
      const root = await mkdtemp(join(tmpdir(), "agent-webui-codex-visualization-"));
      const visualizationsRoot = join(root, "visualizations");
      const state = new AppState(join(root, "state"));
      const driver = new CodexDriver(
        "codex",
        state,
        undefined,
        undefined,
        visualizationsRoot,
      ) as any;
      driver.threads.set("thread", { active: false, attached: true, steers: [], cwd: "C:\\work" });
      const request = vi.fn(async () => ({ turn: { id: "turn" } }));
      driver.request = request;

      await driver.prompt("thread", "make a chart", {
        cwd: "C:\\work",
        sandboxMode: "workspace-write",
      });

      const directory = join(visualizationsRoot, "2026", "08", "28", "thread");
      expect((await stat(directory)).isDirectory()).toBe(true);
      expect(request).toHaveBeenCalledWith("turn/start", expect.objectContaining({
        threadId: "thread",
        additionalContext: expect.objectContaining({
          "agent-webui.inline-visualization": expect.objectContaining({
            kind: "application",
            value: expect.stringContaining(directory),
          }),
        }),
        sandboxPolicy: expect.objectContaining({
          type: "workspaceWrite",
          writableRoots: ["C:\\work", directory],
        }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });
  it("routes new DeepSeek sessions through the DeepSeek provider", async () => {
    const state = new AppState(await mkdtemp(join(tmpdir(), "agent-webui-codex-deepseek-")));
    const driver = new CodexDriver("codex", state) as any;
    const request = vi.fn(async (method: string) => method === "thread/start"
      ? { thread: { id: "deepseek-thread" }, modelProvider: "deepseek" }
      : {});
    driver.request = request;

    await driver.newSession("C:\\work", "", {
      model: "deepseek-v4-flash",
      effort: "medium",
      serviceTier: "priority",
    });

    expect(request).toHaveBeenCalledWith("thread/start", expect.objectContaining({
      cwd: "C:\\work",
      model: "deepseek-v4-flash",
      modelProvider: "deepseek",
      effort: "high",
      serviceTier: null,
    }));
    expect(driver.threads.get("deepseek-thread")).toMatchObject({
      modelProvider: "deepseek",
      attached: true,
    });
  });
  it("rejects provider changes inside an existing Codex session", async () => {
    const state = new AppState(await mkdtemp(join(tmpdir(), "agent-webui-codex-provider-switch-")));
    const driver = new CodexDriver("codex", state) as any;
    driver.threads.set("thread", {
      active: false,
      attached: true,
      steers: [],
      modelProvider: "openai_http",
    });
    driver.request = vi.fn(async () => ({}));

    await expect(driver.updateSettings("thread", { model: "deepseek-v4-flash" }))
      .rejects.toThrow(/cannot be changed inside an existing session/);
    expect(driver.request).not.toHaveBeenCalled();
  });
  it("exposes live and legacy Fast service-tier capabilities", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-codex-capabilities-"));
    await writeFile(join(root, "models_cache.json"), JSON.stringify({
      models: [
        {
          slug: "camel",
          displayName: "Camel",
          supportedReasoningEfforts: [],
          serviceTiers: [{ id: "priority", name: "Fast", description: "Live tier" }],
          defaultServiceTier: "priority",
        },
        {
          slug: "snake",
          display_name: "Snake",
          supported_reasoning_efforts: [],
          service_tiers: [{ id: "fast", name: "Fast" }],
          default_service_tier: "fast",
        },
        {
          slug: "legacy",
          supported_reasoning_efforts: [],
          additional_speed_tiers: ["fast"],
        },
        {
          slug: "unsupported",
          supported_reasoning_efforts: [],
          service_tiers: [],
        },
        {
          slug: "reasoning-levels",
          supported_reasoning_levels: [
            { effort: "low", description: "Fast responses" },
            { effort: "ultra", description: "Maximum reasoning with delegation" },
          ],
          default_reasoning_level: "ultra",
          service_tiers: [],
        },
      ],
    }), "utf8");
    await writeFile(join(root, "models.json"), JSON.stringify({
      models: [{
        slug: "deepseek-v4-flash",
        display_name: "DeepSeek-V4-Flash",
        description: "Latest frontier agentic coding model.",
        default_reasoning_level: "high",
        supported_reasoning_levels: [
          { effort: "low" },
          { effort: "high" },
          { effort: "max" },
        ],
        service_tiers: [],
      }],
    }), "utf8");
    const prior = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;
    try {
      const driver = new CodexDriver("codex", new AppState(root));
      const capabilities = await driver.capabilities();
      expect(capabilities.models.find(model => model.value === "camel")).toMatchObject({
        defaultServiceTier: "priority",
        serviceTiers: [{ value: "priority", label: "Fast", description: "Live tier" }],
      });
      expect(capabilities.models.find(model => model.value === "snake")).toMatchObject({
        defaultServiceTier: "priority",
        serviceTiers: [{ value: "priority", label: "Fast" }],
      });
      expect(capabilities.models.find(model => model.value === "legacy")?.serviceTiers).toEqual([
        expect.objectContaining({ value: "priority", label: "Fast" }),
      ]);
      expect(capabilities.models.find(model => model.value === "unsupported")?.serviceTiers).toEqual([]);
      expect(capabilities.models.find(model => model.value === "reasoning-levels")).toMatchObject({
        defaultEffort: "ultra",
        supportedEfforts: [
          { value: "low", label: "low", description: "Fast responses" },
          { value: "ultra", label: "ultra", description: "Maximum reasoning with delegation" },
        ],
      });
      expect(capabilities.models.find(model => model.value === "deepseek-v4-flash")).toMatchObject({
        label: "DeepSeek-V4-Flash",
        defaultEffort: "high",
        supportedEfforts: [
          { value: "low", label: "low", description: null },
          { value: "high", label: "high", description: null },
          { value: "max", label: "max", description: null },
        ],
        serviceTiers: [],
      });
      expect(CODEX_REASONING_EFFORTS.at(-1)).toBe("ultra");
    } finally {
      if (prior === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prior;
    }
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
  it("retries a pre-output capacity failure with bounded backoff and no duplicate user input", async () => {
    vi.useFakeTimers();
    try {
      const state = new AppState(await mkdtemp(join(tmpdir(), "agent-webui-codex-capacity-retry-")));
      const driver = new CodexDriver("codex", state) as any;
      driver.threads.set("thread", { active: false, attached: true, steers: [], cwd: "C:\\work" });
      let nextTurn = 0;
      const request = vi.fn(async (method: string) => (
        method === "turn/start" ? { turn: { id: `turn-${++nextTurn}` } } : {}
      ));
      driver.request = request;
      const retries = vi.fn();
      const errors = vi.fn();
      driver.on("capacity-retry", retries);
      driver.on("turn-error", errors);

      await driver.prompt("thread", "run checks", {
        model: "gpt-5.6-sol",
        effort: "medium",
        cwd: "C:\\work",
      }, [], "client-1");
      driver.notification("error", {
        threadId: "thread",
        turnId: "turn-1",
        willRetry: false,
        error: {
          message: "Selected model is at capacity. Please try a different model.",
          codexErrorInfo: "serverOverloaded",
        },
      });
      expect(driver.reconcileDurableTerminal("thread", "turn-1", "completed")).toBe(true);

      expect(retries).toHaveBeenCalledWith({
        sessionId: "thread",
        turnId: "turn-1",
        attempt: 1,
        maxAttempts: 6,
        delayMs: 1_000,
      });
      expect(errors).not.toHaveBeenCalled();
      expect(driver.threads.get("thread")).toMatchObject({ active: true, turnId: undefined });

      // A delayed duplicate app-server completion must not cancel the retry
      // already scheduled from the durable rollout boundary.
      driver.notification("turn/completed", {
        threadId: "thread",
        turn: {
          id: "turn-1",
          status: "failed",
          error: {
            message: "Selected model is at capacity. Please try a different model.",
            codexErrorInfo: "serverOverloaded",
          },
        },
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(request).toHaveBeenCalledTimes(2);
      expect(request.mock.calls[1]).toEqual([
        "turn/start",
        expect.objectContaining({
          threadId: "thread",
          input: [],
          model: "gpt-5.6-sol",
          effort: "medium",
          additionalContext: expect.objectContaining({
            "agent-webui.capacity-retry": expect.objectContaining({ kind: "application" }),
          }),
        }),
      ]);
      expect(driver.threads.get("thread")).toMatchObject({ active: true, turnId: "turn-2" });

      driver.notification("turn/completed", {
        threadId: "thread",
        turn: { id: "turn-2", status: "completed" },
      });
      expect(driver.threads.get("thread")).toMatchObject({ active: false, turnId: undefined });
      expect(driver.threads.get("thread").capacityRetry).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
  it("continues from completed tool activity after a capacity failure", async () => {
    vi.useFakeTimers();
    try {
      const state = new AppState(await mkdtemp(join(tmpdir(), "agent-webui-codex-capacity-side-effect-")));
      const driver = new CodexDriver("codex", state) as any;
      driver.threads.set("thread", { active: false, attached: true, steers: [] });
      let nextTurn = 0;
      const request = vi.fn(async () => ({ turn: { id: `turn-${++nextTurn}` } }));
      driver.request = request;
      const errors = vi.fn();
      driver.on("turn-error", errors);

      await driver.prompt("thread", "change a file");
      driver.notification("item/started", {
        threadId: "thread",
        turnId: "turn-1",
        item: { id: "command-1", type: "commandExecution" },
      });
      driver.notification("item/completed", {
        threadId: "thread",
        turnId: "turn-1",
        item: { id: "command-1", type: "commandExecution", status: "completed" },
      });
      driver.notification("error", {
        threadId: "thread",
        turnId: "turn-1",
        willRetry: false,
        error: { message: "Selected model is at capacity.", codexErrorInfo: "serverOverloaded" },
      });
      driver.notification("turn/completed", {
        threadId: "thread",
        turn: {
          id: "turn-1",
          status: "failed",
          error: { message: "Selected model is at capacity.", codexErrorInfo: "serverOverloaded" },
        },
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(request).toHaveBeenCalledTimes(2);
      expect(request.mock.calls[1]).toEqual([
        "turn/start",
        expect.objectContaining({
          threadId: "thread",
          input: [],
          additionalContext: expect.objectContaining({
            "agent-webui.capacity-retry": expect.objectContaining({
              kind: "application",
              value: expect.stringContaining("partial progress"),
            }),
          }),
        }),
      ]);
      expect(errors).not.toHaveBeenCalled();
      expect(driver.threads.get("thread")).toMatchObject({ active: true, turnId: "turn-2" });

      driver.notification("turn/completed", {
        threadId: "thread",
        turn: { id: "turn-2", status: "completed" },
      });
      expect(driver.threads.get("thread")).toMatchObject({ active: false });
    } finally {
      vi.useRealTimers();
    }
  });
  it("stops retrying after six capacity retries and surfaces the final error", async () => {
    vi.useFakeTimers();
    try {
      const state = new AppState(await mkdtemp(join(tmpdir(), "agent-webui-codex-capacity-limit-")));
      const driver = new CodexDriver("codex", state) as any;
      driver.threads.set("thread", { active: false, attached: true, steers: [] });
      let nextTurn = 0;
      const request = vi.fn(async () => ({ turn: { id: `turn-${++nextTurn}` } }));
      driver.request = request;
      const errors = vi.fn();
      driver.on("turn-error", errors);

      await driver.prompt("thread", "hello");
      const fail = (turnId: string) => {
        const error = { message: "Selected model is at capacity.", codexErrorInfo: "serverOverloaded" };
        driver.notification("error", { threadId: "thread", turnId, willRetry: false, error });
        driver.notification("turn/completed", {
          threadId: "thread",
          turn: { id: turnId, status: "failed", error },
        });
      };

      const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
      for (let attempt = 1; attempt <= 6; attempt++) {
        fail(`turn-${attempt}`);
        await vi.advanceTimersByTimeAsync(delays[attempt - 1]!);
        expect(request).toHaveBeenCalledTimes(attempt + 1);
      }
      fail("turn-7");
      await vi.advanceTimersByTimeAsync(10_000);

      expect(request).toHaveBeenCalledTimes(7);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(errors).toHaveBeenCalledWith(expect.objectContaining({
        turnId: "turn-7",
        message: "Selected model is at capacity.",
      }));
      expect(driver.threads.get("thread")).toMatchObject({ active: false });
    } finally {
      vi.useRealTimers();
    }
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
  it("reads and normalizes the thread plus daily account usage overview", async () => {
    const state = new AppState(await mkdtemp(join(tmpdir(), "agent-webui-codex-usage-")));
    const driver = new CodexDriver("codex", state) as any;
    const request = vi.fn(async () => ({
      summary: { lifetimeTokens: 900_000_000 },
      daily_usage_buckets: [
        { start_date: "2026-08-27", tokens: 8_000_000 },
        { start_date: "invalid-without-tokens" },
      ],
      thread_usage: {
        thread_id: "thread-1",
        estimated_usage_credits_micros: 12_500_000,
        estimated_usage_usd_micros: null,
        groups: [{
          model: "gpt-5.6-sol",
          reasoning_effort: "high",
          speed: "standard",
          input_tokens: 120_000,
          cached_input_tokens: 80_000,
          net_new_input_tokens: 40_000,
          output_tokens: 5_000,
          total_tokens: 125_000,
          estimated_usage_credits_micros: 12_500_000,
        }],
      },
    }));
    driver.request = request;

    await expect(driver.usageOverview("thread-1")).resolves.toEqual({
      threadUsage: {
        threadId: "thread-1",
        estimatedUsageCreditsMicros: 12_500_000,
        estimatedUsageUsdMicros: null,
        groups: [{
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          speed: "standard",
          inputTokens: 120_000,
          cachedInputTokens: 80_000,
          netNewInputTokens: 40_000,
          outputTokens: 5_000,
          totalTokens: 125_000,
          estimatedUsageCreditsMicros: 12_500_000,
        }],
      },
      dailyUsageBuckets: [{ startDate: "2026-08-27", tokens: 8_000_000 }],
      accountLifetimeTokens: 900_000_000,
    });
    expect(request).toHaveBeenCalledWith("account/usage/read", undefined);
  });

  it("keeps account daily buckets when the optional thread-scoped lookup returns null fields", async () => {
    const state = new AppState(await mkdtemp(join(tmpdir(), "agent-webui-codex-usage-account-")));
    const driver = new CodexDriver("codex", state) as any;
    const request = vi.fn(async (_method: string, params: unknown) => params === undefined
      ? {
          summary: { lifetimeTokens: 12_700_000_000 },
          dailyUsageBuckets: [{ startDate: "2026-08-29", tokens: 152_000_000 }],
          threadUsage: null,
        }
      : {
          summary: { lifetimeTokens: null },
          dailyUsageBuckets: null,
          threadUsage: null,
        });
    driver.request = request;

    await expect(driver.usageOverview("thread-1")).resolves.toEqual({
      threadUsage: null,
      dailyUsageBuckets: [{ startDate: "2026-08-29", tokens: 152_000_000 }],
      accountLifetimeTokens: 12_700_000_000,
    });
    expect(request.mock.calls).toEqual([
      ["account/usage/read", undefined],
      ["account/usage/read", { threadId: "thread-1" }],
    ]);
  });
});
