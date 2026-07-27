import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const indexHtml = readFileSync(join(root, "index.html"), "utf8");
const css = readFileSync(join(root, "src/styles/tailwind.css"), "utf8");
const app = readFileSync(join(root, "src/App.vue"), "utf8");
const mainPane = readFileSync(join(root, "src/components/MainPane.vue"), "utf8");
const messageList = readFileSync(join(root, "src/components/MessageList.vue"), "utf8");
const promptInput = readFileSync(join(root, "src/components/PromptInput.vue"), "utf8");

describe("mobile software-keyboard layout", () => {
  it("asks Chromium to resize the layout viewport above the keyboard", () => {
    expect(indexHtml).toContain("interactive-widget=resizes-content");
  });

  it("keeps document scrolling locked to the app's internal scrollers", () => {
    expect(css).toMatch(/html, body, #app\s*\{[\s\S]*?overflow:\s*hidden;/);
    expect(css).toMatch(/\.cw-app-shell\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*hidden;/);
    expect(app).toContain("flex h-full min-h-0 overflow-hidden");
    expect(mainPane).toContain("h-full min-h-0 overflow-hidden");
  });

  it("keeps the title and composer as non-shrinking edges around the message scroller", () => {
    expect(mainPane).toContain("cw-main-header shrink-0");
    expect(mainPane).toContain("cw-main-header cw-preview-header shrink-0");
    expect(promptInput).toContain("cw-prompt-input shrink-0");
  });

  it("reveals the latest message when the mobile composer summons the keyboard", () => {
    expect(promptInput).toContain('emit("mobile-composer-focus")');
    expect(promptInput).toContain('@focus="onTextareaFocus"');
    expect(mainPane).toContain('@mobile-composer-focus="revealLatestForMobileKeyboard"');
    expect(mainPane).toContain("messageListRef.value?.revealLatest()");
    expect(messageList).toContain("defineExpose({ revealLatest: forceScrollSoon })");
    expect(messageList).toContain("el.clientHeight === lastClientHeight");
  });
});
