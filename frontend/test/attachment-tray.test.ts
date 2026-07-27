import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const promptInput = readFileSync(
  join(root, "src/components/PromptInput.vue"),
  "utf8",
);
const css = readFileSync(join(root, "src/styles/tailwind.css"), "utf8");

describe("mobile attachment tray", () => {
  it("uses an in-app WeChat-style tray before native pickers", () => {
    expect(promptInput).toContain("attachmentTrayOpen");
    expect(promptInput).toContain('id="cw-attachment-tray"');
    expect(promptInput).toContain('v-if="!isDesktopViewport && attachmentTrayOpen"');
    expect(promptInput).toContain("@click=\"openGalleryPicker\"");
    expect(promptInput).toContain("@click=\"openCameraPicker\"");
    expect(promptInput).toContain("@click=\"openFileBrowser\"");
    expect(promptInput).toContain("<span>相册</span>");
    expect(promptInput).toContain("<span>拍摄</span>");
    expect(promptInput).toContain("<span>文件</span>");
  });

  it("keeps the original combined picker on desktop layouts", () => {
    expect(promptInput).toMatch(
      /function toggleAttachmentTray\(\)[\s\S]*?if \(isDesktopViewport\.value\)[\s\S]*?openFilePicker\(\)/,
    );
    expect(promptInput).toContain(
      "if (isDesktopViewport.value) attachmentTrayOpen.value = false;",
    );
  });

  it("separates gallery, camera, and generic SAF browsing intents", () => {
    expect(promptInput).toMatch(
      /ref="galleryInputRef"[\s\S]*?accept="image\/\*"[\s\S]*?multiple/,
    );
    expect(promptInput).toMatch(
      /ref="cameraInputRef"[\s\S]*?accept="image\/\*"[\s\S]*?capture="environment"/,
    );
    expect(promptInput).toMatch(
      /ref="browseInputRef"[\s\S]*?accept="\*\/\*"[\s\S]*?multiple/,
    );
    expect(promptInput).toContain(
      "if (!ACCEPTED_ATTACHMENT_MIME.test(blob.type))",
    );
  });

  it("matches the four-column mobile attachment-panel geometry", () => {
    expect(css).toContain(".cw-attachment-tray");
    expect(css).toContain("grid-template-columns: repeat(4, minmax(0, 1fr))");
    expect(css).toContain(".cw-attachment-action-icon");
    expect(css).toContain("width: 64px");
    expect(css).toContain("height: 64px");
  });
});
