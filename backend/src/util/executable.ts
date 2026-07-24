import { delimiter, isAbsolute, join, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { RpcError } from "../types.js";

async function executable(path: string): Promise<string | undefined> {
  try { return (await stat(path)).isFile() ? path : undefined; } catch { return undefined; }
}

/** Resolve the native Codex executable without invoking a shell/npm cmd shim. */
export async function resolveCodexExecutable(configured = "codex"): Promise<string> {
  if (process.platform !== "win32") return configured;
  if (isAbsolute(configured) || /[\\/]/.test(configured)) {
    const path = resolve(configured);
    if (/\.(cmd|bat|ps1)$/i.test(path)) throw new RpcError(503, "Configure the native codex.exe, not a shell shim");
    return await executable(path) ?? path;
  }
  if (configured !== "codex") {
    if (/\.(cmd|bat|ps1)$/i.test(configured)) throw new RpcError(503, "Configure the native codex.exe, not a shell shim");
    return configured;
  }
  if (/\.exe$/i.test(configured)) return configured;
  const platform = process.arch === "arm64" ? "codex-win32-arm64" : "codex-win32-x64";
  const triple = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const bases = new Set<string>();
  if (process.env.APPDATA) bases.add(join(process.env.APPDATA, "npm"));
  for (const path of (process.env.PATH ?? "").split(delimiter)) if (path) bases.add(path.replace(/^"|"$/g, ""));
  for (const base of bases) {
    const candidates = [
      join(base, "node_modules", "@openai", "codex", "node_modules", "@openai", platform, "vendor", triple, "bin", "codex.exe"),
      join(base, "node_modules", "@openai", platform, "vendor", triple, "bin", "codex.exe"),
    ];
    for (const candidate of candidates) { const found = await executable(candidate); if (found) return found; }
  }
  throw new RpcError(503, "Native codex.exe was not found; configure --codex-binary or install @openai/codex");
}
