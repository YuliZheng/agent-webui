import { afterEach, describe, expect, it } from "vitest";
import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { buildApp, decodeAttachmentPayload, decodeAvatarPayload, interactionAddedPush, REQUEST_LOGGING_DISABLED, runIdempotentRequest, webSocketOriginAllowed } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "agent-webui-auth-"));
  await mkdir(join(home, ".claude", "projects"), { recursive: true });
  await mkdir(join(home, ".codex", "sessions"), { recursive: true });
  const app = await buildApp({ home, token: "a".repeat(64), startWatchers: false }); apps.push(app); return app;
}

describe("token authentication", () => {
  it("removes obsolete content-search cache artifacts after the current index opens", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-webui-legacy-search-"));
    const stateDir = join(home, ".agent-webui");
    await Promise.all([
      mkdir(join(home, ".claude", "projects"), { recursive: true }),
      mkdir(join(home, ".codex", "sessions"), { recursive: true }),
      mkdir(stateDir, { recursive: true }),
    ]);
    const obsolete = ["content-search.sqlite", "content-search.sqlite-wal", "content-search.sqlite-shm"];
    await Promise.all(obsolete.map(name => writeFile(join(stateDir, name), "obsolete")));
    const app = await buildApp({ home, token: "a".repeat(64), startWatchers: false });
    apps.push(app);
    await access(join(stateDir, "content-search-v5.sqlite"));
    for (const name of obsolete) {
      await expect(access(join(stateDir, name))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("coalesces new-session style requests and caches only successful results", async () => {
    const completed = new Map<string, { sessionId: string }>();
    const inflight = new Map<string, Promise<{ sessionId: string }>>();
    let calls = 0;
    const create = async () => {
      calls++;
      await Promise.resolve();
      return { sessionId: "created-once" };
    };
    const [first, concurrent] = await Promise.all([
      runIdempotentRequest(completed, inflight, "claude:key", create),
      runIdempotentRequest(completed, inflight, "claude:key", create),
    ]);
    const retry = await runIdempotentRequest(completed, inflight, "claude:key", create);
    expect([first, concurrent, retry]).toEqual([
      { sessionId: "created-once" },
      { sessionId: "created-once" },
      { sessionId: "created-once" },
    ]);
    expect(calls).toBe(1);

    let failures = 0;
    const fail = () => {
      failures++;
      return Promise.reject(new Error("spawn failed"));
    };
    await expect(runIdempotentRequest(completed, inflight, "claude:failed", fail)).rejects.toThrow("spawn failed");
    await expect(runIdempotentRequest(completed, inflight, "claude:failed", fail)).rejects.toThrow("spawn failed");
    expect(failures).toBe(2);
  });

  it("accepts only same-host browser WebSocket origins", () => {
    expect(webSocketOriginAllowed(undefined, "127.0.0.1:3457")).toBe(true);
    expect(webSocketOriginAllowed("http://127.0.0.1:3457", "127.0.0.1:3457")).toBe(true);
    expect(webSocketOriginAllowed("https://agent.example", "agent.example")).toBe(true);
    expect(webSocketOriginAllowed("http://127.0.0.1:9999", "127.0.0.1:3457")).toBe(false);
    expect(webSocketOriginAllowed("null", "127.0.0.1:3457")).toBe(false);
  });
  it("publishes both the flat reference fields and the richer interaction snapshot", () => {
    const interaction = { sessionId: "s", requestId: "r", agent: "claude" as const, kind: "permission" as const, createdAt: new Date().toISOString() };
    expect(interactionAddedPush(interaction)).toEqual({
      type: "interaction-added",
      kind: "interaction-added",
      sessionId: "s",
      requestId: "r",
      subtype: "can_use_tool",
      toolName: undefined,
      receivedAt: interaction.createdAt,
      interaction,
    });
  });
  it("accepts bounded matching data URLs and bare base64 reference payloads", () => {
    const payload = decodeAttachmentPayload({ name: "x.png", type: "image/png", data: "data:image/png;base64,aGVsbG8=" });
    expect(payload.data).toBe("aGVsbG8="); expect(payload.bytes.toString()).toBe("hello");
    const bare = decodeAttachmentPayload({ name: "pasted.png", mime: "image/png", data: "aGVsbG8=" });
    expect(bare).toMatchObject({ name: "pasted.png", type: "image/png", data: "aGVsbG8=" });
    expect(bare.bytes.toString()).toBe("hello");
    expect(() => decodeAttachmentPayload("C:\\secret.png")).toThrowError(/supported/);
    expect(() => decodeAttachmentPayload({ type: "image/jpeg", data: "data:image/png;base64,aA==" })).toThrowError(/matching/);
  });
  it("validates, stores, serves, and resets a custom user avatar", async () => {
    const app = await fixture();
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";
    expect(decodeAvatarPayload({ data: `data:image/png;base64,${png}` }).subarray(1, 4).toString()).toBe("PNG");
    expect(() => decodeAvatarPayload({ data: "data:image/png;base64,aGVsbG8=" })).toThrowError(/valid PNG/);

    const bind = await app.inject({ url: `/api/auth/bind?token=${"a".repeat(64)}` });
    const cookie = String(bind.headers["set-cookie"]).split(";")[0]!;
    const saved = await app.inject({
      method: "PUT",
      url: "/api/me/avatar",
      headers: { cookie, "content-type": "application/json" },
      payload: { data: `data:image/png;base64,${png}` },
    });
    expect(saved.statusCode).toBe(200);
    const custom = await app.inject({ url: "/api/me/avatar", headers: { cookie } });
    expect(custom.statusCode).toBe(200);
    expect(custom.headers["content-type"]).toContain("image/png");
    expect(custom.rawPayload.subarray(1, 4).toString()).toBe("PNG");

    expect((await app.inject({ method: "DELETE", url: "/api/me/avatar", headers: { cookie } })).statusCode).toBe(200);
    const fallback = await app.inject({ url: "/api/me/avatar", headers: { cookie } });
    expect(fallback.headers["content-type"]).toContain("image/svg+xml");
  });
  it("serves structured Claude and Codex input images by physical transcript line", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-webui-input-images-"));
    const claudeRoot = join(home, ".claude", "projects");
    const codexRoot = join(home, ".codex", "sessions");
    await mkdir(claudeRoot, { recursive: true });
    await mkdir(codexRoot, { recursive: true });
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";
    await writeFile(join(claudeRoot, "claude-image.jsonl"), `${JSON.stringify({
      type: "user",
      uuid: "claude-user",
      cwd: home,
      message: {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
          { type: "text", text: "caption" },
        ],
      },
    })}\n`);
    await writeFile(join(codexRoot, "rollout-codex-image.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { id: "codex-image", cwd: home } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_image", image_url: `data:image/png;base64,${png}` },
            { type: "input_text", text: "caption" },
          ],
        },
      }),
      "",
    ].join("\n"));
    const app = await buildApp({ home, token: "a".repeat(64), startWatchers: false });
    apps.push(app);
    const bind = await app.inject({ url: `/api/auth/bind?token=${"a".repeat(64)}` });
    const cookie = String(bind.headers["set-cookie"]).split(";")[0]!;

    const claude = await app.inject({
      url: "/api/sessions/claude-image/input-image/0/0?thumb=1",
      headers: { cookie },
    });
    expect(claude.statusCode).toBe(200);
    expect(claude.headers["content-type"]).toContain("image/png");
    expect(claude.rawPayload.subarray(1, 4).toString()).toBe("PNG");

    const codex = await app.inject({
      url: "/api/sessions/codex-image/input-image/1/0?thumb=1",
      headers: { cookie },
    });
    expect(codex.statusCode).toBe(200);
    expect(codex.headers["content-type"]).toContain("image/png");
    expect(codex.rawPayload.subarray(1, 4).toString()).toBe("PNG");
    expect((await app.inject({
      url: "/api/sessions/codex-image/input-image/1/1",
      headers: { cookie },
    })).statusCode).toBe(404);
  });
  it("returns an authenticated full-rollout Codex usage summary", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-webui-context-usage-"));
    const codexRoot = join(home, ".codex", "sessions");
    await mkdir(join(home, ".claude", "projects"), { recursive: true });
    await mkdir(codexRoot, { recursive: true });
    const records = [
      JSON.stringify({ type: "session_meta", payload: { id: "codex-usage", cwd: home } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "inspect everything" }],
        },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 1_000, output_tokens: 0, total_tokens: 1_000 },
            model_context_window: 258_400,
          },
        },
      }),
      "",
    ].join("\n");
    await writeFile(join(codexRoot, "rollout-codex-usage.jsonl"), records);
    const app = await buildApp({ home, token: "a".repeat(64), startWatchers: false });
    apps.push(app);

    expect((await app.inject({
      url: "/api/sessions/codex-usage/context-usage",
    })).statusCode).toBe(401);
    const bind = await app.inject({ url: `/api/auth/bind?token=${"a".repeat(64)}` });
    const cookie = String(bind.headers["set-cookie"]).split(";")[0]!;
    const result = await app.inject({
      url: "/api/sessions/codex-usage/context-usage?autoCompactLimit=200000",
      headers: { cookie },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      completeHistoryScan: true,
      recordsScanned: 3,
      compactionCount: 0,
      tokens: 1_000,
      reportedTokens: 1_000,
      limit: 200_000,
    });
    expect((await app.inject({
      url: "/api/sessions/codex-usage/context-usage?autoCompactLimit=nope",
      headers: { cookie },
    })).statusCode).toBe(400);
  });
  it("binds an HttpOnly cookie and protects API/static fallback", async () => {
    const app = await fixture();
    expect(REQUEST_LOGGING_DISABLED).toBe(true);
    expect((await app.inject({ url: "/api/me" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api//auth/bind?token=" + "a".repeat(64) })).statusCode).toBe(401);
    const bind = await app.inject({ url: "/api/auth/bind?token=" + "a".repeat(64) });
    expect(bind.statusCode).toBe(200);
    expect(bind.headers["set-cookie"]).toContain("cw_token=");
    expect(bind.headers["set-cookie"]).toContain("HttpOnly");
    const cookie = String(bind.headers["set-cookie"]).split(";")[0]!;
    expect((await app.inject({ url: "/api/me", headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/assets/missing-deadbeef.js", headers: { cookie } })).statusCode).toBe(404);
    const spa = await app.inject({ url: "/", headers: { cookie } });
    expect(spa.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(spa.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("serves authenticated PWA shell files instead of the SPA fallback", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-webui-pwa-auth-"));
    const frontendDist = join(home, "frontend-dist");
    await Promise.all([
      mkdir(join(home, ".claude", "projects"), { recursive: true }),
      mkdir(join(home, ".codex", "sessions"), { recursive: true }),
      mkdir(frontendDist, { recursive: true }),
      mkdir(join(frontendDist, "assets"), { recursive: true }),
    ]);
    const shellHtml = `<!doctype html><title>Agent WebUI</title><main>${"shell".repeat(512)}</main>`;
    await Promise.all([
      writeFile(join(frontendDist, "index.html"), shellHtml),
      writeFile(join(frontendDist, "manifest.webmanifest"), JSON.stringify({ name: "Agent WebUI", display: "standalone" })),
      writeFile(join(frontendDist, "sw.js"), "self.addEventListener('fetch', () => {});"),
      writeFile(join(frontendDist, "clawd.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>"),
      writeFile(join(frontendDist, "assets", "icon-192.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47])),
      writeFile(join(frontendDist, "favicon-1780988963583-transparent.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    ]);
    const app = await buildApp({
      home,
      frontendDist,
      token: "a".repeat(64),
      startWatchers: false,
    });
    apps.push(app);

    expect((await app.inject({ url: "/manifest.webmanifest" })).statusCode).toBe(401);
    const bind = await app.inject({ url: `/api/auth/bind?token=${"a".repeat(64)}` });
    const cookie = String(bind.headers["set-cookie"]).split(";")[0]!;
    const manifest = await app.inject({ url: "/manifest.webmanifest", headers: { cookie } });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.headers["content-type"]).toContain("application/manifest+json");
    expect(manifest.json()).toMatchObject({ name: "Agent WebUI", display: "standalone" });

    const worker = await app.inject({ url: "/sw.js", headers: { cookie } });
    expect(worker.statusCode).toBe(200);
    expect(worker.headers["content-type"]).toContain("application/javascript");
    expect(worker.headers["service-worker-allowed"]).toBe("/");
    expect(worker.body).toContain("addEventListener('fetch'");

    const icon = await app.inject({ url: "/clawd.svg", headers: { cookie } });
    expect(icon.statusCode).toBe(200);
    expect(icon.headers["content-type"]).toContain("image/svg+xml");
    const rasterIcon = await app.inject({ url: "/assets/icon-192.png", headers: { cookie } });
    expect(rasterIcon.statusCode).toBe(200);
    expect(rasterIcon.headers["content-type"]).toContain("image/png");

    const compressedShell = await app.inject({
      url: "/",
      headers: { cookie, "accept-encoding": "gzip" },
    });
    expect(compressedShell.statusCode).toBe(200);
    expect(compressedShell.headers["content-encoding"]).toBe("gzip");
    expect(compressedShell.rawPayload.length).toBeGreaterThan(0);
    expect(gunzipSync(compressedShell.rawPayload).toString()).toContain("<title>Agent WebUI</title>");
  });

  it("serves a token form for unauthenticated browser routes without changing API errors", async () => {
    const app = await fixture();
    const root = await app.inject({ url: "/", headers: { accept: "text/html" } });
    expect(root.statusCode).toBe(401);
    expect(root.headers["content-type"]).toContain("text/html");
    expect(root.body).toContain('<form method="get" action="/">');
    expect(root.body).toContain('name="token"');
    expect(root.body).not.toContain("a".repeat(64));

    const deepLink = await app.inject({ url: "/sessions/example", headers: { accept: "text/html" } });
    expect(deepLink.statusCode).toBe(401);
    expect(deepLink.body).toContain("Agent WebUI");
    expect(deepLink.body).toContain('type="password"');

    const api = await app.inject({ url: "/api/me", headers: { accept: "text/html" } });
    expect(api.statusCode).toBe(401);
    expect(api.headers["content-type"]).toContain("application/json");
    expect(api.json()).toEqual({ error: "Authentication required" });
  });

  it("rejects an unauthenticated WebSocket with policy code 1008", async () => {
    const app = await fixture(); await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address(); if (!address || typeof address === "string") throw new Error("no address");
    const code = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws/main`);
      ws.on("close", resolve); ws.on("error", error => { if ((error as Error).message.includes("Unexpected server response")) reject(error); });
    });
    expect(code).toBe(1008);
  });
});
