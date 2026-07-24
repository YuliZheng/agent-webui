import { EventEmitter } from "node:events";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { asRecord, asString } from "../types.js";

interface Registration {
  path: string;
  sessionId: string;
  pid: number;
  startTime?: string;
  mtimeMs: number;
}

export interface ForeignClaudeObservation {
  sessionId: string;
  peer: boolean;
  running: boolean;
  pid?: number;
  observedAt: string;
}

export interface ClaudeProcessObserverOptions {
  maxUnverifiedAgeMs?: number;
  revalidateMs?: number;
}

const SESSION_ID = /^[0-9A-Za-z_-]+$/;
const REGISTRATION_REFRESH_CONCURRENCY = 8;

async function forEachBounded<T>(
  values: readonly T[],
  concurrency: number,
  visit: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from(
    { length: Math.min(values.length, Math.max(1, concurrency)) },
    async () => {
      while (cursor < values.length) {
        const value = values[cursor++]!;
        await visit(value);
      }
    },
  ));
}

async function procStartTime(pid: number): Promise<string | undefined> {
  if (process.platform === "win32") return undefined;
  try {
    const line = await readFile(`/proc/${pid}/stat`, "utf8");
    return line.slice(line.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Read-only observer for Claude's process registration files. It never sends a
 * signal other than signal 0 and therefore cannot interrupt or kill a peer.
 */
export class ClaudeProcessObserver extends EventEmitter {
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private registrations = new Map<string, Registration>();
  private registrationsBySession = new Map<string, Map<string, Registration>>();
  private rejectedMtime = new Map<string, number>();
  private published = new Map<string, ForeignClaudeObservation>();
  private pending = new Map<string, NodeJS.Timeout>();
  private refreshWork?: Promise<void>;
  private refreshAgain = false;
  private readonly directory: string;
  private readonly maxUnverifiedAgeMs: number;
  private readonly revalidateMs: number;

  constructor(directory: string, options: ClaudeProcessObserverOptions = {}) {
    super();
    this.directory = resolve(directory);
    this.maxUnverifiedAgeMs = options.maxUnverifiedAgeMs ?? 24 * 60 * 60 * 1_000;
    // Chokidar handles registration changes immediately. This timer is only a
    // conservative PID/file-identity safety net, so a one-minute cadence is
    // sufficient and avoids repeatedly walking the directory while idle.
    this.revalidateMs = options.revalidateMs ?? 60_000;
  }

  async start(): Promise<void> {
    if (this.watcher) return;
    this.watcher = watch(this.directory, { ignoreInitial: true, followSymlinks: false, depth: 0 });
    this.watcher.on("add", path => this.schedule(path));
    this.watcher.on("change", path => this.schedule(path));
    this.watcher.on("unlink", path => this.remove(path));
    await this.refreshNow();
    this.timer = setInterval(() => void this.refreshNow(), this.revalidateMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const timeout of this.pending.values()) clearTimeout(timeout);
    this.pending.clear();
    const watcher = this.watcher;
    this.watcher = undefined;
    if (watcher) await watcher.close();
  }

  async refreshNow(): Promise<void> {
    if (this.refreshWork) {
      this.refreshAgain = true;
      return this.refreshWork;
    }
    const work = (async () => {
      do {
        this.refreshAgain = false;
        await this.refreshPass();
      } while (this.refreshAgain);
    })();
    this.refreshWork = work;
    try {
      await work;
    } finally {
      if (this.refreshWork === work) this.refreshWork = undefined;
    }
  }

  private async refreshPass(): Promise<void> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch {
      for (const path of [...this.registrations.keys()]) this.remove(path);
      return;
    }
    const present = new Set(names.filter(name => name.endsWith(".json")).map(name => join(this.directory, name)));
    for (const path of [...this.registrations.keys()]) if (!present.has(path)) this.remove(path);
    await forEachBounded([...present], REGISTRATION_REFRESH_CONCURRENCY, path => this.refreshFile(path));
  }

  private schedule(path: string): void {
    if (!path.endsWith(".json")) return;
    const prior = this.pending.get(path);
    if (prior) clearTimeout(prior);
    const timeout = setTimeout(() => {
      this.pending.delete(path);
      void this.refreshFile(path);
    }, 75);
    this.pending.set(path, timeout);
  }

  private async refreshFile(path: string): Promise<void> {
    const prior = this.registrations.get(path);
    const priorSession = prior?.sessionId;
    let next: Registration | undefined;
    let observedMtime: number | undefined;
    try {
      const info = await lstat(path);
      observedMtime = info.mtimeMs;
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe registration file");
      // A rejected registration cannot become trustworthy without a write.
      // Remember its mtime so the 15-second revalidation loop does not reread,
      // reparse, and PID-check the same permanently-invalid file forever.
      if (!prior && this.rejectedMtime.get(path) === info.mtimeMs) return;
      if (prior && prior.mtimeMs === info.mtimeMs) {
        // The registration contents did not change. Revalidate only the
        // process identity; avoid rereading and reparsing every file every
        // fifteen seconds.
        if (!pidAlive(prior.pid)) throw new Error("Inactive registration");
        if (prior.startTime && process.platform !== "win32") {
          const actualStart = await procStartTime(prior.pid);
          if (!actualStart || actualStart !== prior.startTime) throw new Error("Stale PID registration");
        } else if (Date.now() - info.mtimeMs > this.maxUnverifiedAgeMs) {
          throw new Error("Unverified registration is too old");
        }
        next = prior;
      } else {
        const value = asRecord(JSON.parse(await readFile(path, "utf8")));
        const sessionId = asString(value?.sessionId) ?? asString(value?.session_id);
        const pid = typeof value?.pid === "number" ? value.pid : Number(value?.pid);
        const startTimeRaw = value?.startTime ?? value?.start_time ?? value?.processStartTime;
        const startTime = typeof startTimeRaw === "string" || typeof startTimeRaw === "number" ? String(startTimeRaw) : undefined;
        if (!sessionId || !SESSION_ID.test(sessionId) || !Number.isSafeInteger(pid) || pid <= 0 || !pidAlive(pid)) throw new Error("Inactive registration");
        const actualStart = await procStartTime(pid);
        if (startTime && process.platform !== "win32") {
          if (!actualStart || actualStart !== startTime) throw new Error("Stale PID registration");
        } else if (Date.now() - info.mtimeMs > this.maxUnverifiedAgeMs) {
          throw new Error("Unverified registration is too old");
        }
        next = { path, sessionId, pid, ...(startTime ? { startTime } : {}), mtimeMs: info.mtimeMs };
      }
    } catch {
      next = undefined;
    }
    if (next) {
      this.rejectedMtime.delete(path);
      this.setRegistration(path, next);
    } else {
      if (observedMtime !== undefined) this.rejectedMtime.set(path, observedMtime);
      this.deleteRegistration(path);
    }
    if (priorSession && priorSession !== next?.sessionId) this.publish(priorSession);
    if (next) this.publish(next.sessionId);
    else if (priorSession) this.publish(priorSession);
  }

  private remove(path: string): void {
    const timeout = this.pending.get(path);
    if (timeout) clearTimeout(timeout);
    this.pending.delete(path);
    const prior = this.registrations.get(path);
    this.deleteRegistration(path);
    this.rejectedMtime.delete(path);
    if (prior) this.publish(prior.sessionId);
  }

  private setRegistration(path: string, registration: Registration): void {
    const prior = this.registrations.get(path);
    if (prior && prior.sessionId !== registration.sessionId) {
      const group = this.registrationsBySession.get(prior.sessionId);
      group?.delete(path);
      if (!group?.size) this.registrationsBySession.delete(prior.sessionId);
    }
    this.registrations.set(path, registration);
    let group = this.registrationsBySession.get(registration.sessionId);
    if (!group) {
      group = new Map();
      this.registrationsBySession.set(registration.sessionId, group);
    }
    group.set(path, registration);
  }

  private deleteRegistration(path: string): Registration | undefined {
    const prior = this.registrations.get(path);
    if (!prior) return undefined;
    this.registrations.delete(path);
    const group = this.registrationsBySession.get(prior.sessionId);
    group?.delete(path);
    if (!group?.size) this.registrationsBySession.delete(prior.sessionId);
    return prior;
  }

  private publish(sessionId: string): void {
    const registration = this.registrationsBySession.get(sessionId)?.values().next().value as Registration | undefined;
    const next: ForeignClaudeObservation = registration
      ? { sessionId, peer: true, running: true, pid: registration.pid, observedAt: new Date().toISOString() }
      : { sessionId, peer: false, running: false, observedAt: new Date().toISOString() };
    const prior = this.published.get(sessionId);
    if (prior?.peer === next.peer && prior.running === next.running && prior.pid === next.pid) {
      return;
    }
    if (next.peer) this.published.set(sessionId, next);
    else this.published.delete(sessionId);
    this.emit("changed", next);
  }
}
