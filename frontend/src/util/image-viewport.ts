export interface ImageTransform {
  scale: number;
  x: number;
  y: number;
}

export interface ImageViewportBounds {
  imageWidth: number;
  imageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}

export const MIN_IMAGE_SCALE = 1;
export const MAX_IMAGE_SCALE = 5;
export const DOUBLE_TAP_IMAGE_SCALE = 2.5;

export function clampImageScale(scale: number): number {
  return Math.min(MAX_IMAGE_SCALE, Math.max(MIN_IMAGE_SCALE, scale));
}

export function imagePanBounds(
  scale: number,
  bounds: ImageViewportBounds,
): { x: number; y: number } {
  return {
    x: Math.max(0, (bounds.imageWidth * scale - bounds.viewportWidth) / 2),
    y: Math.max(0, (bounds.imageHeight * scale - bounds.viewportHeight) / 2),
  };
}

export function clampImageTransform(
  transform: ImageTransform,
  bounds: ImageViewportBounds,
): ImageTransform {
  const scale = clampImageScale(transform.scale);
  if (scale === MIN_IMAGE_SCALE) return { scale, x: 0, y: 0 };
  const pan = imagePanBounds(scale, bounds);
  return {
    scale,
    x: Math.min(pan.x, Math.max(-pan.x, transform.x)),
    y: Math.min(pan.y, Math.max(-pan.y, transform.y)),
  };
}

/** Keep the same image-space point under the gesture focal point. */
export function zoomImageAtPoint(
  transform: ImageTransform,
  nextScale: number,
  point: { x: number; y: number },
): ImageTransform {
  const ratio = nextScale / transform.scale;
  return {
    scale: nextScale,
    x: point.x - (point.x - transform.x) * ratio,
    y: point.y - (point.y - transform.y) * ratio,
  };
}

export function resistImageOffset(value: number, limit: number): number {
  const magnitude = Math.abs(value);
  if (magnitude <= limit) return value;
  return Math.sign(value) * (limit + (magnitude - limit) * 0.24);
}
