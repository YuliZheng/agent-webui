import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const CONNECT_TIMEOUT_MS = 1_500;
const STARTUP_TIMEOUT_MS = 15_000;
const MAX_QUEUED_BYTES = 64 * 1024 * 1024;

export interface ProxyOptions {
  binary: string;
  endpoint: string;
  endpointPath?: string;
  tokenPath: string;
  logPath: string;
  pidPath: string;
}

export interface RuntimeLaunchSpec {
  executable: string;
  args: string[];
  options: {
    detached: boolean;
    shell: false;
    stdio: "ignore";
    windowsHide: true;
    env: NodeJS.ProcessEnv;
  };
}

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function optionalOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value || undefined;
}

export function validateEndpoint(value: string): string {
  const endpoint = new URL(value);
  if (endpoint.protocol !== "ws:") throw new Error("Persistent Codex runtime must use ws://");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) {
    throw new Error("Persistent Codex runtime must listen on loopback");
  }
  if (!endpoint.port) throw new Error("Persistent Codex runtime endpoint requires a port");
  if (endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
    throw new Error("Persistent Codex runtime endpoint cannot include a path, query, or fragment");
  }
  return `ws://${endpoint.host}`;
}

function ensureToken(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  try {
    const current = readFileSync(path, "utf8").trim();
    if (current.length < 32) throw new Error("Persistent Codex runtime token is too short");
    return current;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const created = randomBytes(32).toString("hex");
  try {
    writeFileSync(path, `${created}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return created;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = readFileSync(path, "utf8").trim();
    if (raced.length < 32) throw new Error("Persistent Codex runtime token is too short");
    return raced;
  }
}

function connect(endpoint: string, token: string): Promise<WebSocket> {
  return new Promise((resolveConnection, rejectConnection) => {
    const socket = new WebSocket(endpoint, {
      headers: { Authorization: `Bearer ${token}` },
      handshakeTimeout: CONNECT_TIMEOUT_MS,
    });
    let settled = false;
    const reject = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.terminate();
      rejectConnection(error);
    };
    socket.once("open", () => {
      if (settled) return;
      settled = true;
      resolveConnection(socket);
    });
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) => {
      reject(new Error(`Persistent Codex runtime rejected the WebSocket handshake (${response.statusCode})`));
    });
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}

async function endpointIsBindable(endpoint: string): Promise<boolean> {
  const url = new URL(endpoint);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port);
  const server = createServer();
  return await new Promise<boolean>((resolveBindable, rejectBindable) => {
    const finish = (result: boolean) => {
      server.removeAllListeners();
      resolveBindable(result);
    };
    server.once("error", error => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE" || code === "EACCES") finish(false);
      else rejectBindable(error);
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close(error => error ? rejectBindable(error) : finish(true));
    });
  });
}

async function unusedLoopbackEndpoint(): Promise<string> {
  const server = createServer();
  return await new Promise<string>((resolveEndpoint, rejectEndpoint) => {
    server.once("error", rejectEndpoint);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectEndpoint(new Error("Could not allocate a persistent Codex runtime endpoint"));
        return;
      }
      const endpoint = `ws://127.0.0.1:${address.port}`;
      server.close(error => error ? rejectEndpoint(error) : resolveEndpoint(endpoint));
    });
  });
}

function readStoredEndpoint(options: ProxyOptions): string {
  if (!options.endpointPath) return options.endpoint;
  try {
    return validateEndpoint(readFileSync(options.endpointPath, "utf8").trim());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // A partial or obsolete endpoint file should not prevent recovery.
      process.stderr.write("Ignoring an invalid persistent Codex runtime endpoint file\n");
    }
    return options.endpoint;
  }
}

