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
