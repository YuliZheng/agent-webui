import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
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
});
