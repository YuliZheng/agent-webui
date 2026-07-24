import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { mainSocket } from "@/api/ws";
import { useComposerStore } from "@/stores/composer";
import { drafts } from "@/persist/drafts";

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  vi.restoreAllMocks();
});

describe("composer send durability and concurrency", () => {
  it("keeps the draft after a failed request", async () => {
    const request = vi.spyOn(mainSocket, "request").mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({});
    const composer = useComposerStore(); composer.setText("session-a", "keep this");
    await expect(composer.send("session-a", "claude", false, 4)).rejects.toThrow("offline");
    expect(composer.textBySession["session-a"]).toBe("keep this");
    expect(drafts.get("session-a")).toBe("keep this");
    const originalClientUuid = (request.mock.calls[0]?.[1] as { clientUuid?: string }).clientUuid;
    await composer.send("session-a", "claude", false, 5);
    expect((request.mock.calls[1]?.[1] as { clientUuid?: string }).clientUuid).toBe(originalClientUuid);
    expect(composer.chips["session-a"]).toHaveLength(1);
  });

  it("allows different sessions to send concurrently", async () => {
    const releases: Array<() => void> = [];
    vi.spyOn(mainSocket, "request").mockImplementation(() => new Promise(resolve => releases.push(() => resolve({}))));
    const composer = useComposerStore();
    composer.setText("session-a", "one"); composer.setText("session-b", "two");
    const first = composer.send("session-a", "claude", false, 1);
    const second = composer.send("session-b", "codex", false, 2);
    await Promise.resolve();
    expect(composer.isSending("session-a")).toBe(true);
    expect(composer.isSending("session-b")).toBe(true);
    expect(mainSocket.request).toHaveBeenCalledTimes(2);
    for (const release of releases) release();
    await Promise.all([first, second]);
  });
});
