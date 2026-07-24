import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import SettingsDialog from "@/components/SettingsDialog.vue";
import { mainSocket } from "@/api/ws";
import { usePreferencesStore } from "@/stores/preferences";
import { fallbackAgentCapabilities } from "@/util/session-controls";

function mountDialog() {
  const pinia = createPinia();
  setActivePinia(pinia);
  return mount(SettingsDialog, {
    global: {
      plugins: [pinia],
      stubs: { Teleport: true }
    }
  });
}

function setControlValue(wrapper: ReturnType<typeof mountDialog>, selector: string, value: string | boolean) {
  const element = wrapper.get(selector).element as HTMLInputElement | HTMLSelectElement;
  if (typeof value === "boolean") {
    (element as HTMLInputElement).checked = value;
  } else {
    element.value = value;
  }
  const eventType = element instanceof HTMLSelectElement || element.type === "checkbox" ? "change" : "input";
  element.dispatchEvent(new Event(eventType, { bubbles: true }));
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("settings dialog", () => {
  it("saves auto-title, agent defaults, and scratch settings together", async () => {
    const request = vi.spyOn(mainSocket, "request").mockImplementation(async (type, args) => {
      if (type === "get-agent-capabilities") {
        const agent = (args as { agent: "claude" | "codex" }).agent;
        return fallbackAgentCapabilities(agent);
      }
      return undefined;
    });
    const wrapper = mountDialog();
    await flushPromises();

    expect(wrapper.text()).not.toContain("CLI default");
    expect(wrapper.text()).not.toContain("App-server default");
    expect(wrapper.get('[data-testid="default-claude-model"]').find('option[value=""]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="default-codex-model"]').find('option[value=""]').exists()).toBe(false);

    setControlValue(wrapper, '[data-testid="auto-title-frequency"]', "12");
    setControlValue(wrapper, '[data-testid="auto-title-language"]', "中文");
    setControlValue(wrapper, '[data-testid="default-claude-model"]', "sonnet");
    setControlValue(wrapper, '[data-testid="default-claude-effort"]', "high");
    setControlValue(wrapper, '[data-testid="default-claude-permission"]', "plan");
    setControlValue(wrapper, '[data-testid="default-codex-model"]', "gpt-5.6-terra");
    setControlValue(wrapper, '[data-testid="default-codex-effort"]', "xhigh");
    setControlValue(wrapper, '[data-testid="default-codex-approval"]', "on-request");
    setControlValue(wrapper, '[data-testid="default-codex-sandbox"]', "workspace-write");
    setControlValue(wrapper, '[data-testid="scratch-enabled"]', true);
    setControlValue(wrapper, '[data-testid="scratch-path"]', "~/scratch");
    setControlValue(wrapper, '[data-testid="thinking-trigger-enabled"]', false);
    await flushPromises();
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    const saveCall = request.mock.calls.find(([type]) => type === "put-prefs");
    expect(saveCall).toBeDefined();
    const [type, args] = saveCall!;
    expect(type).toBe("put-prefs");
    expect((args as { prefs: Record<string, unknown> }).prefs).toMatchObject({
      autoTitleEnabled: true,
      autoTitleFrequency: 12,
      autoTitleLanguage: "中文",
      defaultClaudeModel: "sonnet",
      defaultClaudeEffort: "high",
      defaultClaudePermissionMode: "plan",
      defaultCodexModel: "gpt-5.6-terra",
      defaultCodexEffort: "xhigh",
      defaultCodexApprovalPreset: "on-request",
      defaultCodexSandboxMode: "workspace-write",
      scratchSessionEnabled: true,
      scratchSessionPath: "~/scratch",
      thinkingTrigger: ""
    });
    expect(usePreferencesStore().prefs.defaultCodexModel).toBe("gpt-5.6-terra");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("keeps live preferences unchanged when cancelled", async () => {
    const request = vi.spyOn(mainSocket, "request").mockResolvedValue(undefined);
    const wrapper = mountDialog();
    await flushPromises();
    const store = usePreferencesStore();
    expect(store.prefs.messageDisplayStyle).toBe("claude-code");

    await wrapper.get('[data-testid="display-style"]').setValue("wechat");
    await wrapper.get('button[type="button"]:last-child').trigger("click");

    expect(store.prefs.messageDisplayStyle).toBe("claude-code");
    expect(request).not.toHaveBeenCalledWith("put-prefs", expect.anything());
  });

  it("does not publish a failed settings save into the live store", async () => {
    vi.spyOn(mainSocket, "request").mockRejectedValue(new Error("offline"));
    const wrapper = mountDialog();
    await flushPromises();
    const store = usePreferencesStore();

    await wrapper.get('[data-testid="default-claude-model"]').setValue("opus");
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(store.prefs.defaultClaudeModel).toBe("");
    expect(wrapper.get('[role="alert"]').text()).toContain("offline");
    expect(wrapper.emitted("close")).toBeUndefined();
  });
});
