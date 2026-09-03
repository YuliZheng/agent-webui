import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MESSAGE_DISPLAY_STYLE_OPTIONS } from "@claude-webui/shared/prefs";

const css = readFileSync(join(process.cwd(), "src/styles/tailwind.css"), "utf8");
const appVue = readFileSync(join(process.cwd(), "src/App.vue"), "utf8");
const pillRowVue = readFileSync(join(process.cwd(), "src/components/PillRow.vue"), "utf8");
const settingsModalVue = readFileSync(join(process.cwd(), "src/components/modals/SettingsModal.vue"), "utf8");
const messageListVue = readFileSync(join(process.cwd(), "src/components/MessageList.vue"), "utf8");
const userAvatarVue = readFileSync(join(process.cwd(), "src/components/UserAvatar.vue"), "utf8");
const userAvatarStore = readFileSync(join(process.cwd(), "src/stores/user-avatar.ts"), "utf8");
const avatarEditorVue = readFileSync(join(process.cwd(), "src/components/AvatarEditorModal.vue"), "utf8");
const promptInputVue = readFileSync(join(process.cwd(), "src/components/PromptInput.vue"), "utf8");
const userPromptVue = readFileSync(join(process.cwd(), "src/components/blocks/UserPromptBlock.vue"), "utf8");
const toolCallVue = readFileSync(join(process.cwd(), "src/components/blocks/tool/ToolCall.vue"), "utf8");
const toolRunVue = readFileSync(join(process.cwd(), "src/components/blocks/tool/ToolRunBlock.vue"), "utf8");
const compactBoundaryVue = readFileSync(join(process.cwd(), "src/components/blocks/system/CompactBoundaryBlock.vue"), "utf8");
const contextFooterVue = readFileSync(join(process.cwd(), "src/components/blocks/ContextFooter.vue"), "utf8");

