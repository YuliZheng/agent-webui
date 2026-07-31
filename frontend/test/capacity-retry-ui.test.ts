import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPinia, setActivePinia } from "pinia";
import { useLiveStore } from "../src/stores/live.js";
import { useSessionsStore } from "../src/stores/sessions.js";

const mainPaneVue = readFileSync(
  join(process.cwd(), "src/components/MainPane.vue"),
  "utf8",
);
const sessionRowVue = readFileSync(
  join(process.cwd(), "src/components/SessionRow.vue"),
  "utf8",
);

describe("capacity retry UI", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("tracks a pushed retry until the turn reaches a terminal status", () => {
    const sessions = useSessionsStore();
    const live = useLiveStore();
    sessions.setStatus("session", "running", true);

    live.onGlobal({
      type: "capacity-retry",
      kind: "capacity-retry",
      sessionId: "session",
      turnId: "turn-1",
      attempt: 3,
      maxAttempts: 6,
      delayMs: 4_000,
      retryAt: "2026-07-30T10:00:04.000Z",
    });

    expect(sessions.capacityRetryBySession.session).toEqual({
      turnId: "turn-1",
      attempt: 3,
      maxAttempts: 6,
      delayMs: 4_000,
      retryAt: "2026-07-30T10:00:04.000Z",
    });

    sessions.setStatus("session", "failed", true);
    expect(sessions.capacityRetryBySession.session).toBeUndefined();
  });

  it("drops transient retry state across websocket resynchronization", () => {
    const sessions = useSessionsStore();
    sessions.setCapacityRetry("session", {
      turnId: "turn-1",
      attempt: 1,
      maxAttempts: 6,
      delayMs: 1_000,
      retryAt: "2026-07-30T10:00:01.000Z",
    });

    sessions.clearAllStatus();
    expect(sessions.capacityRetryBySession).toEqual({});
  });

  it("accepts retry pushes from the already-running pre-countdown backend", () => {
    const sessions = useSessionsStore();
    const live = useLiveStore();
    sessions.setStatus("session", "running", true);

    live.onGlobal({
      type: "capacity-retry",
      kind: "capacity-retry",
      sessionId: "session",
      turnId: "turn-legacy",
      attempt: 1,
      maxAttempts: 6,
      delayMs: 500,
    });

    expect(sessions.capacityRetryBySession.session).toMatchObject({
      turnId: "turn-legacy",
      attempt: 1,
      maxAttempts: 6,
      delayMs: 500,
    });
    expect(Date.parse(sessions.capacityRetryBySession.session!.retryAt)).toBeGreaterThan(0);
  });

  it("renders the retry counter in the current header and sidebar row", () => {
    expect(mainPaneVue).toContain("Model busy · retry {{ capacityRetry.attempt }}/{{ capacityRetry.maxAttempts }}");
    expect(mainPaneVue).toContain("模型繁忙，正在重试");
    expect(mainPaneVue).toContain("capacityRetryWaitSeconds");
    expect(sessionRowVue).toContain("Model busy · retry ${capacityRetry.value.attempt}/${capacityRetry.value.maxAttempts}");
    expect(sessionRowVue).toContain("next in ${capacityRetryWaitSeconds.value}s");
    expect(sessionRowVue).toContain("⟳{{ capacityRetry.attempt }}/{{ capacityRetry.maxAttempts }}");
  });
});
