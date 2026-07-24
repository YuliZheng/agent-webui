import { homedir } from "node:os";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { RpcError } from "../types.js";

export function expandHome(input: string, home = homedir()): string {
  if (input === "~") return home;
  if (input.startsWith(`~${sep}`) || input.startsWith("~/") || input.startsWith("~\\")) return resolve(home, input.slice(2));
  return input;
}

export function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export async function safeRealpath(input: string, roots: string[], options: { directory?: boolean } = {}): Promise<string> {
  if (input.includes("\0")) throw new RpcError(400, "Invalid path");
  let actual: string;
  try { actual = await realpath(resolve(expandHome(input))); }
  catch { throw new RpcError(404, "Path does not exist"); }
  const rootPaths = await Promise.all(roots.map(async root => {
    try { return await realpath(root); } catch { return resolve(root); }
  }));
  if (!rootPaths.some(root => isWithin(root, actual))) throw new RpcError(403, "Path is outside allowed roots");
  const stat = await lstat(actual);
  if (stat.isSymbolicLink()) throw new RpcError(403, "Symlinks are not allowed");
  if (options.directory && !stat.isDirectory()) throw new RpcError(400, "Expected a directory");
  return actual;
}

export function safeFilename(name: unknown): asserts name is string {
  if (typeof name !== "string" || name === "" || name === "." || name === ".." || /[\\/\0]/.test(name)) {
    throw new RpcError(400, "Invalid filename");
  }
}
