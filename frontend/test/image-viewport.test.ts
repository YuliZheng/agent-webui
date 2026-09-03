import { describe, expect, it } from "vitest";
import {
  clampImageTransform,
  imagePanBounds,
  resistImageOffset,
  zoomImageAtPoint,
} from "../src/util/image-viewport.js";

describe("image viewport gestures", () => {
  const bounds = {
    imageWidth: 300,
    imageHeight: 600,
    viewportWidth: 400,
    viewportHeight: 800,
  };

  it("centers a fitted image and clamps scale to the supported range", () => {
    expect(clampImageTransform({ scale: 0.7, x: 80, y: -40 }, bounds)).toEqual({
      scale: 1,
      x: 0,
      y: 0,
    });
    expect(clampImageTransform({ scale: 8, x: 0, y: 0 }, bounds).scale).toBe(5);
  });

  it("keeps a zoomed image inside its pan bounds", () => {
    expect(imagePanBounds(2, bounds)).toEqual({ x: 100, y: 200 });
    expect(clampImageTransform({ scale: 2, x: 160, y: -260 }, bounds)).toEqual({
      scale: 2,
      x: 100,
      y: -200,
    });
  });

  it("keeps the image-space focal point under the fingers while zooming", () => {
    const start = { scale: 1.5, x: 12, y: -18 };
    const point = { x: 80, y: 140 };
    const next = zoomImageAtPoint(start, 3, point);
    expect((point.x - start.x) / start.scale).toBeCloseTo((point.x - next.x) / next.scale);
    expect((point.y - start.y) / start.scale).toBeCloseTo((point.y - next.y) / next.scale);
  });

  it("adds restrained resistance beyond the pan edge", () => {
    expect(resistImageOffset(80, 100)).toBe(80);
    expect(resistImageOffset(150, 100)).toBe(112);
    expect(resistImageOffset(-150, 100)).toBe(-112);
  });
});
