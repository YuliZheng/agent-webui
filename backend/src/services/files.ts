import crypto from "node:crypto";
import { spawn, type SpawnOptions } from "node:child_process";
import { mkdir, readFile, realpath, stat, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isWithin } from "../util/paths.js";
import { RpcError } from "../types.js";

export type LocalPathKind = "file" | "directory";

export interface ResolvedLocalPath {
  path: string;
  kind: LocalPathKind;
  size: number;
  mtimeMs: number;
}

export interface LocalPathInfo extends ResolvedLocalPath {
  name: string;
}

export interface LocalDirectoryListing extends LocalPathInfo {
  kind: "directory";
  parent: string | null;
  entries: LocalPathInfo[];
  truncated: boolean;
}

async function canonicalRoots(roots: string[]): Promise<string[]> {
  return Promise.all(roots.map(async root => { try { return await realpath(root); } catch { return resolve(root); } }));
}

async function resolveAgainstRoots(path: string, roots: string[]): Promise<ResolvedLocalPath> {
  if (path.includes("\0")) throw new RpcError(400, "Invalid path");
  let actual: string;
  try { actual = await realpath(resolve(path)); } catch { throw new RpcError(404, "File not found"); }
  if (!roots.some(root => isWithin(root, actual))) throw new RpcError(403, "File is outside allowed roots");
  const info = await stat(actual);
  const kind = info.isFile() ? "file" : info.isDirectory() ? "directory" : null;
  if (!kind) throw new RpcError(400, "Expected a file or directory");
  return { path: actual, kind, size: info.size, mtimeMs: info.mtimeMs };
}

function pathInfo(resolved: ResolvedLocalPath): LocalPathInfo {
  return { ...resolved, name: basename(resolved.path) || resolved.path };
}

export async function inspectLocalPath(path: string, roots: string[]): Promise<LocalPathInfo> {
  return pathInfo(await resolveLocalPath(path, roots));
}

export async function listLocalDirectory(path: string, roots: string[]): Promise<LocalDirectoryListing> {
  const allowed = await canonicalRoots(roots);
  const dir = await resolveAgainstRoots(path, allowed);
  if (dir.kind !== "directory") throw new RpcError(400, "Expected a directory");
  const entries = (await readdir(dir.path, { withFileTypes: true }))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const mapped: LocalPathInfo[] = [];
  for (let offset = 0; offset < entries.length && mapped.length <= 500; offset += 64) {
    const batch = await Promise.all(entries.slice(offset, offset + 64).map(async entry => {
      try {
        return { ...pathInfo(await resolveAgainstRoots(join(dir.path, entry.name), allowed)), name: entry.name };
      } catch {
        return null; // skip entries that disappear or resolve outside the allowed roots
      }
    }));
    mapped.push(...batch.filter((entry): entry is LocalPathInfo => entry !== null));
  }
  mapped.sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name));
  const parentCandidate = dirname(dir.path);
  const parent = allowed.some(root => isWithin(root, parentCandidate)) ? parentCandidate : null;
  return { ...pathInfo(dir), kind: "directory", parent, entries: mapped.slice(0, 500), truncated: mapped.length > 500 };
}

export async function resolveLocalPath(path: string, roots: string[]): Promise<ResolvedLocalPath> {
  return resolveAgainstRoots(path, await canonicalRoots(roots));
}

export async function resolveLocalFile(path: string, roots: string[]): Promise<{ path: string; size: number }> {
  const resolved = await resolveLocalPath(path, roots);
  if (resolved.kind !== "file") throw new RpcError(400, "Expected a file");
  return { path: resolved.path, size: resolved.size };
}

export interface LocalPathOpenCommand {
  command: string;
  args: string[];
  options: SpawnOptions;
}

export function localPathOpenCommand(
  path: string,
  kind: LocalPathKind,
  platform: NodeJS.Platform = process.platform,
): LocalPathOpenCommand {
  const common: SpawnOptions = { detached: true, stdio: "ignore" };
  if (platform === "win32") {
    return {
      command: "explorer.exe",
      args: kind === "file" ? [`/select,${path}`] : [path],
      options: { ...common, windowsHide: false },
    };
  }
  if (platform === "darwin") {
    return {
      command: "open",
      args: kind === "file" ? ["-R", path] : [path],
      options: common,
    };
  }
  return {
    command: "xdg-open",
    args: [kind === "file" ? dirname(path) : path],
    options: common,
  };
}

export async function openLocalPath(
  path: string,
  kind: LocalPathKind,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const launch = localPathOpenCommand(path, kind, platform);
  await new Promise<void>((resolveLaunch, rejectLaunch) => {
    const child = spawn(launch.command, launch.args, launch.options);
    child.once("error", rejectLaunch);
    child.once("spawn", () => {
      child.unref();
      resolveLaunch();
    });
  });
}

export async function readLocalSource(path: string, roots: string[], line?: number): Promise<Record<string, unknown>> {
  const resolved = await resolveLocalFile(path, roots); const actual = resolved.path;
  const info = { size: resolved.size };
  if (info.size > 4 * 1024 * 1024) throw new RpcError(413, "Source file is too large");
  const data = await readFile(actual); if (data.includes(0)) throw new RpcError(415, "Binary file cannot be viewed as source");
  return { path: actual, name: actual.split(/[\\/]/).pop(), content: data.toString("utf8"), line: Number.isSafeInteger(line) ? line : undefined, size: info.size };
}

export class PreviewStore {
  constructor(readonly root: string, private maxBytes = 2 * 1024 * 1024) {}
  async create(html: string): Promise<{ uuid: string; url: string }> {
    if (Buffer.byteLength(html) > this.maxBytes) throw new RpcError(413, "Preview is too large");
    const uuid = crypto.randomUUID(); const dir = join(this.root, uuid);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(dir, { recursive: false, mode: 0o700 });
    await writeFile(join(dir, "index.html"), html, { encoding: "utf8", mode: 0o600 });
    return { uuid, url: `/preview/${uuid}/index.html` };
  }
  async read(uuid: string): Promise<Buffer> {
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(uuid)) throw new RpcError(404, "Preview not found");
    const candidate = join(this.root, uuid, "index.html");
    let root: string; let actual: string;
    try { [root, actual] = await Promise.all([realpath(this.root), realpath(candidate)]); } catch { throw new RpcError(404, "Preview not found"); }
    if (!isWithin(root, actual) || dirname(actual) !== join(root, uuid)) throw new RpcError(403, "Unsafe preview path");
    return readFile(actual);
  }
}
