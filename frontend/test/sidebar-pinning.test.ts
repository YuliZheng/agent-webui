import { describe, expect, it } from "vitest";
import { withoutPinnedSessions } from "../src/util/sidebar-pinning.js";

describe("sidebar pinned-session placement", () => {
  it("removes pinned rows from every lower section while preserving order", () => {
    const ids = ["running-pinned", "ordinary", "finished-pinned", "newest"];
    const pinned = new Set(["running-pinned", "finished-pinned"]);

    expect(withoutPinnedSessions(ids, pinned)).toEqual(["ordinary", "newest"]);
    expect(ids).toEqual(["running-pinned", "ordinary", "finished-pinned", "newest"]);
  });

  it("restores a session naturally after it is no longer pinned", () => {
    const ids = ["first", "formerly-pinned", "last"];

    expect(withoutPinnedSessions(ids, new Set())).toEqual(ids);
  });
});
