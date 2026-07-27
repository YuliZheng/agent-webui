import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sessionRow = readFileSync(
  join(process.cwd(), "src/components/SessionRow.vue"),
  "utf8",
);

describe("session-row new chat here", () => {
  it("creates an empty Codex draft and waits for the user's first message", () => {
    const handler = sessionRow.match(
      /function newChatHere\(\) \{([\s\S]*?)\n\}\nfunction toggleHide/,
    )?.[1];

    expect(handler).toBeTruthy();
    expect(handler).toContain('sessions.createPending(cwd, "codex")');
    expect(handler).toContain("ui.select(draftId)");
    expect(handler).not.toContain("newSession(");
    expect(handler).not.toMatch(/prompt:\s*["']hi["']/);
  });

  it("describes the action as an empty Codex chat", () => {
    expect(sessionRow).toContain("Create an empty Codex chat");
    expect(sessionRow).not.toContain("send hi");
  });
});
