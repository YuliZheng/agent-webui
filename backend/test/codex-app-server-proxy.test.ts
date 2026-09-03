import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  persistFallbackEndpoint,
  persistentRuntimeSupervisorLaunch,
  supervisedCodexRuntimeLaunch,
  validateEndpoint,
} from "../src/codex-app-server-proxy.js";
import { resolveCodexExecutable } from "../src/util/executable.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.allSettled(cleanup.splice(0).map(task => task())); });

function proxyClient(args: string[]): {
  child: ChildProcessWithoutNullStreams;
  request(id: number, method: string, params: unknown): Promise<Record<string, unknown>>;
} {
  const child = spawn(process.execPath, args, { shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  let buffer = "";
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { errors = `${errors}${String(chunk)}`.slice(-8_192); });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += String(chunk);
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      const message = JSON.parse(line) as Record<string, unknown>;
      const id = typeof message.id === "number" ? message.id : undefined;
      if (id !== undefined) { pending.get(id)?.(message); pending.delete(id); }
    }
  });
  return {
    child,
    request(id, method, params) {
      return new Promise((resolveResponse, rejectResponse) => {
        const timer = setTimeout(() => rejectResponse(new Error(`RPC ${id} timed out. ${errors}`)), 20_000);
        pending.set(id, value => { clearTimeout(timer); resolveResponse(value); });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
  };
}

async function closeProxy(child: ChildProcessWithoutNullStreams): Promise<void> {
  const exited = new Promise<void>((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error("Proxy did not exit")), 5_000);
    child.once("exit", () => { clearTimeout(timer); resolveExit(); });
  });
  child.stdin.end();
  await exited;
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP address");
  await new Promise<void>((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
  return address.port;
}

function visibleWindowsInProcessTree(rootPid: number): number {
  if (process.platform !== "win32") return 0;
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = [
    "$agentWebuiProcesses = @(Get-CimInstance Win32_Process)",
    "$agentWebuiIds = [Collections.Generic.HashSet[int]]::new()",
    `[void]$agentWebuiIds.Add(${rootPid})`,
    "do {",
    "  $agentWebuiAdded = $false",
    "  foreach ($agentWebuiCandidate in $agentWebuiProcesses) {",
    "    if ($agentWebuiIds.Contains([int]$agentWebuiCandidate.ParentProcessId) -and $agentWebuiIds.Add([int]$agentWebuiCandidate.ProcessId)) { $agentWebuiAdded = $true }",
    "  }",
    "} while ($agentWebuiAdded)",
    "$agentWebuiVisible = 0",
    "foreach ($agentWebuiId in $agentWebuiIds) {",
    "  $agentWebuiProcess = Get-Process -Id $agentWebuiId -ErrorAction SilentlyContinue",
    "  if ($agentWebuiProcess -and $agentWebuiProcess.MainWindowHandle -ne 0) { $agentWebuiVisible++ }",
    "}",
    "[Console]::Write($agentWebuiVisible)",
  ].join("\n");
  const output = execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  return Number(output);
}

describe("persistent Codex runtime proxy", () => {
  it("accepts only explicit loopback WebSocket endpoints", () => {
    expect(validateEndpoint("ws://127.0.0.1:3458")).toBe("ws://127.0.0.1:3458");
    expect(validateEndpoint("ws://localhost:3458")).toBe("ws://localhost:3458");
    expect(() => validateEndpoint("ws://localhost:3458/runtime")).toThrow("cannot include a path");
    expect(() => validateEndpoint("wss://127.0.0.1:3458")).toThrow("must use ws://");
    expect(() => validateEndpoint("ws://0.0.0.0:3458")).toThrow("must listen on loopback");
    expect(() => validateEndpoint("ws://127.0.0.1")).toThrow("requires a port");
  });

  it("persists a newly allocated loopback endpoint for stale-port recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-runtime-endpoint-"));
    cleanup.push(async () => { await rm(root, { recursive: true, force: true }); });
    const endpointPath = join(root, "runtime.endpoint");

    const endpoint = await persistFallbackEndpoint(endpointPath);

    expect(validateEndpoint(endpoint)).toBe(endpoint);
    expect((await readFile(endpointPath, "utf8")).trim()).toBe(endpoint);
    expect(endpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
  });

  it("detaches only the hidden supervisor and keeps the Codex runtime attached", () => {
    const options = {
      binary: "C:\\Codex\\codex.exe",
      endpoint: "ws://127.0.0.1:3458",
      endpointPath: "C:\\state\\runtime.endpoint",
      tokenPath: "C:\\state\\runtime.token",
      logPath: "C:\\state\\runtime.log",
      pidPath: "C:\\state\\runtime.pid",
    };

    const supervisor = persistentRuntimeSupervisorLaunch(options, "C:\\app\\runtime-proxy.js");
    expect(supervisor.executable).toBe(process.execPath);
    expect(supervisor.args).toEqual([
      "C:\\app\\runtime-proxy.js",
      "--supervise-runtime",
      "--binary", options.binary,
      "--endpoint", options.endpoint,
      "--endpoint-file", options.endpointPath,
      "--token-file", options.tokenPath,
      "--log-file", options.logPath,
      "--pid-file", options.pidPath,
    ]);
    expect(supervisor.options).toMatchObject({
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });

    const runtime = supervisedCodexRuntimeLaunch(options);
    expect(runtime.executable).toBe(options.binary);
    expect(runtime.args).toEqual([
      "app-server",
      "--listen", options.endpoint,
      "--ws-auth", "capability-token",
      "--ws-token-file", options.tokenPath,
    ]);
    expect(runtime.options).toMatchObject({
      detached: false,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
  });

  it("keeps persistent runtime as the single backend/launcher default", async () => {
    const server = await readFile(resolve("src/server.ts"), "utf8");
    const restartScript = await readFile(resolve("../scripts/restart-agent-webui.ps1"), "utf8");

    expect(server).toContain('process.env.AGENT_WEBUI_CODEX_RUNTIME ?? "persistent"');
    expect(restartScript).not.toContain('$codexRuntime = "stdio"');
    expect(restartScript).toContain('if (-not [string]::IsNullOrWhiteSpace($codexRuntime))');
  });

  it.skipIf(process.env.AGENT_WEBUI_RUNTIME_SMOKE !== "1")(
    "keeps one real app-server alive while two WebUI proxies reconnect",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "agent-webui-runtime-smoke-"));
      const endpoint = `ws://127.0.0.1:${await unusedLoopbackPort()}`;
      const proxyPath = resolve("dist/codex-app-server-proxy.js");
      const binary = await resolveCodexExecutable(process.env.AGENT_WEBUI_CODEX_BINARY || "codex");
      const tokenPath = join(root, "token");
      const logPath = join(root, "runtime.log");
      const pidPath = join(root, "runtime.pid");
      let runtimePid = 0;
      cleanup.push(async () => {
        if (runtimePid) { try { process.kill(runtimePid, "SIGTERM"); } catch { /* already exited */ } }
        await rm(root, { recursive: true, force: true });
      });
      const args = [
        proxyPath,
        "--binary", binary,
        "--endpoint", endpoint,
        "--token-file", tokenPath,
        "--log-file", logPath,
        "--pid-file", pidPath,
      ];

      const first = proxyClient(args);
      const initialized = await first.request(1, "initialize", {
        clientInfo: { name: "runtime-smoke", version: "1" },
        capabilities: { experimentalApi: true },
      });
      expect(initialized).toHaveProperty("result");
      first.child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
      expect(await first.request(2, "thread/loaded/list", { limit: 10 })).toHaveProperty("result.data");
      runtimePid = Number((await readFile(pidPath, "utf8")).trim());
      expect(() => process.kill(runtimePid, 0)).not.toThrow();
      expect(visibleWindowsInProcessTree(runtimePid)).toBe(0);
      await closeProxy(first.child);

      expect(() => process.kill(runtimePid, 0)).not.toThrow();

      const second = proxyClient(args);
      expect(await second.request(3, "initialize", {
        clientInfo: { name: "runtime-smoke", version: "2" },
        capabilities: { experimentalApi: true },
      })).toHaveProperty("result");
      second.child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
      expect(await second.request(4, "thread/loaded/list", { limit: 10 })).toHaveProperty("result.data");
      await closeProxy(second.child);
      expect(Number((await readFile(pidPath, "utf8")).trim())).toBe(runtimePid);
      expect(() => process.kill(runtimePid, 0)).not.toThrow();
    },
    30_000,
  );

  it.skipIf(process.env.AGENT_WEBUI_RUNTIME_TURN_SMOKE !== "1")(
    "resumes the same in-progress turn after its first WebUI proxy exits",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "agent-webui-runtime-turn-smoke-"));
      const endpoint = `ws://127.0.0.1:${await unusedLoopbackPort()}`;
      const proxyPath = resolve("dist/codex-app-server-proxy.js");
      const binary = await resolveCodexExecutable(process.env.AGENT_WEBUI_CODEX_BINARY || "codex");
      const tokenPath = join(root, "token");
      const logPath = join(root, "runtime.log");
      const pidPath = join(root, "runtime.pid");
      const args = [
        proxyPath,
        "--binary", binary,
        "--endpoint", endpoint,
        "--token-file", tokenPath,
        "--log-file", logPath,
        "--pid-file", pidPath,
      ];
      let runtimePid = 0;
      let threadId = "";
      let second: ReturnType<typeof proxyClient> | undefined;
      cleanup.push(async () => {
        if (second && second.child.exitCode === null) {
          try { await closeProxy(second.child); } catch { second.child.kill("SIGKILL"); }
        }
        if (runtimePid) { try { process.kill(runtimePid, "SIGTERM"); } catch { /* already exited */ } }
        await rm(root, { recursive: true, force: true });
      });

      const first = proxyClient(args);
      expect(await first.request(10, "initialize", {
        clientInfo: { name: "runtime-turn-smoke", version: "1" },
        capabilities: { experimentalApi: true },
      })).toHaveProperty("result");
      first.child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
      const started = await first.request(11, "thread/start", {
        cwd: root,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
      threadId = String((started.result as { thread?: { id?: string } })?.thread?.id ?? "");
      expect(threadId).toMatch(/^[0-9a-f-]{36}$/i);
      const turnStarted = await first.request(12, "turn/start", {
        threadId,
        input: [{ type: "text", text: "Run this exact PowerShell command and wait for it to finish: Start-Sleep -Seconds 12; Write-Output runtime-smoke-done", text_elements: [] }],
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      });
      const turnId = String((turnStarted.result as { turn?: { id?: string } })?.turn?.id ?? "");
      expect(turnId).toMatch(/^[0-9a-f-]{36}$/i);
      await closeProxy(first.child);

      runtimePid = Number((await readFile(pidPath, "utf8")).trim());
      expect(() => process.kill(runtimePid, 0)).not.toThrow();
      // Model the WebUI backend's stop/start window. The app-server and turn
      // must remain alive even with no proxy connection for several seconds.
      await new Promise(resolveDelay => setTimeout(resolveDelay, 4_000));
      second = proxyClient(args);
      expect(await second.request(13, "initialize", {
        clientInfo: { name: "runtime-turn-smoke", version: "2" },
        capabilities: { experimentalApi: true },
      })).toHaveProperty("result");
      second.child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
      const resumed = await second.request(14, "thread/resume", { threadId });
      const thread = (resumed.result as { thread?: { status?: { type?: string }; turns?: Array<{ id?: string; status?: string }> } })?.thread;
      expect(thread?.status?.type).toBe("active");
      expect(thread?.turns).toEqual(expect.arrayContaining([expect.objectContaining({ id: turnId, status: "inProgress" })]));
      expect(visibleWindowsInProcessTree(runtimePid)).toBe(0);

      expect(await second.request(15, "turn/interrupt", { threadId, turnId })).toHaveProperty("result");
      // Cleanup is process-scoped: current Codex versions can leave
      // thread/delete unanswered while an interrupted tool is unwinding. The
      // test runtime is terminated in afterEach, which stops the temporary turn
      // without weakening the reconnect assertion above.
      await closeProxy(second.child);
      second = undefined;
    },
    60_000,
  );
});
