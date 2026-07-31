import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { usePrefsStore } from "../src/stores/prefs.js";
import { useSessionCacheStore } from "../src/stores/session-cache.js";
import { useSessionSettingsStore } from "../src/stores/session-settings.js";

describe("session settings", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("applies service-tier pushes without erasing other settings", () => {
    const settings = useSessionSettingsStore();
    settings.apply({ id: "thread", model: "gpt-5.6-sol", effort: "medium", permissionMode: "never" });
    settings.apply({ id: "thread", serviceTier: "priority" });
    expect(settings.bySession.thread).toEqual({
      model: "gpt-5.6-sol",
      effort: "medium",
      serviceTier: "priority",
      permissionMode: "never",
    });

    settings.apply({ id: "thread", serviceTier: null });
    expect(settings.bySession.thread?.serviceTier).toBeNull();
    expect(settings.bySession.thread?.effort).toBe("medium");
  });

  it("derives Codex model and effort from the latest turn context", () => {
    const prefs = usePrefsStore();
    prefs.defaultCodexModel = "gpt-5.6-luna";
    prefs.defaultCodexEffort = "medium";
    const cache = useSessionCacheStore().ensure("thread");
    cache.lines.push(JSON.stringify({
      type: "turn_context",
      payload: {
        model: "gpt-5.6-sol",
        effort: "low",
        approval_policy: "never",
        sandbox_policy: { type: "danger-full-access" },
      },
    }));

    expect(useSessionSettingsStore().effectiveCodex("thread")).toEqual({
      model: "gpt-5.6-sol",
      effort: "low",
      permissionMode: "full-access",
      serviceTier: "unknown",
    });
  });

  it.each([
    ["priority", "priority"],
    ["fast", "priority"],
    ["default", "standard"],
    ["standard", "standard"],
  ])("derives applied service tier %s as %s", (serviceTier, expected) => {
    const cache = useSessionCacheStore().ensure("thread");
    cache.lines.push(JSON.stringify({
      type: "event_msg",
      payload: {
        type: "thread_settings_applied",
        thread_settings: {
          model: "gpt-5.6-sol",
          reasoning_effort: "low",
          service_tier: serviceTier,
        },
      },
    }));

    expect(useSessionSettingsStore().effectiveCodex("thread").serviceTier).toBe(expected);
  });

  it("uses the latest rollout value for each Codex setting", () => {
    const cache = useSessionCacheStore().ensure("thread");
    cache.lines.push(
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "thread_settings_applied",
          thread_settings: { model: "gpt-5.6-luna", reasoning_effort: "medium", service_tier: "default" },
        },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "thread_settings_applied",
          thread_settings: { model: "gpt-5.6-sol", reasoning_effort: "high", service_tier: "priority" },
        },
      }),
    );

    expect(useSessionSettingsStore().effectiveCodex("thread")).toMatchObject({
      model: "gpt-5.6-sol",
      effort: "high",
      serviceTier: "priority",
    });
  });

  it("keeps a confirmed Fast-off override authoritative over an older priority rollout", () => {
    const cache = useSessionCacheStore().ensure("thread");
    cache.lines.push(JSON.stringify({
      type: "event_msg",
      payload: {
        type: "thread_settings_applied",
        thread_settings: { service_tier: "priority" },
      },
    }));
    const settings = useSessionSettingsStore();

    expect(settings.effectiveCodex("thread").serviceTier).toBe("priority");

    settings.apply({ id: "thread", serviceTier: "standard" });

    expect(settings.bySession.thread?.serviceTier).toBe("standard");
    expect(settings.effectiveCodex("thread").serviceTier).toBe("standard");
  });
});
