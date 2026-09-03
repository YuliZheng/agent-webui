import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { orderSessionForkRows } from "../src/util/session-fork-tree.js";

const sidebar = readFileSync(join(process.cwd(), "src/components/Sidebar.vue"), "utf8");

const parentById: Record<string, string | null> = {
  root: null,
  fork: "root",
  nested: "fork",
  sibling: "root",
};
function rows(ids: string[], hierarchyIds: string[] = ids) {
  return orderSessionForkRows(ids, {
    parentOf: (id) => parentById[id] ?? null,
    hierarchyIds,
  });
}

describe("session fork tree", () => {
  it("orders a fork family together and preserves nested depth", () => {
    expect(rows(["nested", "sibling", "fork", "root"])).toEqual([
      { id: "root", depth: 0 },
      { id: "fork", depth: 1 },
      { id: "nested", depth: 2 },
      { id: "sibling", depth: 1 },
    ]);
  });

  it("keeps a fork indented when its parent is outside the rendered section", () => {
    expect(rows(["nested"], ["root", "fork", "nested"])).toEqual([
      { id: "nested", depth: 2 },
    ]);
  });

  it("surfaces malformed cycles once at top level", () => {
    const cyclicParents: Record<string, string> = { a: "b", b: "a" };
    expect(orderSessionForkRows(["a", "b"], {
      parentOf: (id) => cyclicParents[id],
    })).toEqual([
      { id: "a", depth: 0 },
      { id: "b", depth: 0 },
    ]);
  });

  it("passes fork depth through every non-search sidebar section", () => {
    expect(sidebar).toContain("orderWithForks(activeSessionIds)");
    expect(sidebar).toContain("orderWithForks(pinnedSessionIds)");
    expect(sidebar).toContain("rowsInGroup(name as unknown as string)");
    expect(sidebar.match(/:depth="row\.depth"/g)).toHaveLength(5);
  });
});
