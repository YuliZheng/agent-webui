export interface LightboxItem {
  url: string;
  alt: string;
}

export interface ConversationGallery {
  items: LightboxItem[];
  index: number;
}

export type GallerySwipeDirection = "previous" | "next";

/**
 * Build a gallery from the visible image controls in the conversation that
 * owns `source`. Keeping the source element lets repeated image URLs retain
 * their exact chronological position.
 */
export function conversationImageGallery(source?: Element | null): ConversationGallery | null {
  if (typeof document === "undefined" || !source) return null;
  const scroller = source.closest(".cw-message-scroller");
  const current = source.closest("[data-lightbox-url]");
  if (!scroller || !current) return null;

  const entries = Array.from(scroller.querySelectorAll<HTMLElement>("[data-lightbox-url]")).flatMap((element) => {
    const url = element.getAttribute("data-lightbox-url")?.trim();
    if (!url) return [];
    return [{ element, item: { url, alt: element.getAttribute("data-lightbox-alt") ?? "" } }];
  });
  const items = entries.map((entry) => entry.item);
  const index = entries.findIndex((entry) => entry.element === current);
  if (!items.length || index < 0) return null;
  return { items, index };
}

export function gallerySwipeDirection(input: {
  dx: number;
  dy: number;
  durationMs: number;
  scale: number;
  cancelled?: boolean;
  multiplePointers?: boolean;
}): GallerySwipeDirection | null {
  if (input.cancelled || input.multiplePointers || input.scale > 1.01) return null;
  const horizontal = Math.abs(input.dx);
  const vertical = Math.abs(input.dy);
  if (horizontal < 28 || horizontal <= vertical * 1.2) return null;

  const crossedDistance = horizontal >= 56;
  const velocity = horizontal / Math.max(1, input.durationMs);
  if (!crossedDistance && velocity < 0.45) return null;
  return input.dx < 0 ? "next" : "previous";
}

/** Apply restrained resistance when the user pulls beyond either gallery end. */
export function resistGallerySwipe(
  deltaX: number,
  canPrevious: boolean,
  canNext: boolean,
): number {
  const pullingPastStart = deltaX > 0 && !canPrevious;
  const pullingPastEnd = deltaX < 0 && !canNext;
  return pullingPastStart || pullingPastEnd ? deltaX * 0.22 : deltaX;
}
