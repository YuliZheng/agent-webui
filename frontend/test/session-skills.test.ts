import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

vi.mock("../src/api/skills.js", () => ({
  getSessionSkills: vi.fn(async (id: string) =>
    id === "s1" ? [{ name: "help" }, { name: "brainstorming", description: "x" }] : [],
  ),
}));

import { useSessionSkillsStore } from "../src/stores/session-skills.js";
import { getSessionSkills } from "../src/api/skills.js";

describe("session-skills store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("fetches once and caches per session", async () => {
    const store = useSessionSkillsStore();
    await store.ensureLoaded("s1");
    await store.ensureLoaded("s1");
    expect(getSessionSkills).toHaveBeenCalledTimes(1);
    expect(store.list("s1").map((s) => s.name)).toEqual(["help", "brainstorming"]);
  });

  it("returns [] for a session that was never loaded", () => {
    const store = useSessionSkillsStore();
    expect(store.list("nope")).toEqual([]);
  });
});
