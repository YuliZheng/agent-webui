import { appendFile, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../backend/dist/app.js";
import {
  clearLineIndexMemoryCache,
  jsonlIndexIoCounters,
  readTail,
  resetJsonlIndexIoCounters,
} from "../backend/dist/services/jsonl.js";

const SESSION_COUNT = 431;
const GIANT_RECORD_BYTES = 16 * 1024 * 1024;
const root = await mkdtemp(join(tmpdir(), "agent-webui-perf-"));
const claudeRoot = join(root, "claude");
const codexRoot = join(root, "codex");
const stateDir = join(root, "state");
const activePath = join(claudeRoot, "session-active.jsonl");

function mib(bytes) {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

async function requestSessions(app) {
  const response = await app.inject({
    method: "GET",
    url: "/api/sessions",
    headers: { authorization: `Bearer ${"a".repeat(64)}` },
  });
  if (response.statusCode !== 200) throw new Error(`Session request failed: ${response.statusCode}`);
  return response.json();
}

async function waitForSessions(app, count, timeoutMs = 90_000) {
  const deadline = performance.now() + timeoutMs;
  let sessions = [];
  while (performance.now() < deadline) {
    sessions = await requestSessions(app);
    if (sessions.length === count) return sessions;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out after discovering ${sessions.length}/${count} sessions`);
}

async function mapLimit(values, limit, fn) {
  let cursor = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      await fn(values[index], index);
    }
  }));
}

try {
  await mkdir(claudeRoot);
  await mkdir(codexRoot);
  const ids = Array.from({ length: SESSION_COUNT - 1 }, (_, index) => `session-${String(index).padStart(4, "0")}`);
  await mapLimit(ids, 16, async id => {
    await writeFile(join(claudeRoot, `${id}.jsonl`), `${JSON.stringify({
      type: "user",
      cwd: root,
      uuid: `${id}-user`,
      timestamp: "2026-07-23T00:00:00.000Z",
      message: { content: `synthetic prompt ${id}` },
    })}\n`);
  });

  const active = await open(activePath, "w");
  try {
    await active.writeFile(`${JSON.stringify({
      type: "user",
      cwd: root,
      uuid: "active-user",
      timestamp: "2026-07-23T00:00:00.000Z",
      message: { content: "synthetic active prompt" },
    })}\n{"type":"assistant","cwd":${JSON.stringify(root)},"uuid":"large-history","message":{"content":[{"type":"text","text":"`);
    const chunk = Buffer.alloc(512 * 1024, 0x78);
    for (let written = 0; written < GIANT_RECORD_BYTES; written += chunk.length) {
      await active.write(chunk);
    }
    await active.writeFile(`"}]}}\n`);
  } finally {
    await active.close();
  }

  global.gc?.();
  const before = process.memoryUsage().rss;
  const startCpu = process.cpuUsage();
  const startedAt = performance.now();
  const app = await buildApp({
    home: root,
    stateDir,
    claudeRoot,
    codexRoot,
    claudeSessionsDir: join(root, "claude-processes"),
    frontendDist: join(root, "missing-dist"),
    token: "a".repeat(64),
    startWatchers: true,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const startupMs = performance.now() - startedAt;
  const startupCpu = process.cpuUsage(startCpu);
  const afterStart = process.memoryUsage().rss;
  // Let the background scan begin, then probe Fastify while it is active.
  await new Promise(resolve => setTimeout(resolve, 250));
  const coldApiStartedAt = performance.now();
  await requestSessions(app);
  const coldApiMs = performance.now() - coldApiStartedAt;
  const coldDiscoveryCpuStart = process.cpuUsage();
  const coldDiscoveryStartedAt = performance.now();
  await waitForSessions(app, SESSION_COUNT);
  const coldDiscoveryMs = performance.now() - coldDiscoveryStartedAt + 250;
  const coldDiscoveryCpu = process.cpuUsage(coldDiscoveryCpuStart);
  const afterDiscovery = process.memoryUsage().rss;
  resetJsonlIndexIoCounters();
  const coldTailStartedAt = performance.now();
  await readTail(activePath, 200);
  const coldTailMs = performance.now() - coldTailStartedAt;
  const coldTailIo = jsonlIndexIoCounters();
  const coldSettleCpuStart = process.cpuUsage();
  await new Promise(resolve => setTimeout(resolve, 5_000));
  const coldSettleCpu = process.cpuUsage(coldSettleCpuStart);
  await app.close();
  clearLineIndexMemoryCache();

  // A real user normally restarts against the persisted metadata cache. Track
  // that separately, then leave the process idle long enough for an archive
  // poll and several deliberately-slow preview hydration ticks.
  global.gc?.();
  const warmBefore = process.memoryUsage().rss;
  const warmCpuStart = process.cpuUsage();
  const warmStartedAt = performance.now();
  const warmApp = await buildApp({
    home: root,
    stateDir,
    claudeRoot,
    codexRoot,
    claudeSessionsDir: join(root, "claude-processes"),
    frontendDist: join(root, "missing-dist"),
    token: "a".repeat(64),
    startWatchers: true,
  });
  await warmApp.listen({ host: "127.0.0.1", port: 0 });
  const warmStartupMs = performance.now() - warmStartedAt;
  const warmStartupCpu = process.cpuUsage(warmCpuStart);
  const warmAfterStart = process.memoryUsage().rss;
  const warmDiscoveryCpuStart = process.cpuUsage();
  const warmDiscoveryStartedAt = performance.now();
  await waitForSessions(warmApp, SESSION_COUNT);
  const warmDiscoveryMs = performance.now() - warmDiscoveryStartedAt;
  const warmDiscoveryCpu = process.cpuUsage(warmDiscoveryCpuStart);
  resetJsonlIndexIoCounters();
  const warmTailStartedAt = performance.now();
  await readTail(activePath, 200);
  const warmTailMs = performance.now() - warmTailStartedAt;
  const warmTailIo = jsonlIndexIoCounters();
  const idleCpuStart = process.cpuUsage();
  await new Promise(resolve => setTimeout(resolve, 12_000));
  const idleCpu = process.cpuUsage(idleCpuStart);
  const afterIdle = process.memoryUsage().rss;

  const hotCpuStart = process.cpuUsage();
  const hotRssStart = process.memoryUsage().rss;
  const appendHandle = await open(activePath, "a");
  try {
    await appendHandle.writeFile(`{"type":"assistant","cwd":${JSON.stringify(root)},"uuid":"large-live","message":{"content":[{"type":"tool_use","id":"tool","name":"Read","input":{"payload":"`);
    const chunk = Buffer.alloc(512 * 1024, 0x79);
    for (let written = 0; written < GIANT_RECORD_BYTES; written += chunk.length) {
      await appendHandle.write(chunk);
      await new Promise(resolve => setImmediate(resolve));
    }
    await appendHandle.writeFile(`"}}]}}\n`);
  } finally {
    await appendHandle.close();
  }
  await appendFile(activePath, [
    JSON.stringify({
      type: "user",
      cwd: root,
      uuid: "active-user-2",
      timestamp: new Date().toISOString(),
      message: { content: "retitle from this observed prompt without historical scan" },
    }),
    JSON.stringify({
      type: "assistant",
      cwd: root,
      uuid: "active-assistant-2",
      timestamp: new Date().toISOString(),
      message: { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
    }),
    "",
  ].join("\n"));
  await new Promise(resolve => setTimeout(resolve, 3500));
  const hotCpu = process.cpuUsage(hotCpuStart);
  const afterHot = process.memoryUsage().rss;
  await warmApp.close();

  const result = {
    sessions: SESSION_COUNT,
    historicalMiB: mib(GIANT_RECORD_BYTES),
    liveAppendMiB: mib(GIANT_RECORD_BYTES),
    startupMs: Math.round(startupMs),
    startupCpuMs: Math.round((startupCpu.user + startupCpu.system) / 1000),
    startupRssDeltaMiB: mib(afterStart - before),
    startupRssMiB: mib(afterStart),
    coldApiDuringScanMs: Math.round(coldApiMs),
    coldDiscoveryMs: Math.round(coldDiscoveryMs),
    coldDiscoveryCpuMs: Math.round((coldDiscoveryCpu.user + coldDiscoveryCpu.system) / 1000),
    coldDiscoveryRssDeltaMiB: mib(afterDiscovery - afterStart),
    coldTailMs: Math.round(coldTailMs),
    coldTailFullReadMiB: mib(coldTailIo.fullBytes),
    coldSettle5sCpuMs: Math.round((coldSettleCpu.user + coldSettleCpu.system) / 1000),
    warmStartupMs: Math.round(warmStartupMs),
    warmStartupCpuMs: Math.round((warmStartupCpu.user + warmStartupCpu.system) / 1000),
    warmStartupRssDeltaMiB: mib(warmAfterStart - warmBefore),
    warmDiscoveryMs: Math.round(warmDiscoveryMs),
    warmDiscoveryCpuMs: Math.round((warmDiscoveryCpu.user + warmDiscoveryCpu.system) / 1000),
    warmTailMs: Math.round(warmTailMs),
    warmTailFullReadMiB: mib(warmTailIo.fullBytes),
    warmTailAppendReadMiB: mib(warmTailIo.appendedBytes),
    idle12sCpuMs: Math.round((idleCpu.user + idleCpu.system) / 1000),
    idle12sRssDeltaMiB: mib(afterIdle - warmAfterStart),
    hotWindowCpuMs: Math.round((hotCpu.user + hotCpu.system) / 1000),
    hotWindowRssDeltaMiB: mib(afterHot - hotRssStart),
    finalRssMiB: mib(afterHot),
  };
  console.log(JSON.stringify(result, null, 2));
  if (
    startupMs > 2_000
    || coldApiMs > 500
    || coldDiscoveryMs > 90_000
    || afterDiscovery - before > 160 * 1024 * 1024
  ) {
    throw new Error("Synthetic startup resource ceiling exceeded");
  }
  if (
    (coldSettleCpu.user + coldSettleCpu.system) / 1000 > 2_500 ||
    warmStartupMs > 5_000 ||
    warmDiscoveryMs > 5_000 ||
    (warmStartupCpu.user + warmStartupCpu.system) / 1000 > 1_500 ||
    warmTailMs > 1_000 ||
    warmTailIo.fullBytes !== 0 ||
    (idleCpu.user + idleCpu.system) / 1000 > 1_500 ||
    afterIdle - warmAfterStart > 64 * 1024 * 1024
  ) {
    throw new Error("Synthetic warm-start/idle resource ceiling exceeded");
  }
  if ((hotCpu.user + hotCpu.system) / 1000 > 2500 || afterHot - hotRssStart > 128 * 1024 * 1024) {
    throw new Error("Synthetic live-append resource ceiling exceeded");
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
