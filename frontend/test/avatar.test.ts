import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteUserAvatar, putUserAvatar } from "../src/api/avatar.js";

describe("user avatar API", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("uploads the processed PNG through the authenticated avatar endpoint", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    await putUserAvatar("data:image/png;base64,cG5n");
    expect(fetchMock).toHaveBeenCalledWith("/api/me/avatar", {
      method: "PUT",
      credentials: "include",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: "data:image/png;base64,cG5n" }),
    });
  });

  it("resets the avatar and surfaces backend errors", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({
        ok: false,
        status: 413,
        json: async () => ({ error: "Avatar image exceeds 2 MiB" }),
      }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    await deleteUserAvatar();
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/me/avatar", {
      method: "DELETE",
      credentials: "include",
      cache: "no-store",
    });
    await expect(putUserAvatar("data:image/png;base64,eA==")).rejects.toThrow("Avatar image exceeds 2 MiB");
  });
});
