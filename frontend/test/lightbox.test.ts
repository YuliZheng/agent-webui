import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { imageDownloadName } from "../src/lib/image-download.js";

const lightboxVue = readFileSync(join(process.cwd(), "src/components/Lightbox.vue"), "utf8");
const chatImageVue = readFileSync(join(process.cwd(), "src/components/blocks/ChatImage.vue"), "utf8");
const toolResultVue = readFileSync(join(process.cwd(), "src/components/blocks/tool/ToolResult.vue"), "utf8");

describe("image lightbox", () => {
  it("uses a WeChat-style immersive viewer with one small bottom-right download action", () => {
    expect(lightboxVue).toContain("cw-image-lightbox");
    expect(lightboxVue).toContain("bg-black select-none");
    expect(lightboxVue).toContain("z-[100]");
    expect(lightboxVue).toContain("bottom-0 right-0");
    expect(lightboxVue).toContain("safe-area-inset-bottom");
    expect(lightboxVue).toContain('meta[name="theme-color"]');
    expect(lightboxVue).toContain('meta.setAttribute("content", "#000000")');
    expect(lightboxVue).not.toContain('aria-label="打开原图"');
    expect(lightboxVue).toContain('aria-label="保存原图"');
    expect(lightboxVue).toContain(':download="downloadName"');
    expect(lightboxVue).toContain("h-10 w-10");
    expect(lightboxVue).toContain("@click.stop=\"onDownloadClick\"");
    expect(lightboxVue).toContain("已开始下载");
    expect(lightboxVue).toContain('role="status"');
    expect(lightboxVue).not.toContain("top-4 right-16");
    expect(lightboxVue).not.toContain("top-4 right-4");
    expect(lightboxVue).toContain("@click.stop");
  });

  it("supports focal pinch zoom, panning, double-tap zoom, and wheel zoom", () => {
    expect(lightboxVue).toContain('class="cw-image-lightbox');
    expect(lightboxVue).toContain("touch-none");
    expect(lightboxVue).toContain('@pointerdown="onPointerDown"');
    expect(lightboxVue).toContain('@pointermove="onPointerMove"');
    expect(lightboxVue).toContain('@pointerup="onPointerEnd"');
    expect(lightboxVue).toContain('@pointercancel="onPointerEnd($event, true)"');
    expect(lightboxVue).toContain('@wheel.prevent="onWheel"');
    expect(lightboxVue).toContain("DOUBLE_TAP_IMAGE_SCALE");
    expect(lightboxVue).toContain("zoomImageAtPoint");
    expect(lightboxVue).toContain("resistImageOffset");
    expect(lightboxVue).toContain("左右滑动切换图片，双指缩放，放大后拖动，双击放大或还原，单击关闭");
    expect(lightboxVue).not.toContain('@click.stop="lightbox.close()"');
  });

  it("swipes through visible images from the same conversation without stealing zoomed pans", () => {
    expect(chatImageVue).toContain(':data-lightbox-url="src"');
    expect(toolResultVue).toContain(':data-lightbox-url="img.url"');
    expect(lightboxVue).toContain("gallerySwipeDirection");
    expect(lightboxVue).toContain("gestureStartedScale");
    expect(lightboxVue).toContain("resistGallerySwipe");
    expect(lightboxVue).toContain('switchGallery("previous")');
    expect(lightboxVue).toContain('switchGallery("next")');
    expect(lightboxVue).toContain('e.key === "ArrowLeft"');
    expect(lightboxVue).toContain('e.key === "ArrowRight"');
    expect(lightboxVue).toContain('v-if="galleryCount > 1"');
    expect(lightboxVue).toContain("{{ galleryPosition }} / {{ galleryCount }}");
  });

  it("chooses safe, useful download filenames", () => {
    expect(imageDownloadName("photo.jpg", "/api/image")).toBe("photo.jpg");
    expect(imageDownloadName("C:\\shots\\screen", "/api/image?path=C%3A%5Cshots%5Cscreen.webp")).toBe("screen.webp");
    expect(imageDownloadName("[image]", "data:image/jpeg;base64,abc")).toBe("image.jpg");
    expect(imageDownloadName("../bad:name", "/api/image")).toBe("bad_name.png");
  });
});
