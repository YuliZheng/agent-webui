import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { imageDownloadName } from "../src/lib/image-download.js";

const lightboxVue = readFileSync(join(process.cwd(), "src/components/Lightbox.vue"), "utf8");

describe("image lightbox", () => {
  it("uses a WeChat-style immersive viewer with one small bottom-right download action", () => {
    expect(lightboxVue).toMatch(/<img[\s\S]*?@click\.stop="lightbox\.close\(\)"/);
    expect(lightboxVue).toContain("cw-image-lightbox");
    expect(lightboxVue).toContain("bg-black cursor-zoom-out");
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

  it("chooses safe, useful download filenames", () => {
    expect(imageDownloadName("photo.jpg", "/api/image")).toBe("photo.jpg");
    expect(imageDownloadName("C:\\shots\\screen", "/api/image?path=C%3A%5Cshots%5Cscreen.webp")).toBe("screen.webp");
    expect(imageDownloadName("[image]", "data:image/jpeg;base64,abc")).toBe("image.jpg");
    expect(imageDownloadName("../bad:name", "/api/image")).toBe("bad_name.png");
  });
});
