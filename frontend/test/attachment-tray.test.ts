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

  it("keeps the latest message visible when the mobile tray opens", () => {
    expect(promptInput).toMatch(
      /if \(attachmentTrayOpen\.value\)[\s\S]*?emit\("mobile-composer-focus"\)/,
    );
  });

  it("keeps gallery media, camera capture, and file browsing separate", () => {
    expect(promptInput).toMatch(
      /ref="galleryInputRef"[\s\S]*?accept="image\/\*,video\/\*"[\s\S]*?multiple/,
    );
    expect(promptInput).toMatch(
      /ref="cameraInputRef"[\s\S]*?accept="image\/\*"[\s\S]*?capture="environment"/,
    );
    expect(promptInput).toMatch(
      /ref="browseInputRef"[\s\S]*?accept="application\/pdf,video\/\*"[\s\S]*?multiple/,
    );
    expect(promptInput).toContain(
      "if (!ACCEPTED_ATTACHMENT_MIME.test(blob.type))",
    );
  });

  it("rejects a selected video with a clear message before reading or compressing it", () => {
    expect(promptInput).toContain("暂不支持发送视频，请改发关键截图。");
    expect(promptInput).toContain('{ title: "视频未添加" }');
    expect(promptInput).toMatch(
      /async function ingestAttachmentBlob[\s\S]*?if \(isVideoAttachment\(blob, name\)\)[\s\S]*?return;[\s\S]*?preparePromptAttachment/,
    );
    expect(promptInput).toMatch(
      /accept="image\/\*,application\/pdf,video\/\*"/,
    );
  });

  it("reads each selected photo once and releases the native picker before awaiting", () => {
    expect(promptInput).not.toContain("blobToBase64");
    expect(promptInput.match(/reader\.readAsDataURL\(blob\)/g)).toHaveLength(1);
    expect(promptInput).toMatch(
      /const files = Array\.from\(input\.files \?\? \[\]\);[\s\S]*?input\.value = "";[\s\S]*?for \(const f of files\) await ingestAttachmentBlob/,
    );
    expect(promptInput).toContain("FILE_READ_TIMEOUT_MS");
    expect(promptInput).toContain("reader.onabort");
  });

  it("keeps attachment access independent from the send button", () => {
    expect(promptInput).toContain("attachmentButtonLabel");
    expect(promptInput).toContain("继续添加附件，当前");
    expect(promptInput).toMatch(
      /class="cw-composer-row[\s\S]*?class="cw-attach-button[\s\S]*?<textarea[\s\S]*?v-if="showSendButton"[\s\S]*?class="cw-send-button/,
    );
    expect(promptInput).not.toMatch(
      /v-if="showSendButton"[\s\S]{0,900}?v-else[\s\S]{0,300}?cw-attach-button/,
    );
  });

  it("rejects an over-limit selection before reading it into the draft", () => {
    expect(promptInput).toMatch(
      /const attachmentError = promptAttachmentError\([\s\S]*?pendingImages\.value[\s\S]*?blob\.size[\s\S]*?currentAgent\.value[\s\S]*?if \(attachmentError\)[\s\S]*?附件未添加[\s\S]*?return;[\s\S]*?blobToDataUrl/,
    );
  });

  it("defaults to compressed photos with an explicit original-quality toggle", () => {
    expect(promptInput).toContain("preparePromptAttachment(blob, name, sendOriginalAttachments.value)");
    expect(promptInput).toContain("attachmentSizeSummary");
    expect(promptInput).toContain("<span>原图</span>");
    expect(promptInput).toContain('v-model="sendOriginalAttachments"');
    expect(promptInput).toContain(":aria-pressed=\"sendOriginalAttachments\"");
  });

  it("nests original quality under the gallery instead of presenting it as a source", () => {
    expect(promptInput).toMatch(
      /class="cw-attachment-action-group"[\s\S]*?@click="openGalleryPicker"[\s\S]*?<span>相册<\/span>[\s\S]*?class="cw-gallery-original-option"[\s\S]*?v-model="sendOriginalAttachments"[\s\S]*?<span>原图<\/span>/,
    );
    expect(promptInput.match(/class="cw-attachment-action"/g)).toHaveLength(3);
    expect(promptInput).not.toContain("cw-attachment-action-active");
  });

  it("matches the three-column mobile attachment-panel geometry", () => {
    expect(css).toContain(".cw-attachment-tray");
    expect(css).toContain("grid-template-columns: repeat(3, minmax(0, 1fr))");
    expect(css).toContain(".cw-attachment-action-icon");
    expect(css).toContain("width: 64px");
    expect(css).toContain("height: 64px");
    expect(css).toMatch(
      /\.cw-gallery-original-option\s*\{[^}]*min-height: 44px;/,
    );
  });

  it("keeps mobile composer controls at a 44px touch target", () => {
    expect(css).toMatch(
      /\.cw-prompt-input \.cw-attach-button\s*\{[^}]*width: 44px !important;[^}]*height: 44px !important;/,
    );
    expect(css).toMatch(
      /\.cw-prompt-input \.cw-send-button,[\s\S]*?\.cw-prompt-input \.cw-composer-textarea\s*\{[^}]*min-height: 44px;/,
    );
  });
});
