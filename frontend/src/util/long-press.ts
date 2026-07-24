export const LONG_PRESS_MS = 450;
export const LONG_PRESS_MOVE_PX = 10;

export interface LongPressHandlers {
  onPointerdown(event: PointerEvent): void;
  onPointermove(event: PointerEvent): void;
  onPointerup(event: PointerEvent): void;
  onPointercancel(event: PointerEvent): void;
}

export function createLongPressHandlers(callback: (event: PointerEvent) => void, delay = LONG_PRESS_MS): LongPressHandlers {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let startX = 0; let startY = 0; let origin: PointerEvent | undefined;
  const cancel = () => { clearTimeout(timer); timer = undefined; origin = undefined; };
  return {
    onPointerdown(event) {
      if (event.pointerType !== "touch") return;
      cancel(); startX = event.clientX; startY = event.clientY; origin = event;
      timer = setTimeout(() => { if (origin) callback(origin); timer = undefined; origin = undefined; }, delay);
    },
    onPointermove(event) {
      if (!origin) return;
      if (Math.hypot(event.clientX - startX, event.clientY - startY) > LONG_PRESS_MOVE_PX) cancel();
    },
    onPointerup() { cancel(); },
    onPointercancel() { cancel(); }
  };
}

export function clampMenuPosition(x: number, y: number, width = 168, height = 92): { left: number; top: number } {
  return { left: Math.max(8, Math.min(x, window.innerWidth - width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - height - 8)) };
}
