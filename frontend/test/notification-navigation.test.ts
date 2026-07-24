import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const socket = vi.hoisted(() => ({
  addEventListener: vi.fn(),
  connect: vi.fn(),
  request: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  updateGlobalNotifSinceSeq: vi.fn(),
  updateSessionFrom: vi.fn(),
}));

vi.mock("@/api/ws", () => ({ mainSocket: socket }));

import { useLiveStore } from "@/stores/live";
import { useUiStore } from "@/stores/ui";

describe("completion notification navigation", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => vi.useRealTimers());

  it("retains the source session on the WebUI toast", () => {
    useLiveStore().onPush({
      type: "notification",
      kind: "notification",
      id: "source-session",
      title: "Agent finished",
      body: "Done",
      timestamp: "2026-07-24T12:00:00.000Z",
      seq: 1,
    });

    expect(useUiStore().toasts).toEqual([
      expect.objectContaining({
        message: "Agent finished: Done",
        sessionId: "source-session",
      }),
    ]);
  });
});
