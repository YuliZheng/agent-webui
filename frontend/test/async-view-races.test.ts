import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("async view race guards", () => {
  it("ignores a Codex usage response after the status sheet changes session", () => {
    const statusPage = source("src/components/SessionStatusPage.vue");

    expect(statusPage).toContain("let usageLoadSeq = 0");
    expect(statusPage).toContain("const seq = ++usageLoadSeq");
    expect(statusPage).toContain("function usageRequestCurrent(seq: number, id: string)");
    expect(statusPage).toContain("seq === usageLoadSeq && props.open && props.sessionId === id");
    expect(statusPage).toMatch(
      /readFullCodexContextUsage[\s\S]*if \(!usageRequestCurrent\(seq, id\)\) return;[\s\S]*fullCodexUsage\.value = full/,
    );
    expect(statusPage).toMatch(
      /readSessionRange[\s\S]*if \(!usageRequestCurrent\(seq, id\)\) return;[\s\S]*usageOlderLines\.value = response\.lines/,
    );
    expect(statusPage).toContain("if (usageRequestCurrent(seq, id)) usageBackfillLoading.value = false");
  });

  it("rechecks a changed preview path and ignores an older HEAD response", () => {
    const preview = source("src/components/PreviewOverlay.vue");

    expect(preview).toContain("let staleCheckToken = 0");
    expect(preview).toContain("function staleCheckCurrent(token: number, sessionId: string | null, path: string)");
    expect(preview).toContain("modal.sessionId === sessionId");
    expect(preview).toContain("modal.path === path");
    expect(preview).toContain("watch([active, () => modal.path]");
    expect(preview).toMatch(
      /const path = modal\.path;[\s\S]*fetch\(path, \{ method: "HEAD" \}\)[\s\S]*if \(!staleCheckCurrent\(token, sessionId, path\)\) return;[\s\S]*stale\.value = r\.status === 404/,
    );
  });
});
