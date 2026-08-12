import { request } from "./ws.js";

export interface LocalFileResponse {
  path: string;
  line: number | null;
  size: number;
  content: string;
}

export interface LocalPathInfo {
  path: string;
  name: string;
  kind: "file" | "directory";
  size: number;
  mtimeMs: number;
}

export interface LocalDirectoryResponse extends LocalPathInfo {
  kind: "directory";
  parent: string | null;
  entries: LocalPathInfo[];
  truncated: boolean;
}

export async function readLocalFile(path: string, line: number | null): Promise<LocalFileResponse> {
  return request<LocalFileResponse>("read-local-file", { path, line });
}

export async function inspectLocalPath(path: string): Promise<LocalPathInfo> {
  return request<LocalPathInfo>("inspect-local-path", { path });
}

export async function listLocalDirectory(path: string): Promise<LocalDirectoryResponse> {
  return request<LocalDirectoryResponse>("list-local-directory", { path });
}

export async function revealLocalPath(path: string): Promise<{ path: string; kind: "file" | "directory" }> {
  return request<{ path: string; kind: "file" | "directory" }>("reveal-local-path", { path });
}

export function localFileContentUrl(path: string, download = false): string {
  const query = new URLSearchParams({ path });
  if (download) query.set("download", "1");
  return `/api/local-file-content?${query.toString()}`;
}
