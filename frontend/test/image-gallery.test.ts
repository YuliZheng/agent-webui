import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useLightboxStore } from "../src/stores/lightbox.js";
import {
  conversationImageGallery,
  gallerySwipeDirection,
  resistGallerySwipe,
} from "../src/util/image-gallery.js";

describe("conversation image gallery", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = "";
  });

  it("collects only images from the source conversation in DOM chronology", () => {
    document.body.innerHTML = `
      <div class="cw-message-scroller" id="first-chat">
        <div class="cw-message-history">
          <button id="first" data-lightbox-url="/a.png" data-lightbox-alt="A"></button>
          <button id="repeat" data-lightbox-url="/a.png" data-lightbox-alt="A again"></button>
          <button data-lightbox-url="/b.png" data-lightbox-alt="B"></button>
        </div>
      </div>
      <div class="cw-message-scroller">
        <button data-lightbox-url="/other.png"></button>
      </div>`;

    const source = document.querySelector("#repeat");
    expect(conversationImageGallery(source)).toEqual({
      items: [
        { url: "/a.png", alt: "A" },
        { url: "/a.png", alt: "A again" },
        { url: "/b.png", alt: "B" },
      ],
      index: 1,
    });
  });

  it("keeps standalone images out of an unrelated conversation gallery", () => {
    const source = document.createElement("button");
    source.dataset.lightboxUrl = "/standalone.png";
    document.body.append(source);
    expect(conversationImageGallery(source)).toBeNull();
  });

  it("opens at the exact clicked duplicate and stops at gallery bounds", () => {
    document.body.innerHTML = `
      <div class="cw-message-scroller">
        <button data-lightbox-url="/same.png" data-lightbox-alt="first"></button>
        <button id="clicked" data-lightbox-url="/same.png" data-lightbox-alt="second"></button>
        <button data-lightbox-url="/last.png" data-lightbox-alt="last"></button>
      </div>`;
    const store = useLightboxStore();
    store.open("/same.png", "second", document.querySelector("#clicked"));

    expect(store.index).toBe(1);
    expect(store.alt).toBe("second");
    expect(store.previous()).toBe(true);
    expect(store.index).toBe(0);
    expect(store.previous()).toBe(false);
    expect(store.next()).toBe(true);
    expect(store.next()).toBe(true);
    expect(store.next()).toBe(false);
    expect(store.url).toBe("/last.png");

    store.close();
    expect(store.$state).toEqual({ url: null, alt: "", items: [], index: -1 });
  });
});

describe("gallery swipe decision", () => {
  it("maps a horizontal swipe to the chronological direction", () => {
    expect(gallerySwipeDirection({ dx: -60, dy: 8, durationMs: 300, scale: 1 })).toBe("next");
    expect(gallerySwipeDirection({ dx: 34, dy: 3, durationMs: 60, scale: 1 })).toBe("previous");
  });

  it("rejects short, vertical, cancelled, multi-touch, and zoomed gestures", () => {
    expect(gallerySwipeDirection({ dx: 20, dy: 0, durationMs: 40, scale: 1 })).toBeNull();
    expect(gallerySwipeDirection({ dx: 70, dy: 65, durationMs: 100, scale: 1 })).toBeNull();
    expect(gallerySwipeDirection({ dx: 70, dy: 0, durationMs: 100, scale: 1, cancelled: true })).toBeNull();
    expect(gallerySwipeDirection({ dx: 70, dy: 0, durationMs: 100, scale: 1, multiplePointers: true })).toBeNull();
    expect(gallerySwipeDirection({ dx: 70, dy: 0, durationMs: 100, scale: 1.2 })).toBeNull();
  });

  it("adds edge resistance without weakening valid gallery movement", () => {
    expect(resistGallerySwipe(100, false, true)).toBe(22);
    expect(resistGallerySwipe(-100, true, false)).toBe(-22);
    expect(resistGallerySwipe(-100, true, true)).toBe(-100);
  });
});
