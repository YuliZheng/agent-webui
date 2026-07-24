import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SessionHeader from "@/components/SessionHeader.vue";
import { mainSocket } from "@/api/ws";
import { useUiStore } from "@/stores/ui";
import type { AgentKind, SessionListItem } from "@/types";
import {
  effortControlOptions,
  isCodexYolo,
  modelControlOptions,
  permissionControlOptions,
  sandboxControlOptions
} from "@/util/session-controls";

function session(agent: AgentKind): SessionListItem {
  return {
    id: `${agent}_session`,
    cwd: "C:\\work\\project",
    mtime: "2026-07-23T00:00:00.000Z",
    size: 1,
    agent,
    title: "Project"
  };
}

function mountHeader(agent: AgentKind, extra: Record<string, unknown> = {}) {
  return mount(SessionHeader, {
    props: { session: session(agent), ...extra },
    global: { stubs: { Teleport: true } }
  });
}

function optionValues(wrapper: ReturnType<typeof mountHeader>, selector: string): string[] {
  return wrapper.findAll(`${selector} option`).map((option) => option.attributes("value") ?? "");
}

beforeEach(() => {
  vi.restoreAllMocks();
  setActivePinia(createPinia());
});

describe("session control options", () => {
  it("uses agent presets while retaining an unknown current model", () => {
    expect(modelControlOptions("claude").map((option) => option.value)).toEqual(["sonnet", "opus", "haiku"]);
    expect(modelControlOptions("codex").map((option) => option.value)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark"
    ]);
    expect(modelControlOptions("codex", "private-codex").map((option) => option.value)).toEqual([
      "private-codex",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark"
    ]);
    expect(modelControlOptions("claude", "sonnet").filter((option) => option.value === "sonnet")).toHaveLength(1);
  });

  it("exposes the installed permission vocabulary and exact Codex YOLO pair", () => {
    expect(permissionControlOptions("claude").map((option) => option.value)).toEqual([
      "auto",
      "acceptEdits",
      "manual",
      "dontAsk",
      "plan",
      "bypassPermissions"
    ]);
    expect(permissionControlOptions("codex").map((option) => option.value)).toEqual([
      "untrusted",
      "on-request",
      "never"
    ]);
    expect(sandboxControlOptions().map((option) => option.value)).toEqual([
      "read-only",
      "workspace-write",
      "danger-full-access"
    ]);
    expect(isCodexYolo("never", "danger-full-access")).toBe(true);
    expect(isCodexYolo("never", "workspace-write")).toBe(false);
    expect(isCodexYolo("on-request", "danger-full-access")).toBe(false);
  });

  it("links effort choices to the selected Codex model", () => {
    expect(effortControlOptions("codex", "gpt-5.6-sol").map((option) => option.value)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra"
    ]);
    expect(effortControlOptions("codex", "gpt-5.6-luna").map((option) => option.value)).not.toContain("ultra");
  });
});

