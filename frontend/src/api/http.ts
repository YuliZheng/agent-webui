export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers }
  });
  if (!response.ok) throw new HttpError(response.status, await response.text() || response.statusText);
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

export function exportUrl(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/export`;
}

export function localFileUrl(path: string, line?: number): string {
  const params = new URLSearchParams({ path });
  if (line) params.set("line", String(line));
  return `/local-file?${params}`;
}
