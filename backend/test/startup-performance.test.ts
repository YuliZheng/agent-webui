import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

const TOKEN = "a".repeat(64);

describe("production startup discovery", () => {
  it("listens before a cold archive scan and does not auto-title historical rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-background-startup-"));
    const claudeRoot = join(root, "claude");
    const codexRoot = join(root, "codex");
    const stateDir = join(root, "state");
    const processDir = join(root, "claude-processes");
    await Promise.all([
      mkdir(claudeRoot),
      mkdir(codexRoot),
      mkdir(stateDir),
      mkdir(processDir),
    ]);
    const count = 8;
    await Promise.all(Array.from({ length: count }, async (_, index) => {
      const id = `background_${index}`;
      await writeFile(join(claudeRoot, `${id}.jsonl`), `${JSON.stringify({
        type: "user",
        cwd: root,
        timestamp: "2026-07-23T00:00:00.000Z",
        message: { content: `historical ${id}` },
      })}\n`);
    }));

    const app = await buildApp({
      home: root,
      stateDir,
      claudeRoot,
      codexRoot,
      claudeSessionsDir: processDir,
      frontendDist: join(root, "missing-dist"),
      token: TOKEN,
      startWatchers: true,
      sessionColdScanPaceMs: 25,
    });
    try {
      const startedAt = performance.now();
      await app.listen({ host: "127.0.0.1", port: 0 });
      expect(performance.now() - startedAt).toBeLessThan(500);

      const requestSessions = async () => {
        const response = await app.inject({
          method: "GET",
          url: "/api/sessions",
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(response.statusCode).toBe(200);
        return response.json<unknown[]>();
      };
      expect((await requestSessions()).length).toBeLessThan(count);

      const deadline = Date.now() + 5_000;
      let sessions: unknown[] = [];
      while (Date.now() < deadline) {
        sessions = await requestSessions();
        if (sessions.length === count) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(sessions).toHaveLength(count);

      let titlesFileExists = true;
      try { await access(join(stateDir, "titles.json")); }
      catch { titlesFileExists = false; }
      expect(titlesFileExists).toBe(false);
    } finally {
      await app.close();
    }
  });
});