describe("SessionHeader controls", () => {
  it("uses product marks and middle dots, then copies complete metadata values", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true
    });
    const wrapper = mountHeader("codex");
    const metadata = wrapper.get(".cw-header-session-meta");

    expect(metadata.find('svg[aria-label="Codex"]').exists()).toBe(true);
    expect(metadata.findAll(".cw-header-meta-separator").map((item) => item.text())).toEqual(["·", "·"]);
    expect(metadata.text()).not.toContain("~");
    expect(wrapper.get('[data-testid="copy-session-path"]').text()).toBe("C:\\work\\project");
    expect(wrapper.get('[data-testid="copy-session-id"]').text()).toBe("codex_se…");

    await wrapper.get('[data-testid="copy-session-path"]').trigger("click");
    await wrapper.get('[data-testid="copy-session-id"]').trigger("click");

    expect(writeText).toHaveBeenNthCalledWith(1, "C:\\work\\project");
    expect(writeText).toHaveBeenNthCalledWith(2, "codex_session");
    expect(useUiStore().toasts.map((toast) => toast.message)).toEqual(["Path copied", "Session ID copied"]);
  });

  it("renders the Claude product mark", () => {
    const wrapper = mountHeader("claude");
    expect(wrapper.find('.cw-header-agent-mark svg[aria-label="Claude"]').exists()).toBe(true);
  });

  it("renders compact selects and sends their exact values", async () => {
    const request = vi.spyOn(mainSocket, "request").mockResolvedValue(undefined);
    const wrapper = mountHeader("claude", { model: "private-claude", permissionMode: "plan" });

    expect(wrapper.get('[data-testid="session-model"]').element.tagName).toBe("SELECT");
    expect(optionValues(wrapper, '[data-testid="session-model"]')).toEqual([
      "private-claude",
      "sonnet",
      "opus",
      "haiku"
    ]);
    expect(optionValues(wrapper, '[data-testid="session-permission"]')).toEqual([
      "auto",
      "acceptEdits",
      "manual",
      "dontAsk",
      "plan",
      "bypassPermissions"
    ]);
    expect(wrapper.find('[data-testid="session-effort"]').exists()).toBe(false);
    expect(wrapper.find(".cw-session-toolbar").text().toLowerCase()).not.toContain("default");

    await wrapper.get('[data-testid="session-model"]').setValue("opus");
    await wrapper.get('[data-testid="session-permission"]').setValue("bypassPermissions");

    expect(request).toHaveBeenCalledWith("set-model", { sessionId: "claude_session", model: "opus" });
    expect(request).toHaveBeenCalledWith("set-permission-mode", {
      sessionId: "claude_session",
      mode: "bypassPermissions"
    });
  });

  it("keeps goal content out of the toolbar and offers goal actions in overflow", async () => {
    const request = vi.spyOn(mainSocket, "request").mockImplementation(async (type) => {
      if (type === "codex-goal-get") return { goal: { objective: "Ship the release", status: "active" } };
      if (type === "codex-goal-clear") return { goal: null };
      return {};
    });
    const wrapper = mountHeader("codex", { status: { status: "running" } });
    await flushPromises();

    expect(wrapper.find(".cw-goal-chip").exists()).toBe(false);
    expect(wrapper.find(".cw-session-toolbar").text()).not.toContain("Ship the release");
    expect(wrapper.find(".cw-header-goal-indicator").exists()).toBe(false);
    expect(request).not.toHaveBeenCalledWith("codex-goal-get", expect.anything());
    expect(wrapper.get('button[aria-haspopup="menu"]').attributes("aria-label")).toBe("Session actions");
    expect(wrapper.get('[data-testid="session-stop"]').attributes("disabled")).toBeUndefined();

    await wrapper.get('button[aria-haspopup="menu"]').trigger("click");
    await flushPromises();
    const menu = wrapper.get('[role="menu"]');
    expect(menu.text()).toContain("Compact session");
    expect(menu.text()).toContain("Edit Codex goal");
    expect(menu.text()).toContain("Clear Codex goal");
    expect(wrapper.get(".cw-header-goal-indicator").attributes("aria-hidden")).toBe("true");
    expect(wrapper.get('button[aria-haspopup="menu"]').attributes("aria-label")).toContain("Codex goal set");

    const clear = menu.findAll("button").find((button) => button.text().includes("Clear Codex goal"));
    expect(clear).toBeDefined();
    await clear!.trigger("click");
    await flushPromises();

    expect(request).toHaveBeenCalledWith("codex-goal-clear", { sessionId: "codex_session" });
    expect(wrapper.find(".cw-header-goal-indicator").exists()).toBe(false);
  });

  it("moves owned-process kill into overflow and keeps a disabled square Stop while idle", async () => {
    vi.spyOn(mainSocket, "request").mockResolvedValue(undefined);
    const wrapper = mountHeader("claude", { status: { status: "exited", webuiAlive: true } });

    expect(wrapper.get('[data-testid="session-stop"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-testid="session-stop"]').classes()).toContain("cw-toolbar-stop");
    expect(wrapper.find(".cw-session-toolbar").text()).not.toContain("Kill");

    await wrapper.get('button[aria-haspopup="menu"]').trigger("click");
    expect(wrapper.get('[role="menu"]').text()).toContain("Kill owned process");
  });
});
