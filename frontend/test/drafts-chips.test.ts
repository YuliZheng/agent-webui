import { beforeEach, describe, expect, it } from "vitest";
import { DraftRepository, PromptChipRepository } from "@/persist/drafts";

beforeEach(() => localStorage.clear());
describe("drafts and prompt chips", () => {
  it("clearIfMatches preserves edits made during a slow request", () => {
    const drafts = new DraftRepository(); drafts.set("s", "sent"); drafts.set("s", "sent plus new edit");
    expect(drafts.clearIfMatches("s", "sent")).toBe(false); expect(drafts.get("s")).toBe("sent plus new edit");
    expect(drafts.clearIfMatches("s", "sent plus new edit")).toBe(true);
  });
  it("reconciles oldest-first exact matches after the start line", () => {
    const chips = new PromptChipRepository();
    const first = chips.add("s", { text: "hello", imageCount: 0, startLine: 5, agent: "claude", state: "queued", steered: false });
    chips.add("s", { text: "hello", imageCount: 0, startLine: 7, agent: "claude", state: "queued", steered: false });
    expect(chips.reconcile("s", "hello", 8)?.id).toBe(first.id); expect(chips.list("s")).toHaveLength(1);
  });
  it("keeps Codex steers until a matching landing record", () => {
    const chips = new PromptChipRepository(); chips.add("c", { text: "change direction", imageCount: 0, startLine: 9, agent: "codex", state: "steered", steered: true });
    expect(chips.reconcile("c", "unrelated", 10)).toBeUndefined(); expect(chips.list("c")).toHaveLength(1);
  });
  it("reconciles all joined interrupted Codex steers oldest first", () => {
    const chips = new PromptChipRepository();
    const first = chips.add("c", { text: "change the API contract", imageCount: 0, startLine: 9, agent: "codex", state: "steered", steered: true });
    const second = chips.add("c", { text: "and update the frontend tests", imageCount: 0, startLine: 9, agent: "codex", state: "steered", steered: true });
    expect(chips.reconcileMatches("c", `${first.text}\n\n${second.text}`, 10).map((item) => item.id)).toEqual([first.id, second.id]);
    expect(chips.list("c")).toEqual([]);
  });
  it("settles only the named Codex steered chips", () => {
    const chips = new PromptChipRepository();
    const settled = chips.add("c", { text: "steer", imageCount: 0, startLine: 9, agent: "codex", state: "steered", steered: true });
    const normal = chips.add("c", { text: "normal", imageCount: 0, startLine: 9, agent: "codex", state: "sending", steered: false });
    const other = chips.add("c", { text: "other", imageCount: 0, startLine: 9, agent: "codex", state: "steered", steered: true });

    expect(chips.settleCodexSteers("c", [settled.id, normal.id]).map((item) => item.id)).toEqual([settled.id]);
    expect(chips.list("c").map((item) => item.id)).toEqual([normal.id, other.id]);
  });
});
