import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const component = (path: string) => readFileSync(join(process.cwd(), "src/components", path), "utf8");
const messageList = component("MessageList.vue");
const assistantBlock = component("blocks/AssistantBlock.vue");
const toolCall = component("blocks/tool/ToolCall.vue");
const toolRun = component("blocks/tool/ToolRunBlock.vue");
const toolResult = component("blocks/tool/ToolResult.vue");
const chatImage = component("blocks/ChatImage.vue");
const styles = readFileSync(join(process.cwd(), "src/styles/tailwind.css"), "utf8");

describe("long image conversation scroll stability", () => {
  it("anchors history prepends and late layout changes to visible keyed rows", () => {
    expect(messageList).toContain("captureViewportAnchor");
    expect(messageList).toContain("restoreRememberedViewportAnchor");
    expect(messageList).toContain("new ResizeObserver(onHistoryResize)");
    expect(messageList).toContain('ref="historyEl"');
    expect(messageList).toContain('class="cw-message-top-spacer"');
    expect(messageList).toContain(':data-scroll-key="scrollKeyForRow(row)"');
    expect(messageList).toContain("lightboxViewportAnchor = rememberViewportAnchor()");
    expect(messageList).toMatch(/loadEarlier[\s\S]*?lockedToBottom\.value = false;/);
    expect(messageList).toContain("el.scrollHeight > el.clientHeight + NEAR_BOTTOM_PX");
    expect(messageList).toContain("performance.now() <= userScrollIntentUntil");
    expect(messageList).toContain('@touchmove.passive="noteUserScrollIntent"');
    expect(messageList).toContain("renderedFloorSourceIndex");
    expect(messageList).toContain("anchoredRenderStart");
    expect(messageList).toContain("while (renderedSlice.value.start > 0");
    expect(messageList).not.toContain("pendingPromptEl");
    expect(messageList).not.toContain("scrollIntoView({ block: \"end\"");
    expect(styles).toMatch(/\.cw-message-scroller\s*\{\s*display:\s*flex;[\s\S]*?overflow-anchor:\s*none;/);
    expect(styles).toMatch(/\.cw-message-top-spacer\s*\{[\s\S]*?flex:\s*1 1 0%;/);
  });

  it("keeps an expanded tool-image run open when history regrouping remounts it", () => {
    expect(messageList).toContain("expandedToolCallIds");
    expect(messageList).toContain(':expanded="isToolRunExpanded(row)"');
    expect(messageList).toContain('@update:expanded="setToolRunExpanded(row, $event)"');
    expect(messageList).toContain('expandedToolDetailIds');
    expect(messageList).toContain('@update:item-expanded="setToolDetailExpanded"');
    expect(toolRun).toContain('expanded?: boolean');
    expect(toolRun).toContain('emit("update:expanded", value)');
    expect(toolRun).toContain('@update:expanded="setItemExpanded(item.uuid, $event)"');
    expect(toolCall).toContain('expanded?: boolean');
    expect(toolCall).toContain('emit("update:expanded", value)');
  });

  it("does not hide result images when calls move into a grouped tool run", () => {
    expect(toolCall).toContain("hideResultImages?: boolean");
    expect(toolCall).toContain(':hide-images="hideResultImages === true"');
    expect(assistantBlock).toContain("hide-result-images");
    expect(toolRun).toContain("hide-result-images");
  });

  it("reserves thumbnail geometry before async image decode", () => {
    expect(chatImage).toContain("flex h-40 w-[12rem] items-center justify-center");
    expect(toolResult).toContain("flex h-[200px] w-[200px] max-w-full items-center justify-center");
    expect(chatImage).toContain("max-h-full max-w-full object-contain");
    expect(toolResult).toContain("max-h-full max-w-full object-contain");
  });

  it("uses physical coverage and real HTTP refreshes without sacrificing the cached snapshot", () => {
    expect(messageList).toContain("cacheEntry.value?.loadedFromIndex ?? 0");
    expect(messageList).toContain("cache.markLoadedFrom(props.sessionId, from)");
    expect(messageList).toContain("live.refreshSession(props.sessionId, true)");
    expect(messageList).not.toContain("wsWake({ forceReconnect: true })");
    expect(messageList).toContain("较早记录加载失败，点此重试");
    expect(messageList).toContain("同步失败 · 点此重试");
    expect(messageList).toContain("}, 450)");
  });
});