export async function persistFallbackEndpoint(path: string): Promise<string> {
  const endpoint = await unusedLoopbackEndpoint();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${endpoint}\n`, { encoding: "utf8", mode: 0o600 });
  return endpoint;
}

function proxyOptionArgs(options: ProxyOptions): string[] {
  return [
    "--binary", options.binary,
    "--endpoint", options.endpoint,
    ...(options.endpointPath ? ["--endpoint-file", options.endpointPath] : []),
    "--token-file", options.tokenPath,
    "--log-file", options.logPath,
    "--pid-file", options.pidPath,
  ];
}

/**
 * The supervisor, rather than Codex itself, is the only detached process.
 * This lets it survive a WebUI backend restart while keeping the real Codex
 * app-server attached to a hidden process tree. On Windows that distinction is
 * what prevents MCP grandchildren from allocating visible console windows.
 */
export function persistentRuntimeSupervisorLaunch(
  options: ProxyOptions,
  proxyPath = fileURLToPath(import.meta.url),
): RuntimeLaunchSpec {
  return {
    executable: process.execPath,
    args: [proxyPath, "--supervise-runtime", ...proxyOptionArgs(options)],
    options: {
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, AGENT_WEBUI: "1", AGENT_WEBUI_RUNTIME_SUPERVISOR: "1" },
    },
  };
}

export function supervisedCodexRuntimeLaunch(options: ProxyOptions): RuntimeLaunchSpec {
  return {
    executable: options.binary,
    args: [
    "app-server",
    "--listen",
    options.endpoint,
    "--ws-auth",
    "capability-token",
    "--ws-token-file",
    options.tokenPath,
    ],
    options: {
      detached: false,
      shell: false,
      // Codex 0.150 emits per-span INFO traces even with RUST_LOG/CODEX_LOG set
      // to warn. Ignoring runtime stdio also prevents unbounded log growth.
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, AGENT_WEBUI: "1", AGENT_WEBUI_RUNTIME: "1" },
    },
  };
}

function clearOwnedPid(path: string, pid: number): void {
  try {
    if (Number(readFileSync(path, "utf8").trim()) === pid) unlinkSync(path);
  } catch {
    // The runtime may have been cleaned up concurrently or never wrote a PID.
  }
}

async function superviseRuntime(options: ProxyOptions): Promise<void> {
  mkdirSync(dirname(options.pidPath), { recursive: true });
  const launch = supervisedCodexRuntimeLaunch(options);
  const child = spawn(launch.executable, launch.args, launch.options);
  const pid = child.pid;
  if (!pid) {
    child.kill();
    throw new Error("Persistent Codex runtime did not expose a process ID");
  }
  writeFileSync(options.pidPath, `${pid}\n`, "ascii");

  const stop = () => {
    if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await new Promise<void>((resolveExit, rejectExit) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        error ? rejectExit(error) : resolveExit();
      };
      child.once("error", error => finish(error));
      child.once("exit", (code, signal) => {
        if (code === 0 || signal) finish();
        else finish(new Error(`Persistent Codex runtime exited with code ${code}`));
      });
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    clearOwnedPid(options.pidPath, pid);
  }
}

function launchRuntime(options: ProxyOptions): void {
  mkdirSync(dirname(options.pidPath), { recursive: true });
  const launch = persistentRuntimeSupervisorLaunch(options);
  const supervisor = spawn(launch.executable, launch.args, launch.options);
  supervisor.unref();
}

async function connectOrStart(options: ProxyOptions, token: string): Promise<WebSocket> {
  let endpoint = readStoredEndpoint(options);
  try {
    return await connect(endpoint, token);
  } catch {
    // A killed Windows process can leave a ghost LISTEN row: connects are
    // refused, yet binding the same port still returns EADDRINUSE. Retry once
    // for a concurrently starting runtime, then move to a persisted free port.
    if (options.endpointPath && !(await endpointIsBindable(endpoint))) {
      await sleep(250);
      try {
        return await connect(endpoint, token);
      } catch {
        endpoint = await persistFallbackEndpoint(options.endpointPath);
      }
    }
    launchRuntime({ ...options, endpoint });
  }
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let delay = 50;
  let lastError: unknown;
  while (Date.now() < deadline) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, delay));
    try {
      return await connect(endpoint, token);
    } catch (error) {
      lastError = error;
      delay = Math.min(1_000, delay * 2);
    }
  }
  throw new Error(
    `Persistent Codex runtime did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function main(): Promise<void> {
  const endpointPath = optionalOption("--endpoint-file");
  const options: ProxyOptions = {
    binary: resolve(option("--binary")),
    endpoint: validateEndpoint(option("--endpoint")),
    endpointPath: endpointPath ? resolve(endpointPath) : undefined,
    tokenPath: resolve(option("--token-file")),
    logPath: resolve(option("--log-file")),
    pidPath: resolve(option("--pid-file")),
  };
  if (process.argv.includes("--supervise-runtime")) {
    ensureToken(options.tokenPath);
    await superviseRuntime(options);
    return;
  }
  const token = ensureToken(options.tokenPath);
  process.stdin.setEncoding("utf8");
  let input = "";
  let queuedBytes = 0;
  const queued: string[] = [];
  let socket: WebSocket | undefined;
  let shuttingDown = false;

  const send = (line: string) => {
    if (!line) return;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(line);
      return;
    }
    queuedBytes += Buffer.byteLength(line);
    if (queuedBytes > MAX_QUEUED_BYTES) throw new Error("Persistent Codex proxy input queue exceeded 64 MiB");
    queued.push(line);
  };
  process.stdin.on("data", chunk => {
    try {
      input += chunk;
      for (;;) {
        const newline = input.indexOf("\n");
        if (newline < 0) break;
        const line = input.slice(0, newline).trimEnd();
        input = input.slice(newline + 1);
        send(line);
      }
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  });

  socket = await connectOrStart(options, token);
  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      process.stderr.write("Persistent Codex runtime sent an unsupported binary frame\n");
      socket?.terminate();
      return;
    }
    process.stdout.write(`${String(data)}\n`);
  });
  socket.on("error", error => process.stderr.write(`Persistent Codex runtime WebSocket error: ${error.message}\n`));
  socket.on("close", (code, reason) => {
    if (!shuttingDown) process.stderr.write(`Persistent Codex runtime connection closed (${code}${reason.length ? `: ${String(reason)}` : ""})\n`);
    process.exit(shuttingDown ? 0 : 1);
  });
  for (const line of queued.splice(0)) socket.send(line);
  queuedBytes = 0;

  const close = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (input.trim()) send(input.trimEnd());
    if (socket?.readyState === WebSocket.OPEN) {
      socket.close(1000, "WebUI transport restart");
      setTimeout(() => process.exit(0), 1_000).unref();
    } else {
      process.exit(0);
    }
  };
  process.stdin.on("end", close);
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
