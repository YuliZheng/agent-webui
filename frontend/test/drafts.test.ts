import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useDraftsStore } from "../src/stores/drafts.js";

describe("useDraftsStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    if (typeof localStorage !== "undefined") localStorage.clear();
  });

  it("returns empty for unknown session", () => {
    const d = useDraftsStore();
    expect(d.text("unknown")).toBe("");
  });

  it("set + text round trips per session", () => {
    const d = useDraftsStore();
    d.set("a", "alpha");
    d.set("b", "beta");
    expect(d.text("a")).toBe("alpha");
    expect(d.text("b")).toBe("beta");
  });

  it("clear removes the entry", () => {
    const d = useDraftsStore();
    d.set("a", "hello");
    d.clear("a");
    expect(d.text("a")).toBe("");
  });

  it("restores a failed dispatched send without overwriting newer text", () => {
    const d = useDraftsStore();
    d.restoreBefore("a", "failed message");
    expect(d.text("a")).toBe("failed message");

    d.set("a", "new draft");
    d.restoreBefore("a", "failed message");
    expect(d.text("a")).toBe("failed message\n\nnew draft");

    d.restoreBefore("a", "");
    expect(d.text("a")).toBe("failed message\n\nnew draft");
  });

  it("moves composer text and in-flight state when a draft is promoted", () => {
    const d = useDraftsStore();
    d.set("draft:1", "next message");
    d.beginInflight("draft:1");
    d.moveSession("draft:1", "real:1");

    expect(d.text("draft:1")).toBe("");
    expect(d.text("real:1")).toBe("next message");
    expect(d.inflight("draft:1")).toBe(0);
    expect(d.inflight("real:1")).toBe(1);

    d.endInflight("real:1");
    expect(d.isInflight("real:1")).toBe(false);
  });

  it("append adds with leading space when needed", () => {
    const d = useDraftsStore();
    d.set("a", "hello");
    d.append("a", "world");
    expect(d.text("a")).toBe("hello world");
  });

  it("append into empty draft has no leading space", () => {
    const d = useDraftsStore();
    d.append("a", "hi");
    expect(d.text("a")).toBe("hi");
  });

  it("append no-ops on empty insertion", () => {
    const d = useDraftsStore();
    d.set("a", "x");
    d.append("a", "");
    expect(d.text("a")).toBe("x");
  });

  it("set('','') no-ops on empty id", () => {
    const d = useDraftsStore();
    d.set("", "anything");
    expect(d.text("")).toBe("");
  });

  it("inflight starts at 0 and is per-session", () => {
    const d = useDraftsStore();
    expect(d.inflight("a")).toBe(0);
    expect(d.isInflight("a")).toBe(false);
    d.beginInflight("a");
    expect(d.inflight("a")).toBe(1);
    expect(d.isInflight("a")).toBe(true);
    expect(d.inflight("b")).toBe(0);
    expect(d.isInflight("b")).toBe(false);
  });

  it("inflight counter handles multiple concurrent requests", () => {
    const d = useDraftsStore();
    d.beginInflight("a");
    d.beginInflight("a");
    d.beginInflight("a");
    expect(d.inflight("a")).toBe(3);
    d.endInflight("a");
    expect(d.inflight("a")).toBe(2);
    d.endInflight("a");
    d.endInflight("a");
    expect(d.inflight("a")).toBe(0);
    expect(d.isInflight("a")).toBe(false);
  });

  it("endInflight does not go below 0", () => {
    const d = useDraftsStore();
    d.endInflight("a");
    d.endInflight("a");
    expect(d.inflight("a")).toBe(0);
    d.beginInflight("a");
    expect(d.inflight("a")).toBe(1);
  });

  it("inflight ignores empty id", () => {
    const d = useDraftsStore();
    d.beginInflight("");
    d.endInflight("");
    expect(d.inflight("")).toBe(0);
  });
});
