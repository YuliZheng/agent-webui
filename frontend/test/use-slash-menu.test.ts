import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { ref, nextTick } from "vue";

vi.mock("../src/api/skills.js", () => ({
  getSessionSkills: vi.fn(async () => [
    { name: "brainstorming", description: "x" },
    { name: "build", description: "y" },
  ]),
}));

import { useSlashMenu } from "../src/composables/useSlashMenu.js";
import { useSessionsStore } from "../src/stores/sessions.js";

describe("useSlashMenu", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("opens with filtered items when text has a slash token", async () => {
    const text = ref("/bra");
    const caret = ref(4);
    const sessionId = ref("s1");
    const m = useSlashMenu({ text, caret, sessionId });
    await m.refresh();
    await nextTick();
    expect(m.open.value).toBe(true);
    expect(m.items.value.map((s) => s.name)).toEqual(["brainstorming"]);
  });

  it("is closed for a path-like token", async () => {
    const text = ref("/home/sys");
    const caret = ref(9);
    const sessionId = ref("s1");
    const m = useSlashMenu({ text, caret, sessionId });
    await m.refresh();
    expect(m.open.value).toBe(false);
  });

  it("stays closed right after a paste until re-evaluated by typing", async () => {
    const text = ref("/bra");
    const caret = ref(4);
    const sessionId = ref("s1");
    const m = useSlashMenu({ text, caret, sessionId });
    m.notePaste();
    await m.refresh();
    expect(m.open.value).toBe(false);
    // simulate a keystroke clearing the suppression
    m.noteInput();
    await m.refresh();
    await nextTick();
    expect(m.open.value).toBe(true);
  });

  it("stays closed across refreshes after paste until a real keystroke (noteInput)", async () => {
    const text = ref("/bra");
    const caret = ref(4);
    const sessionId = ref("s1");
    const m = useSlashMenu({ text, caret, sessionId });
    m.notePaste();
    await m.refresh();      // simulates the input event after paste
    expect(m.open.value).toBe(false);
    await m.refresh();      // simulates a follow-up keyup event
    expect(m.open.value).toBe(false);
    m.noteInput();          // simulates a genuine character keydown
    await m.refresh();
    await nextTick();
    expect(m.open.value).toBe(true);
  });

  it("accept() returns the replacement text and caret", async () => {
    const text = ref("do /bra");
    const caret = ref(7);
    const sessionId = ref("s1");
    const m = useSlashMenu({ text, caret, sessionId });
    await m.refresh();
    await nextTick();
    const res = m.accept();
    expect(res).toEqual({ text: "do /brainstorming ", caret: "do /brainstorming ".length });
  });

  it("shows codex-only local slash commands for codex sessions", async () => {
    const sessions = useSessionsStore();
    sessions.byId.s1 = { id: "s1", cwd: "/x", mtime: "", size: 0, title: null, parentSessionId: null, agent: "codex" };
    const text = ref("/go");
    const caret = ref(3);
    const sessionId = ref("s1");
    const m = useSlashMenu({ text, caret, sessionId });
    await m.refresh();
    await nextTick();
    expect(m.items.value.map((s) => s.name)).toEqual(["goal"]);
  });
});
