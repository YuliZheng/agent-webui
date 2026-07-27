async function avatarRequest(method: "PUT" | "DELETE", data?: string): Promise<void> {
  const response = await fetch("/api/me/avatar", {
    method,
    credentials: "include",
    cache: "no-store",
    ...(data
      ? {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ data }),
        }
      : {}),
  });
  if (response.ok) return;
  let message = `Avatar update failed (${response.status})`;
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === "string" && body.error) message = body.error;
  } catch { /* keep the status-based message */ }
  throw new Error(message);
}

export async function putUserAvatar(data: string): Promise<void> {
  await avatarRequest("PUT", data);
}

export async function deleteUserAvatar(): Promise<void> {
  await avatarRequest("DELETE");
}
