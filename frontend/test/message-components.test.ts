import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const pane = source("src/components/TranscriptPane.vue");
const entry = source("src/components/TranscriptEntry.vue");
const prompt = source("src/components/blocks/UserPromptBlock.vue");
const assistant = source("src/components/blocks/AssistantBlock.vue");
const result = source("src/components/blocks/ToolResult.vue");
const run = source("src/components/blocks/ToolRunBlock.vue");

describe("message component contracts", () => {
  it("uses the staged render window and exact scroll thresholds", () => {
    expect(pane).toContain("const INITIAL_RENDER_FAST = 30");
    expect(pane).toContain("const INITIAL_RENDER_FULL = 200");
    expect(pane).toContain("const RENDER_BATCH = 200");
    expect(pane).toContain("const AUTO_LOAD_THRESHOLD_PX = 200");
    expect(pane).toContain("const NEAR_BOTTOM_PX = 24");
  });

  it("keeps a standalone prompt anchor and semantic entry attributes", () => {
    expect(pane).toContain('class="cw-user-prompt-anchor"');
    expect(pane).toContain('data-user-prompt="true"');
    expect(prompt).not.toContain('data-user-prompt-visual="true"');
    expect(prompt).not.toContain('data-user-prompt="true"');
    expect(entry).toContain(':data-block="blockName"');
    expect(entry).not.toContain(':data-role=');
    expect(entry).toContain(':data-uuid="entryUuid"');
  });

  it("uses only the overlay clone for Claude Code sticky prompts", () => {
    expect(pane).toContain("const CLAUDE_CODE_STICKY_GAP_PX = 12");
    expect(pane).toContain("stickyPromptOverlayEntry");
    expect(pane).toContain("cw-sticky-prompt-overlay-frame");
    expect(pane).toContain('messageDisplayStyle.value === "claude-code") return false');
    expect(pane).toContain("const stickyTop = isClaudeCode ? CLAUDE_CODE_STICKY_GAP_PX : 0");
    expect(pane).toContain("frameTop + stickyOverlayEl.value.offsetHeight + 4");
    expect(pane).not.toContain("cw-sticky-prompt-current");
  });

  it("implements exact prompt collapse and touch menu invariants", () => {
    expect(prompt).toContain('props.displayStyle === "claude-code" ? 54 : 180');
    expect(prompt).toContain("promptCollapsePx.value + 8");
    expect(prompt).toContain("const previewLikelyCollapsible = computed");
    expect(prompt).toContain("const bodyCollapsed = computed(() => preview.value ? collapsed.value : (collapsible.value && collapsed.value))");
    expect(prompt).toContain("function toggleCollapsed(event: MouseEvent)");
    expect(prompt).toContain("LONG_PRESS_MS = 450");
    expect(prompt).toContain("MOVE_CANCEL_PX = 10");
    expect(prompt).toContain('event.pointerType !== "touch"');
    expect(prompt).toContain('Teleport to="body"');
    expect(prompt).toContain("cw-prompt-action-menu");
    expect(prompt).toContain('@contextmenu="onContextMenu"');
    expect(prompt).toContain("function copyPrompt()");
    expect(prompt).toContain(">Copy</button>");
    expect(prompt).toContain(">↺ Rewind</button>");
    expect(prompt).toContain(">⑂ Fork</button>");
  });

  it("folds thinking, large results, and tool runs with the reference semantics", () => {
    expect(assistant).toContain("cw-thinking-fold");
    expect(assistant).toContain("✻ {{ thinkingItems.length }}");
    expect(result).toContain("display.value.lines > 10");
    expect(result).toContain("display.value.chars > 1000");
    expect(result).toContain("images.value.length > 0");
    expect(result).toContain("ref(props.isError === true)");
    expect(run).toContain("cw-tool-run-anchor");
    expect(run).toContain("cw-tool-run-header");
    expect(run).toContain("isBashToolName");
    expect(run).toContain("props.items.every");
  });
});
