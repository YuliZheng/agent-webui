import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPwaInstallController,
  type BeforeInstallPromptEvent,
} from "../src/util/pwa-install.js";

function installPromptEvent(
  outcome: BeforeInstallPromptEvent["userChoice"],
) {
  return Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
    prompt: vi.fn().mockResolvedValue(undefined),
    userChoice: outcome,
  }) as BeforeInstallPromptEvent;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PWA install state", () => {
  it("captures the deferred prompt and enters the indeterminate install wait", async () => {
    vi.useFakeTimers();
    const target = new EventTarget();
    let resolveChoice!: (choice: { outcome: "accepted"; platform: string }) => void;
    const choice = new Promise<{ outcome: "accepted"; platform: string }>((resolve) => {
      resolveChoice = resolve;
    });
    const event = installPromptEvent(choice);
    const controller = createPwaInstallController({ target });

    controller.init();
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(controller.status.value).toBe("ready");

    const pending = controller.requestInstall();
    expect(event.prompt).toHaveBeenCalledOnce();
    expect(controller.status.value).toBe("prompting");

    resolveChoice({ outcome: "accepted", platform: "web" });
    await pending;
    expect(controller.status.value).toBe("installing");
    await vi.advanceTimersByTimeAsync(59_999);
    expect(controller.status.value).toBe("installing");
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.status.value).toBe("stalled");
    controller.dispose();
  });

  it("marks installation complete and cancels the stall transition", async () => {
    vi.useFakeTimers();
    const target = new EventTarget();
    const event = installPromptEvent(Promise.resolve({
      outcome: "accepted",
      platform: "web",
    }));
    const controller = createPwaInstallController({ target });

    controller.init();
    target.dispatchEvent(event);
    await controller.requestInstall();
    target.dispatchEvent(new Event("appinstalled"));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(controller.status.value).toBe("installed");
    controller.dispose();
  });

  it("reports a dismissed browser prompt without showing an install wait", async () => {
    const target = new EventTarget();
    const event = installPromptEvent(Promise.resolve({
      outcome: "dismissed",
      platform: "web",
    }));
    const controller = createPwaInstallController({ target });

    controller.init();
    target.dispatchEvent(event);
    await controller.requestInstall();

    expect(controller.status.value).toBe("dismissed");
    controller.dispose();
  });

  it("initializes before mount and presents the Settings install guidance", () => {
    const root = process.cwd();
    const main = readFileSync(join(root, "src/main.ts"), "utf8");
    const settings = readFileSync(
      join(root, "src/components/modals/SettingsModal.vue"),
      "utf8",
    );

    expect(main.indexOf("initPwaInstall();")).toBeLessThan(
      main.indexOf('mount("#app")'),
    );
    expect(settings.indexOf("App installation")).toBeGreaterThan(
      settings.indexOf("Appearance"),
    );
    expect(settings).not.toContain("Enable notifications");
    expect(settings).toContain(
      "WebAPK generation requires Google WebAPK/Play services and network access",
    );
    expect(settings).not.toContain("Tailscale address may block");
    expect(settings).toContain('role="progressbar"');
    expect(settings).not.toContain("aria-valuenow");
  });
});
