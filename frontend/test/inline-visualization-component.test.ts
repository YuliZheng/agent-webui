import { createApp, nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import InlineVisualization from "../src/components/blocks/InlineVisualization.vue";

const mounted: Array<ReturnType<typeof createApp>> = [];
const browserSettings = (window as unknown as {
  happyDOM: { settings: { disableIframePageLoading: boolean } };
}).happyDOM.settings;

async function flushUi() {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.innerHTML = "";
  browserSettings.disableIframePageLoading = false;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mountVisualization() {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(InlineVisualization, {
    sessionId: "01a04539-0000-7000-8000-000000000000",
    file: "chart.html",
  });
  mounted.push(app);
  app.mount(host);
  return host;
}

describe("inline visualization loading", () => {
  it("shows a recoverable error instead of embedding a 404 response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })));
    const host = mountVisualization();
    await flushUi();

    expect(host.querySelector("iframe")).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("different conversation");
    expect(host.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
    expect(host.textContent).not.toContain("美观输出");
  });

  it("retries after a failure and mounts the sandbox only after a successful preflight", async () => {
    browserSettings.disableIframePageLoading = true;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const host = mountVisualization();
    await flushUi();

    const retry = Array.from(host.querySelectorAll("button"))
      .find(button => button.textContent?.trim() === "Retry");
    retry?.click();
    await flushUi();

    const frame = host.querySelector<HTMLIFrameElement>("iframe");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalled();
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame?.getAttribute("src")).toContain("/api/sessions/01a04539-0000-7000-8000-000000000000/visualization/chart.html");
  });
});
