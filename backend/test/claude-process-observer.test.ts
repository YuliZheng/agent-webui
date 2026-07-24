import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeProcessObserver, type ForeignClaudeObservation } from "../src/services/claude-process-observer.js";

const observers: ClaudeProcessObserver[] = [];
afterEach(async () => { await Promise.all(observers.splice(0).map(observer => observer.stop())); });

async function fixture(options: ConstructorParameters<typeof ClaudeProcessObserver>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), "agent-webui-claude-process-"));
  const directory = join(root, "sessions");
  await mkdir(directory);
  const observer = new ClaudeProcessObserver(directory, { revalidateMs: 60_000, ...options });
  observers.push(observer);
  return { directory, observer };
}

describe("Claude process registration observer", () => {
  it("reports a live peer on registration add and clears it after deletion", async () => {
    const { directory, observer } = await fixture();
    const events: ForeignClaudeObservation[] = [];
    observer.on("changed", event => events.push(event));
    await observer.start();

    const path = join(directory, "peer.json");
    await writeFile(path, JSON.stringify({ sessionId: "peer_session", pid: process.pid }));
    await observer.refreshNow();
    expect(events.at(-1)).toMatchObject({ sessionId: "peer_session", peer: true, running: true, pid: process.pid });

    await unlink(path);
    await observer.refreshNow();
    expect(events.at(-1)).toMatchObject({ sessionId: "peer_session", peer: false, running: false });
  });

  it("does not publish unchanged registrations on periodic revalidation", async () => {
    const { directory, observer } = await fixture();
    const changed: ForeignClaudeObservation[] = [];
    const observed: ForeignClaudeObservation[] = [];
    observer.on("changed", event => changed.push(event));
    observer.on("observed", event => observed.push(event));
    await writeFile(join(directory, "stable.json"), JSON.stringify({ sessionId: "stable_session", pid: process.pid }));
    await observer.start();
    expect(changed).toHaveLength(1);

    await observer.refreshNow();
    await observer.refreshNow();
    expect(changed).toHaveLength(1);
    expect(observed).toEqual([]);
  });

  it("ages out registrations whose process identity cannot be verified", async () => {
    const { directory, observer } = await fixture({ maxUnverifiedAgeMs: 1_000 });
    const events: ForeignClaudeObservation[] = [];
    observer.on("changed", event => events.push(event));
    const path = join(directory, "stale.json");
    await writeFile(path, JSON.stringify({ session_id: "stale_session", pid: process.pid }));
    const old = new Date(Date.now() - 60_000);
    await utimes(path, old, old);
    await observer.start();
    expect(events).toEqual([]);
  });

  it.runIf(process.platform !== "win32")("rejects a reused PID when the recorded process start tick differs", async () => {
    const { directory, observer } = await fixture();
    const events: ForeignClaudeObservation[] = [];
    observer.on("changed", event => events.push(event));
    await writeFile(join(directory, "reused.json"), JSON.stringify({ sessionId: "reused_session", pid: process.pid, startTime: "definitely-wrong" }));
    await observer.start();
    expect(events).toEqual([]);
  });
});
