import crypto from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isWithin } from "../util/paths.js";
import { RpcError } from "../types.js";

export async function resolveLocalFile(path: string, roots: string[]): Promise<{ path: string; size: number }> {
  let actual: string;
  try { actual = await realpath(resolve(path)); } catch { throw new RpcError(404, "File not found"); }
  const allowed = await Promise.all(roots.map(async root => { try { return await realpath(root); } catch { return resolve(root); } }));
  if (!allowed.some(root => isWithin(root, actual))) throw new RpcError(403, "File is outside allowed roots");
  const info = await stat(actual); if (!info.isFile()) throw new RpcError(400, "Expected a file");
  return { path: actual, size: info.size };
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
