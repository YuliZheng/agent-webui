import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchSessions } from "../src/actions/sessions.js";
import { SessionIndex } from "../src/services/session-index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("session search access", () => {
  it("excludes sub-agent workers but keeps ordinary forks searchable", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-search-access-"));
    roots.push(root);
    const claudeRoot = join(root, "claude");
    const codexRoot = join(root, "codex");
    await mkdir(claudeRoot);
    await mkdir(codexRoot);

    await writeFile(join(codexRoot, "rollout-worker.jsonl"), [
      JSON.stringify({
        timestamp: "2026-08-08T00:00:00Z",
        type: "session_meta",
        payload: {
          id: "worker-id",
          cwd: root,
          thread_source: "subagent",
          source: {
            subagent: {
              thread_spawn: { parent_thread_id: "parent-id", depth: 1 },
            },
          },
        },
      }),
      JSON.stringify({
        timestamp: "2026-08-08T00:00:01Z",
        type: "event_msg",
        payload: { type: "user_message", message: "shared search needle" },
      }),
      "",
    ].join("\n"));

    await writeFile(join(codexRoot, "rollout-fork.jsonl"), [
      JSON.stringify({
        timestamp: "2026-08-08T00:00:02Z",
        type: "session_meta",
        payload: {
          id: "ordinary-fork-id",
          cwd: root,
          parent_thread_id: "parent-id",
        },
      }),
      JSON.stringify({
        timestamp: "2026-08-08T00:00:03Z",
        type: "event_msg",
        payload: { type: "user_message", message: "shared search needle" },
      }),
      "",
    ].join("\n"));

    const index = new SessionIndex({ claudeRoot, codexRoot });
    await index.scan();

    expect(index.get("worker-id")).toMatchObject({ subagent: true, parentSessionId: "parent-id" });
    expect(index.get("ordinary-fork-id")).toMatchObject({ subagent: false, parentSessionId: "parent-id" });

    const result = await searchSessions(index, "shared search needle", {
      rgMinArchiveBytes: Number.POSITIVE_INFINITY,
    });
    expect(result.matches.map(match => match.id)).toEqual(["ordinary-fork-id"]);
  });
});
