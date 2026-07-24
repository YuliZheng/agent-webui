import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import SessionRow from "@/components/SessionRow.vue";
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  defaultSidebarWidth,
  formatSessionListTime,
  sessionAppearance,
  storedSidebarWidth,
} from "@/util/session-appearance";
import type { SessionListItem } from "@/types";

function item(id: string, cwd: string, agent: "claude" | "codex" = "claude"): SessionListItem {
  return { id, cwd, agent, mtime: "2026-07-23T02:15:00Z", size: 1, title: "Reference session", preview: "A short preview" };
}

describe("reference sidebar appearance", () => {
  it("derives a stable color from normalized cwd and a stable icon for the agent", () => {
    const first = sessionAppearance("C:\\Work\\Agent-WebUI\\", "claude");
    const equivalent = sessionAppearance("c:/work/agent-webui", "claude");
    const codex = sessionAppearance("c:/work/agent-webui", "codex");
    expect(equivalent).toEqual(first);
    expect(codex.color).toBe(first.color);
    expect(first.emoji).toMatch(/\S/u);
  });

  it("keeps cwd colors aligned while varying icons by stable session identity", () => {
    const first = sessionAppearance("C:\\Work\\Agent-WebUI", "codex", "session-one");
    const second = sessionAppearance("c:/work/agent-webui", "codex", "session-two");
    expect(second.color).toBe(first.color);
    expect(sessionAppearance("C:\\Work\\Agent-WebUI", "codex", "session-one")).toEqual(first);
  });

  it("clamps, defaults, and restores the persisted sidebar width", () => {
    expect(defaultSidebarWidth(2048)).toBe(288);
    expect(clampSidebarWidth(100)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(900)).toBe(SIDEBAR_MAX_WIDTH);
    expect(storedSidebarWidth("518", 2048)).toBe(518);
    expect(storedSidebarWidth("not-a-number", 2048)).toBe(288);
  });

  it("uses the compact time labels from the reference chat list", () => {
    const now = new Date("2026-07-23T12:00:00");
    expect(formatSessionListTime("2026-07-23T09:05:00", now)).toBe("09:05");
    expect(formatSessionListTime("2026-07-22T09:05:00", now)).toBe("Yesterday");
    expect(formatSessionListTime("2026-07-21T09:05:00", now)).toBe("Tue");
  });

  it("renders a compact colored icon, agent badge, preview, and cwd structure", () => {
    const wrapper = mount(SessionRow, { props: { session: item("one", "C:\\tmp\\same-path") } });
    const matching = mount(SessionRow, { props: { session: item("two", "c:/tmp/same-path") } });
    expect(wrapper.get(".cw-session-avatar").attributes("style")).toBe(matching.get(".cw-session-avatar").attributes("style"));
    expect(wrapper.get(".cw-session-avatar-emoji").text()).not.toBe(matching.get(".cw-session-avatar-emoji").text());
    expect(wrapper.find('.cw-session-agent-badge [aria-label="Claude"]').exists()).toBe(true);
    expect(wrapper.get(".cw-session-preview").text()).toBe("A short preview");
    expect(wrapper.find(".cw-session-cwd").exists()).toBe(false);
    const withCwd = mount(SessionRow, { props: { session: item("one", "C:\\tmp\\same-path"), hideCwd: false } });
    expect(withCwd.get(".cw-session-cwd").text()).toBe("C:\\tmp\\same-path");
  });
});
