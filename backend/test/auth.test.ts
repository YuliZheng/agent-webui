import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, decodeAttachmentPayload, interactionAddedPush, REQUEST_LOGGING_DISABLED } from "../src/app.js";
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
  it("nests interaction snapshots under the shared event contract", () => {
    const interaction = { sessionId: "s", requestId: "r", agent: "claude" as const, kind: "permission" as const, createdAt: new Date().toISOString() };
    expect(interactionAddedPush(interaction)).toEqual({ type: "interaction-added", kind: "interaction-added", interaction });
  });
  it("accepts only bounded matching attachment data URLs", () => {
    const payload = decodeAttachmentPayload({ name: "x.png", type: "image/png", data: "data:image/png;base64,aGVsbG8=" });
    expect(payload.data).toBe("aGVsbG8="); expect(payload.bytes.toString()).toBe("hello");
    expect(() => decodeAttachmentPayload({ type: "image/png", data: "aGVsbG8=" })).toThrowError(/data URL/);
    expect(() => decodeAttachmentPayload("C:\\secret.png")).toThrowError(/supported/);
    expect(() => decodeAttachmentPayload({ type: "image/jpeg", data: "data:image/png;base64,aA==" })).toThrowError(/matching/);
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