describe("message display style CSS", () => {
  it("has app-shell, html, and transcript hooks for every configured style", () => {
    expect(appVue).toContain("cw-shell-${prefs.messageDisplayStyle}");
    for (const { value } of MESSAGE_DISPLAY_STYLE_OPTIONS) {
      expect(css, `${value} html hook`).toContain(`cw-style-${value}`);
      expect(css, `${value} message hook`).toContain(`cw-display-${value}`);
    }
    expect(css).not.toContain(".cw-display-claude-code .cw-message-scroller::before");
    expect(css).not.toContain(".cw-display-claude-code .cw-message-entry::before");
    expect(css).not.toContain("width: min(1120px, calc(100% - 24px))");
    expect(css).not.toContain("width: min(860px, calc(100% - 18px))");
    expect(css).not.toContain("width: min(1040px, calc(100% - 28px))");
    expect(css).not.toContain("width: min(980px, calc(100% - 32px))");
    expect(css).not.toContain("width: min(1240px, calc(100% - clamp(24px, 4vw, 88px)))");
    expect(css).not.toContain("max-width: min(780px, calc(100% - 44px))");
    expect(css).not.toContain(".cw-display-console");
    expect(css).not.toContain("cw-style-console");
  });

  it("lets zoom-sensitive chat styles use the available viewport width", () => {
    expect(css).toMatch(/\.cw-display-claude-code \.cw-message-entry\s*\{[^}]*width:\s*auto;[^}]*max-width:\s*none;[^}]*margin:\s*0 clamp\(16px, 2vw, 42px\) 12px;/s);
    expect(css).toMatch(/\.cw-message-list\.cw-display-claude-code \.cw-user-prompt-wrap\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;/s);
    expect(css).toMatch(/\.cw-display-codex \.cw-message-entry\s*\{[^}]*width:\s*auto;[^}]*max-width:\s*none;[^}]*margin:\s*0 clamp\(16px, 2vw, 42px\) 10px;/s);
    expect(css).toMatch(/\.cw-message-list\.cw-display-codex \.cw-user-prompt-wrap\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;/s);
    expect(css).toMatch(/\.cw-display-antigravity \.cw-message-entry\s*\{[^}]*width:\s*auto;[^}]*max-width:\s*none;[^}]*margin:\s*0 clamp\(18px, 2\.4vw, 48px\) 12px;/s);
    expect(css).toMatch(/\.cw-display-wechat \.cw-message-entry\s*\{[^}]*width:\s*min\(calc\(100% - clamp\(24px, 4vw, 96px\)\), clamp\(1240px, 86vw, 1920px\)\);[^}]*max-width:\s*none;[^}]*margin:\s*0 auto 9px;/s);
    // WeChat mirror-alignment band: flex items capped at entry width minus
    // BOTH avatar columns (2×(38px avatar + 8px gap) = 92px desktop;
    // 2×(34px + 8px) = 84px mobile), with NO narrower clamp — a clamp below
    // the band would let long bubbles shrink and re-anchor to their own
    // avatar, breaking the left/right edge alignment.
    expect(css).toContain("max-width: calc(100% - 92px)");
    expect(css).toContain("max-width: calc(100% - 84px) !important");
    expect(css).not.toContain("max-width: min(clamp(780px, 52vw, 1200px), calc(100% - 44px))");
    expect(css).toContain(".cw-message-list.cw-display-wechat .cw-user-prompt-wrap");
    expect(css).toContain(".cw-message-list.cw-display-wechat {\n  --cw-wechat-user-bg: #95ec69");
    expect(css).toContain(".cw-display-wechat .cw-user-prompt-fade");
    expect(css).toContain("linear-gradient(to bottom, transparent, var(--cw-wechat-user-bg");
  });

  it("renders sparse WeChat-style timestamps without turning every message into metadata", () => {
    expect(messageListVue).toContain('type TimeRow = { kind: "time"');
    expect(messageListVue).toContain("withMessageTimeRows(rows, previousConversationTimestamp");
    expect(messageListVue).toContain("v-if=\"row.kind === 'time'\"");
    expect(messageListVue).toContain("<time :datetime=\"row.datetime\">{{ row.label }}</time>");
    expect(css).toContain(".cw-message-time");
    expect(css).toContain("font-variant-numeric: tabular-nums");
  });

  it("does not position the composer as an overlay in any style", () => {
    const promptInputRules = [...css.matchAll(/\.cw-[^{]*cw-prompt-input[^{]*\{([^}]*)\}/g)];
    expect(promptInputRules.length).toBeGreaterThan(0);
    for (const match of promptInputRules) {
      const declarations = match[1] ?? "";
      expect(declarations).not.toMatch(/position\s*:\s*(absolute|fixed)/);
    }
  });

  it("themes shared shell surfaces instead of leaving component defaults", () => {
    for (const hook of [
      ".cw-session-row",
      ".cw-session-row-selected",
      ".cw-session-selected-strip",
      ".pill-btn",
      ".pill-pop",
      ".pill-pop-item",
      ".cw-modal-card option",
    ]) {
      expect(css, `${hook} themed`).toContain(hook);
    }
    expect(css).toContain("color-scheme: light");
    expect(css).toContain("color-scheme: dark");
    expect(css).toContain("--cw-inline-code-bg");
    expect(css).toContain("--cw-code-block-bg");
    expect(css).toContain("--cw-queue-bg");
    expect(css).toContain("--cw-queue-ok-bg");
    expect(css).toContain("--cw-queue-ok-border");
    expect(css).toContain("--cw-queue-ok-text");
    expect(css).toContain("--cw-queue-failed-bg");
    expect(css).toContain("--cw-user-bg");
    expect(css).toContain("--cw-assistant-accent");
    expect(css).toContain("--cw-tool-accent");
    expect(css).toContain("--cw-preview-accent");
    expect(css).toContain("--cw-wechat-user-bg");
    expect(css).toContain("--cw-panel-bg: #2f2f30");
    expect(css).toContain("--cw-panel-2: #3a3a3b");
    expect(css).toContain("--cw-header-bg: #1e1e1f");
    expect(css).toContain("--cw-input-bg: #1e1e1f");
    expect(css).toContain("--cw-composer-bg: #1e1e1f");
    expect(css).toContain("--cw-border-strong: #505052");
    expect(css).toContain("--cw-accent: #19ac71");
    expect(css).toContain("--cw-wechat-selection: #0da869");
    expect(css).toContain("--cw-wechat-user-bg: #2ba245");
    expect(css).toContain(".cw-app-shell.cw-shell-wechat .cw-session-row {");
    expect(css).toContain(".cw-app-shell.cw-shell-wechat .cw-session-row-selected");
    expect(css).toContain(".cw-app-shell.cw-shell-wechat .cw-sidebar-search-input");
    expect(css).toContain("html.dark.cw-style-codex");
    expect(css).toContain("html.dark.cw-style-antigravity");
    expect(css).toContain("html:not(.light).cw-style-codex");
    expect(css).toContain("html:not(.light).cw-style-antigravity");
    expect(css).toContain("html.dark.cw-style-wechat");
    expect(css).not.toContain("html.cw-style-wechat:not(.light)");
    expect(css).toContain(".prose :not(pre) > code");
    expect(css).toContain(".prose a");
    expect(css.toLowerCase()).toContain("#2ba245");
    expect(css.toLowerCase()).toContain("#07180d");
    expect(css).toContain("--cw-wechat-user-text: #07180d");
    expect(css).toContain("--tw-prose-counters: #031008");
    expect(css).toContain(".cw-user-prompt .prose");
    expect(css).toContain(".cw-display-wechat .cw-user-prompt .prose *");
    expect(css).toContain(".cw-display-wechat .cw-user-prompt .prose ol > li::marker");
    expect(css).toContain(".cw-display-wechat .cw-message-avatar");
    expect(css).toContain(".cw-display-wechat .cw-message-avatar-user img");
    expect(css.toLowerCase()).not.toContain("#eaf3ec");
    expect(pillRowVue).toContain("var(--cw-pill-bg");
    expect(pillRowVue).toContain("var(--cw-popover-bg");
    expect(promptInputVue).toContain("cw-image-remove-button");
    expect(promptInputVue).toContain("useLightboxStore");
    expect(promptInputVue).toContain("lightbox.open(img.dataUrl");
    expect(promptInputVue.match(/@click="previewImage\(img\)"/g)).toHaveLength(2);
    expect(promptInputVue.match(/@click\.stop="removeImage\(img\.id\)"/g)).toHaveLength(2);
    expect(promptInputVue).toContain("cursor-zoom-in");
    expect(promptInputVue).toContain("cw-wechat-resize-handle");
    expect(promptInputVue).toContain("showSendButton");
    expect(promptInputVue).toContain("isDesktopViewport");
    expect(promptInputVue).toContain("发送(S)");
    expect(promptInputVue).not.toContain("cw-wechat-toolbar");
    expect(promptInputVue).not.toContain("cw-wechat-tool");
    expect(promptInputVue).toContain("startWechatComposerResize");
    expect(promptInputVue).toContain("--cw-wechat-composer-height");
    expect(css).toContain(".cw-app-shell:not(.cw-shell-current) .cw-send-button:hover");
    expect(css).toContain(".cw-app-shell:not(.cw-shell-current) .cw-image-remove-button");
    expect(css).toContain(".cw-app-shell.cw-shell-wechat .cw-wechat-resize-handle");
    expect(css).toContain("@media (min-width: 768px)");
    expect(css).toContain("@media (max-width: 767px)");
    expect(css).toContain("height: var(--cw-wechat-composer-height, 168px)");
    expect(css).toContain(".cw-app-shell.cw-shell-wechat .cw-composer-row");
    expect(css).toContain(".cw-app-shell.cw-shell-wechat .cw-composer-textarea:focus");
    expect(css).toContain("font-size: 15.5px");
    expect(css).toContain("line-height: 1.65");
    expect(css).toContain(".cw-display-wechat .cw-user-prompt .prose p");
    expect(css).toContain("line-height: 1.62");
    expect(css).toContain("background: var(--cw-wechat-peer-bg, var(--cw-panel-bg)) !important");
    expect(css).toContain("margin-left: auto");
    expect(css).toContain("border-radius: 6px 2px 6px 6px");
    expect(css).toContain(".cw-app-shell.cw-shell-wechat .cw-send-button:disabled");
    expect(css).toContain("min-width: 76px");
    expect(css).toContain("display: none;");
    expect(css).toContain("--tw-ring-color: transparent !important");
    expect(css).not.toContain(".cw-app-shell.cw-shell-wechat .cw-wechat-toolbar");
    expect(css).not.toContain(".cw-app-shell.cw-shell-wechat .cw-wechat-tool");
    expect(css).toContain("grid-template-columns: minmax(0, 1fr) auto");
    expect(css).toMatch(/@media \(min-width: 768px\)[\s\S]*\.cw-app-shell\.cw-shell-wechat \.cw-mic-toggle,[\s\S]*\.cw-app-shell\.cw-shell-wechat \.cw-attach-button[\s\S]*display: none !important/);
    expect(css).toMatch(/@media \(max-width: 767px\)[\s\S]*\.cw-app-shell\.cw-shell-wechat \.cw-mic-toggle,[\s\S]*\.cw-app-shell\.cw-shell-wechat \.cw-attach-button[\s\S]*display: inline-flex !important/);
    expect(css).toContain("display: inline-flex !important");
    expect(css).toContain("calc(10px + env(safe-area-inset-bottom))");
    expect(css).toContain("cw-display-compact .cw-message-entry[data-block=\"UserPromptBlock\"]::before");
  });

  it("treats Fast as a last-choice-wins Codex service-tier toggle", () => {
    expect(pillRowVue).toContain('setSessionServiceTier');
    expect(pillRowVue).toContain('getAgentCapabilities');
    expect(pillRowVue).toContain('pendingFastTier.value = next');
    expect(pillRowVue).toContain('while (pendingFastTier.value !== null)');
    expect(pillRowVue).toContain('pendingFastTier.value === requested');
    expect(pillRowVue).toContain('const fastSupported = computed');
    expect(pillRowVue).toContain('const confirmedTier = requested === "priority" ? "priority" : "standard"');
    expect(pillRowVue).toContain('fastSupportKnown');
    expect(pillRowVue).toContain('fastUnavailable');
    expect(pillRowVue).toContain(':disabled="fastUnavailable"');
    expect(pillRowVue).toContain('applies from the next turn');
    expect(pillRowVue).toContain(':aria-pressed="fastKnown ? fastMode : \'mixed\'"');
    expect(pillRowVue).toContain(':aria-busy="fastBusy"');
    expect(pillRowVue).not.toContain(':disabled="fastBusy"');
    const existingSessionTier = pillRowVue.indexOf("return codexEff.value.serviceTier;");
    const capabilityDefaultTier = pillRowVue.indexOf("const defaultTier = codexCapabilities.value?.defaults.serviceTier;");
    expect(existingSessionTier).toBeGreaterThan(-1);
    expect(capabilityDefaultTier).toBeGreaterThan(existingSessionTier);
    expect(pillRowVue).toContain('class="pill-pop-item pill-pop-fast"');
    expect(pillRowVue).toContain("'pill-pop-fast-active': fastMode");
    expect(pillRowVue).toContain('class="fast-toggle"');
    expect(pillRowVue).toContain('class="fast-inline-mark"');
    expect(pillRowVue).not.toContain('@click="pickEffort(\'\')"');
    expect(pillRowVue).not.toContain('pill-active-fast');
    expect(pillRowVue).not.toContain('const next = fastMode.value ? "" : "fast"');
    expect(settingsModalVue).toContain("codex Fast by default");
    expect(settingsModalVue).toContain("prefs.defaultCodexServiceTier === 'priority'");
    expect(settingsModalVue).toContain("prefs.setDefaultCodexFast");
  });

  it("uses a non-sticky anchor for prompt navigation and uuid targeting", () => {
    expect(messageListVue).toContain("cw-user-prompt-anchor");
    expect(messageListVue).toContain('data-user-prompt="true"');
    expect(messageListVue).toContain("entry.node.block === 'UserPromptBlock'");
    expect(userPromptVue).toContain('data-user-prompt-visual="true"');
    expect(userPromptVue).not.toContain('data-user-prompt="true"');
    expect(userPromptVue).toContain("Show more");
    expect(userPromptVue).toContain("Show less");
    expect(userPromptVue).toContain("cw-user-prompt-wrap");
    expect(userPromptVue).toContain("preview?: boolean");
    expect(userPromptVue).toContain("const preview = computed(() => props.preview === true)");
    expect(userPromptVue).toContain("const previewLikelyCollapsible = computed");
    expect(userPromptVue).toContain("const bodyCollapsed = computed(() => preview.value ? collapsed.value : (collapsible.value && collapsed.value))");
    expect(userPromptVue).toContain("function toggleCollapsed(event: MouseEvent)");
    expect(userPromptVue).toContain("@click=\"toggleCollapsed\"");
    expect(userPromptVue).not.toContain("hover:");
    expect(userPromptVue).toContain("cw-user-prompt-image-bubble");
    expect(userPromptVue).toContain("cw-user-prompt-text-bubble");
    expect(userPromptVue).toContain("cw-user-prompt-images");
    expect(userPromptVue).toContain("cw-user-prompt-actions");
    expect(userPromptVue).not.toContain("absolute top-1 right-2");
    expect(css).toContain(".cw-user-prompt-wrap:hover .cw-user-prompt-actions");
    expect(css).toContain("width: max-content");
    expect(css).not.toMatch(/\.cw-user-prompt:hover \.cw-user-prompt-actions[^{]*\{[^}]*display:\s*flex/s);
    expect(messageListVue).toContain("stickyPromptUuid");
    expect(messageListVue).toContain("recomputeStickyPrompt");
    expect(messageListVue).toContain("cw-sticky-prompt-current");
    expect(messageListVue).toContain("stickyPromptOverlayEntry");
    expect(messageListVue).toContain("cw-sticky-prompt-overlay-frame");
    expect(messageListVue).toContain("cw-sticky-prompt-overlay");
    expect(messageListVue).toContain(":key=\"recordUuid(stickyPromptOverlayEntry)\"");
    expect(messageListVue).toContain("preview");
    expect(messageListVue).toContain("messageDisplayStyle.value === \"claude-code\") return false");
    expect(messageListVue).toContain("AgentBadge");
    expect(messageListVue).toContain("isWechatAvatarEntry");
    expect(messageListVue).toContain("cw-message-avatar-user");
    expect(messageListVue).toContain("<UserAvatar");
    expect(messageListVue).toContain("<AvatarEditorModal");
    expect(userPromptVue).toContain("<UserAvatar");
    expect(userAvatarStore).toContain("/api/me/avatar");
    expect(userAvatarVue).toContain(':src="avatar.src"');
    expect(userAvatarVue).toContain("avatar.edit()");
    expect(avatarEditorVue).toContain("自动居中裁成正方形");
    expect(avatarEditorVue).toContain("putUserAvatar");
    expect(avatarEditorVue).toContain("deleteUserAvatar");
    expect(css).toContain(".cw-user-avatar-edit-hint");
    expect(css).toMatch(/@media \(hover:\s*none\)\s*\{\s*\.cw-user-avatar-edit-hint\s*\{\s*display:\s*none;/s);
    expect(messageListVue).toContain("cw-message-avatar-assistant");
    expect(css).toContain(".cw-display-claude-code .cw-sticky-prompt-overlay");
    expect(css).toMatch(/\.cw-display-claude-code \.cw-sticky-prompt-overlay-frame\s*\{[^}]*inset:\s*0;[^}]*overflow:\s*hidden;/s);
    expect(css).toMatch(/\.cw-display-claude-code \.cw-sticky-prompt-overlay \.cw-user-prompt-toggle\s*\{[^}]*pointer-events:\s*auto;/s);
    expect(css).toMatch(/@media \(hover:\s*hover\)\s*\{[^}]*\.cw-display-claude-code \.cw-user-prompt-toggle:hover/s);
    expect(css).toContain("position: absolute");
    expect(css).toContain("background: var(--cw-shell-bg) !important");
    expect(css).toMatch(/\.cw-display-claude-code \.cw-sticky-prompt-overlay\s*\{[^}]*top:\s*0;[^}]*padding:\s*12px clamp\(16px, 2vw, 42px\) 8px;/s);
    expect(css).not.toMatch(/\.cw-display-claude-code \.cw-message-entry\.cw-sticky-prompt-current\[data-block="UserPromptBlock"\]/);
    expect(css).not.toMatch(/\.cw-display-claude-code \.cw-message-entry\[data-block="UserPromptBlock"\]\s*\{[^}]*position:\s*sticky/s);
    expect(messageListVue).toContain("const CLAUDE_CODE_STICKY_GAP_PX = 12");
    expect(messageListVue).toContain("const stickyTop = isClaudeCode ? CLAUDE_CODE_STICKY_GAP_PX : 0");
    // Push math measures the pinned row's bottom (+4px breathing room) in both
    // the overlay (claude-code) and in-flow branches.
    expect(messageListVue).toContain("pinBottom = frameTop + stickyOverlayEl.value.offsetHeight + 4");
    expect(messageListVue).toContain("pinBottom = el.scrollTop + stickyTop + h + 4");
    expect(messageListVue).not.toContain("switchLag");
    expect(css).not.toContain("backdrop-filter: blur(12px)");
    expect(css).toContain(".cw-user-prompt-body img");
    expect(css).toContain(".cw-display-wechat .cw-user-prompt-image-bubble");
    expect(css).toContain(".cw-display-wechat .cw-user-prompt-image-bubble::after");
  });

  it("keeps the composer usable while a turn is running so sends can queue", () => {
    expect(promptInputVue).toContain("Running… (Send to queue)");
    expect(promptInputVue).toContain(':disabled="isInflightHere"');
    expect(promptInputVue).not.toContain(':disabled="running"');
    expect(promptInputVue).not.toContain("!running && canSend");
  });

  it("compacts pure tool-only assistant rows without changing timeline structure", () => {
    expect(toolCallVue).toContain("cw-tool-call");
    expect(toolCallVue).toContain("cw-tool-call-header");
    expect(css).toContain(':has(> .cw-assistant-block > .cw-tool-call):not(:has(.prose))');
    expect(css).toContain(".cw-tool-call-header");
    expect(messageListVue).toContain("TOOL_RUN_MIN = 2");
    expect(messageListVue).toContain("collapsibleToolItems");
    expect(messageListVue).toContain("ToolRunBlock");
    expect(toolRunVue).toContain("cw-tool-run-anchor");
    expect(css).toContain('.cw-message-entry[data-block="ToolRunBlock"]');
    expect(css).toContain('.cw-message-entry[data-block="ToolRunBlock"]::before');
    expect(css).toContain(".cw-message-entry:has(.cw-tool-call)::before");
    expect(css).toContain("content: none !important");
  });

  it("fuses the compact boundary + summary into one card via adjacency, scoped out of the compact skin", () => {
    // Merge is CSS-only adjacency (no parser/group.ts change): boundary is the
    // header when it has an adjacent summary sibling; summary is the body.
    expect(css).toContain(
      '.cw-message-entry[data-block="CompactBoundaryBlock"]:has(+ .cw-message-entry[data-block="UserCompactSummaryBlock"])',
    );
    expect(css).toContain('+ .cw-message-entry[data-block="UserCompactSummaryBlock"]');
    // Both merge rules must be scoped under .cw-message-list:not(.cw-display-compact)
    // so the compact skin's flat-row !important chrome never fights the card.
    expect(css).toContain(".cw-message-list:not(.cw-display-compact)");
    // Richer boundary readout reads the real metadata (duration + kept count).
    expect(compactBoundaryVue).toContain("durationMs");
    expect(compactBoundaryVue).toContain("preservedMessages");
    expect(compactBoundaryVue).toContain("kept");
    // usage>100% renders an over-limit treatment instead of a raw scary number.
    expect(contextFooterVue).toContain("over limit");
    expect(contextFooterVue).toContain("cw-context-over");
    expect(css).toContain(".cw-context-over");
  });

  it("keeps the context source chart expanded without a disclosure arrow", () => {
    expect(contextFooterVue).not.toContain("usageOpen");
    expect(contextFooterVue).not.toContain("toggleUsage");
    expect(contextFooterVue).not.toContain("cw-context-usage-chevron");
    expect(contextFooterVue).toContain('v-if="showAll || limit"');
    expect(contextFooterVue).toContain('const usageScope = ref<UsageScope>("all")');
    expect(contextFooterVue).toContain("threadUsage");
    expect(contextFooterVue).toContain("Scanning the full rollout for source attribution");
    expect(contextFooterVue).toContain("Full rollout scan complete");
    expect(contextFooterVue).toContain("bounded compatibility fallback until restart");
    expect(contextFooterVue).not.toContain("sources {{ contributorText }}");
    expect(contextFooterVue).toContain("Source attribution is approximate because Codex reports only the total.");
    expect(contextFooterVue).toContain("unattributed context");
    expect(contextFooterVue).toContain("Codex base context");
    expect(css).toContain("--cw-context-base");
    expect(contextFooterVue).toContain("rows sum to this total");
    expect(contextFooterVue).toContain("~1.8k default visual estimate");
    expect(contextFooterVue).toContain("hosted image-generation cost is separate from context tokens");
    expect(contextFooterVue).toContain("Tool results are capped at ~2k each.");
    expect(css).toContain(".cw-context-usage-chart");
    expect(contextFooterVue).toContain("conic-gradient");
    expect(css).toContain(".cw-context-usage-label");
    expect(css).not.toContain(".cw-context-usage-trigger");
    expect(css).toContain("grid-template-columns: minmax(0, 1fr)");
  });
});
