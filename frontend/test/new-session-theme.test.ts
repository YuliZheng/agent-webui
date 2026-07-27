import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const modal = readFileSync(
  join(process.cwd(), "src/components/modals/NewSessionModal.vue"),
  "utf8",
);
const css = readFileSync(join(process.cwd(), "src/styles/tailwind.css"), "utf8");

describe("new-session agent switch theme", () => {
  it("uses semantic selected-state hooks instead of hard-coded light colors", () => {
    expect(modal).toContain("cw-agent-switch-option-selected");
    expect(modal).toContain(':aria-pressed="agent === \'claude\'"');
    expect(modal).toContain(':aria-pressed="agent === \'codex\'"');
    expect(modal).not.toMatch(/agent === '(?:claude|codex)' \? 'bg-white/);
  });

  it("derives every agent-switch state from theme tokens", () => {
    expect(css).toMatch(
      /\.cw-agent-switch-option-selected,[\s\S]*?background:\s*var\(--cw-accent\);[\s\S]*?color:\s*var\(--cw-accent-text\);/,
    );
    expect(css).toMatch(
      /\.cw-agent-switch-option:not\(\.cw-agent-switch-option-selected\):hover[\s\S]*?var\(--cw-accent\)[\s\S]*?var\(--cw-panel-2\)/,
    );
    expect(css).toMatch(
      /\.cw-agent-switch-option:focus-visible[\s\S]*?var\(--cw-focus-ring\)/,
    );
  });
});
