import { request } from "./ws.js";

export interface LocalFileResponse {
  path: string;
  line: number | null;
  size: number;
  content: string;
}

export async function readLocalFile(path: string, line: number | null): Promise<LocalFileResponse> {
  return request<LocalFileResponse>("read-local-file", { path, line });
}

export async function revealLocalPath(path: string): Promise<{ path: string; kind: "file" | "directory" }> {
  return request<{ path: string; kind: "file" | "directory" }>("reveal-local-path", { path });
}

export function localFileContentUrl(path: string, download = false): string {
  const query = new URLSearchParams({ path });
  if (download) query.set("download", "1");
  return `/api/local-file-content?${query.toString()}`;
}
