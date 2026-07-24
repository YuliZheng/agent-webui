import { describe, expect, it } from "vitest";
import { resolveCodexExecutable } from "../src/util/executable.js";

describe("executable resolution", () => {
  it("never asks Windows to execute a command shim through a shell", async () => {
    if (process.platform !== "win32") return;
    await expect(resolveCodexExecutable("codex.cmd")).rejects.toThrowError(/native codex\.exe/);
    await expect(resolveCodexExecutable()).resolves.toMatch(/codex\.exe$/i);
  });
});
