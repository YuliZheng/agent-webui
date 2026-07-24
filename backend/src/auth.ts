import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";

export const COOKIE_NAME = "cw_token";

export async function resolveToken(path: string, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  try {
    const token = (await readFile(path, "utf8")).trim();
    if (/^[a-fA-F0-9]{64}$/.test(token)) return token;
  } catch { /* create below */ }
  const token = crypto.randomBytes(32).toString("hex");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  return token;
}

export function timingSafeToken(expected: string, candidate: unknown): boolean {
  if (typeof candidate !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(candidate);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function requestToken(request: FastifyRequest): string | undefined {
  const cookie = request.cookies?.[COOKIE_NAME];
  if (cookie) return cookie;
  const auth = request.headers.authorization;
  return auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
}

export function setTokenCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(COOKIE_NAME, token, {
    httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 * 5,
  });
}
