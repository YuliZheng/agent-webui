import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("mobile home startup", () => {
  const app = readFileSync(join(process.cwd(), "src/App.vue"), "utf8");

  it("defers the heavy conversation pane until it is visible", () => {
    expect(app).toContain('defineAsyncComponent(() => import("./components/MainPane.vue"))');
    expect(app).not.toContain('import MainPane from "./components/MainPane.vue"');
    expect(app).toContain("desktopViewport.value || Boolean(ui.selectedSessionId)");
    expect(app).toMatch(/<MainPane\s+v-if="shouldMountMainPane"/);
  });

  it("reacts when the viewport crosses the desktop breakpoint", () => {
    expect(app).toContain('window.matchMedia("(min-width: 768px)")');
    expect(app).toContain('addEventListener?.("change", syncDesktopViewport)');
    expect(app).toContain('removeEventListener?.("change", syncDesktopViewport)');
  });
});
