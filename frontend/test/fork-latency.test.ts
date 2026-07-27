import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "src/components/blocks/UserPromptBlock.vue"),
  "utf8",
);

describe("fork navigation latency", () => {
  it("navigates before reconciling the complete session list", () => {
    const start = source.indexOf("async function fork()");
    const end = source.indexOf("\nasync function ", start + 1);
    const block = source.slice(start, end < 0 ? undefined : end);

    expect(block).not.toContain("await sessions.fetchAll()");
    expect(block).toContain("sessions.addOrTouch({");
    expect(block.indexOf("ui.select(r.newSessionId)")).toBeGreaterThan(-1);
    expect(block.indexOf("void sessions.fetchAll()")).toBeGreaterThan(
      block.indexOf("ui.select(r.newSessionId)"),
    );
  });
});
