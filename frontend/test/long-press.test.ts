import { describe, expect, it, vi } from "vitest";
import { createLongPressHandlers, LONG_PRESS_MS } from "@/util/long-press";

const pointer = (x: number, y: number, pointerType = "touch") => ({ clientX: x, clientY: y, pointerType } as PointerEvent);
describe("touch long press", () => {
  it("fires after 450ms without movement", () => { vi.useFakeTimers(); const callback = vi.fn(); const handlers = createLongPressHandlers(callback); handlers.onPointerdown(pointer(10, 10)); vi.advanceTimersByTime(LONG_PRESS_MS); expect(callback).toHaveBeenCalledOnce(); vi.useRealTimers(); });
  it("cancels after movement exceeds ten pixels", () => { vi.useFakeTimers(); const callback = vi.fn(); const handlers = createLongPressHandlers(callback); handlers.onPointerdown(pointer(10, 10)); handlers.onPointermove(pointer(21, 10)); vi.advanceTimersByTime(LONG_PRESS_MS); expect(callback).not.toHaveBeenCalled(); vi.useRealTimers(); });
  it("never enters the long-press path for mouse", () => { vi.useFakeTimers(); const callback = vi.fn(); const handlers = createLongPressHandlers(callback); handlers.onPointerdown(pointer(0, 0, "mouse")); vi.advanceTimersByTime(LONG_PRESS_MS); expect(callback).not.toHaveBeenCalled(); vi.useRealTimers(); });
  it("never enters the touch-only path for a pen", () => { vi.useFakeTimers(); const callback = vi.fn(); const handlers = createLongPressHandlers(callback); handlers.onPointerdown(pointer(0, 0, "pen")); vi.advanceTimersByTime(LONG_PRESS_MS); expect(callback).not.toHaveBeenCalled(); vi.useRealTimers(); });
});
