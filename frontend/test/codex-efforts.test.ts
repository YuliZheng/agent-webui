import { describe, expect, it } from "vitest";
import {
  CODEX_REASONING_EFFORTS,
  resolveCodexEffortChoices,
} from "../src/util/codex-efforts.js";

describe("Codex reasoning effort choices", () => {
  it("keeps ultra as the highest compatibility effort", () => {
    expect(CODEX_REASONING_EFFORTS).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
  });

  it("uses the selected model's reported levels when available", () => {
    expect(resolveCodexEffortChoices([
      { value: "low" },
      { value: "medium" },
      { value: "high" },
      { value: "xhigh" },
      { value: "max" },
    ])).toEqual(["low", "medium", "high", "xhigh", "max"]);

    expect(resolveCodexEffortChoices([
      { value: "low" },
      { value: "ultra" },
    ])).toEqual(["low", "ultra"]);
  });
});
