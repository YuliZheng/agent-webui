import { describe, expect, it } from "vitest";
import {
  captureViewportAnchor,
  resolveBottomLock,
  restoreViewportAnchor,
} from "../src/util/scroll-anchor.js";

function rect(top: number, bottom: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    bottom,
    left: 0,
    right: 320,
    width: 320,
    height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect;
}

function fixture() {
  const scroller = document.createElement("div");
  const root = document.createElement("div");
  scroller.append(root);
  let scrollHeight = 1_000;
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, get: () => scrollHeight },
  });
  scroller.scrollTop = 100;
  scroller.getBoundingClientRect = () => rect(100, 500);

  function row(key: string, getTop: () => number, height = 80) {
    const element = document.createElement("div");
    element.dataset.scrollKey = key;
    element.getBoundingClientRect = () => rect(getTop(), getTop() + height);
    root.append(element);
    return element;
  }

  return {
    root,
    row,
    scroller,
    setScrollHeight(value: number) { scrollHeight = value; },
  };
}

describe("message viewport anchoring", () => {
  it("does not treat late programmatic tail growth as a user scroll", () => {
    expect(resolveBottomLock(true, {
      atBottom: false,
      pinActive: false,
      userScrollIntent: false,
    })).toBe(true);

    expect(resolveBottomLock(true, {
      atBottom: false,
      pinActive: false,
      userScrollIntent: true,
    })).toBe(false);

    expect(resolveBottomLock(false, {
      atBottom: true,
      pinActive: false,
      userScrollIntent: true,
    })).toBe(true);
  });

  it("captures only visible keyed rows", () => {
    const f = fixture();
    f.row("above", () => 10, 40);
    f.row("visible-a", () => 90, 60);
    f.row("visible-b", () => 220, 80);
    f.row("below", () => 520, 40);

    const snapshot = captureViewportAnchor(f.scroller, f.root);

    expect(snapshot.points).toEqual([
      { key: "visible-a", offsetTop: -10 },
      { key: "visible-b", offsetTop: 120 },
    ]);
    expect(snapshot.scrollTopFromEnd).toBe(900);
  });

  it("uses the next surviving row when a prepended tool run is regrouped", () => {
    const f = fixture();
    let firstTop = 90;
    let secondTop = 170;
    const first = f.row("tool-run-old-key", () => firstTop);
    f.row("stable-message", () => secondTop);
    const snapshot = captureViewportAnchor(f.scroller, f.root);

    first.remove();
    firstTop += 200;
    secondTop += 200;
    f.setScrollHeight(1_200);

    expect(restoreViewportAnchor(f.scroller, f.root, snapshot)).toBe("row");
    expect(f.scroller.scrollTop).toBe(300);
  });

  it("corrects a later image decode shift against the same message", () => {
    const f = fixture();
    let top = 140;
    f.row("message-with-image-below", () => top);
    const snapshot = captureViewportAnchor(f.scroller, f.root);

    top = 265;
    f.setScrollHeight(1_125);

    expect(restoreViewportAnchor(f.scroller, f.root, snapshot)).toBe("row");
    expect(f.scroller.scrollTop).toBe(225);
  });

  it("falls back to preserving distance from the end when every row changed", () => {
    const f = fixture();
    const snapshot = captureViewportAnchor(f.scroller, f.root);
    f.setScrollHeight(1_300);

    expect(restoreViewportAnchor(f.scroller, f.root, snapshot)).toBe("distance");
    expect(f.scroller.scrollTop).toBe(400);
  });
});
