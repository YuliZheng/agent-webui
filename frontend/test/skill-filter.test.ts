import { describe, it, expect } from "vitest";
import { filterSkills } from "../src/util/skill-filter.js";
import type { SkillEntry } from "@claude-webui/shared/api";

const items: SkillEntry[] = [
  { name: "help" },
  { name: "superpowers:brainstorming", description: "explore" },
  { name: "clickhouse-nav", description: "query CH" },
];

describe("filterSkills", () => {
  it("returns all items for an empty query", () => {
    expect(filterSkills(items, "")).toHaveLength(3);
  });

  it("matches by case-insensitive substring on name", () => {
    expect(filterSkills(items, "BRAIN").map((s) => s.name)).toEqual([
      "superpowers:brainstorming",
    ]);
  });

  it("matches the namespace tail", () => {
    expect(filterSkills(items, "click").map((s) => s.name)).toEqual(["clickhouse-nav"]);
  });

  it("returns empty when nothing matches", () => {
    expect(filterSkills(items, "zzz")).toEqual([]);
  });
});
