import { describe, expect, it } from "vitest";
import { anchoredRenderStart, sourceIndexNear } from "../src/util/render-window.js";

const sourceIndex = (value: number | null) => value;

describe("anchored transcript render window", () => {
  it("keeps already-rendered history visible as live replies append", () => {
    const initial = Array.from({ length: 30 }, (_, index) => index + 100);
    const floor = sourceIndexNear(initial, 0, sourceIndex);
    const withReplies = [...initial, ...Array.from({ length: 250 }, (_, index) => index + 130)];

    expect(floor).toBe(100);
    expect(anchoredRenderStart(withReplies, floor, 30, sourceIndex)).toBe(0);
  });

  it("ignores newly backfilled rows above the stable floor until revealed", () => {
    const withPrefix = Array.from({ length: 280 }, (_, index) => index);

    expect(anchoredRenderStart(withPrefix, 100, 30, sourceIndex)).toBe(100);
    expect(sourceIndexNear(withPrefix, 0, sourceIndex)).toBe(0);
    expect(anchoredRenderStart(withPrefix, 0, 230, sourceIndex)).toBe(0);
  });

  it("falls back to a bounded tail when an authoritative rewrite removes the floor", () => {
    const rewritten = Array.from({ length: 80 }, (_, index) => index);

    expect(anchoredRenderStart(rewritten, 500, 30, sourceIndex)).toBe(50);
  });
});
