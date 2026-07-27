import { computed, ref, type Ref } from "vue";
import type { SkillEntry } from "@claude-webui/shared/api";
import { findSlashToken } from "../util/slash-token.js";
import { filterSkills } from "../util/skill-filter.js";
import { useSessionSkillsStore } from "../stores/session-skills.js";
import { useSessionsStore } from "../stores/sessions.js";
import { HIDDEN_CLI_COMMANDS, localCommandEntries } from "../util/local-commands.js";

interface Args {
  text: Ref<string>;
  caret: Ref<number>;
  sessionId: Ref<string>;
}

export interface AcceptResult {
  text: string;
  caret: number;
}

export function useSlashMenu({ text, caret, sessionId }: Args) {
  const store = useSessionSkillsStore();
  const sessions = useSessionsStore();
  const activeIndex = ref(0);
  const suppressed = ref(false);
  // Bumped by refresh() so token/items recompute on demand (caret isn't
  // reactive through the DOM; the caller drives refresh on input/keyup/click).
  const tick = ref(0);

  const token = computed(() => {
    void tick.value;
    if (suppressed.value) return null;
    return findSlashToken(text.value, caret.value);
  });

  const items = computed<SkillEntry[]>(() => {
    void tick.value;
    const t = token.value;
    if (!t) return [];
    // Local webui commands lead the list; drop any backend entry that collides
    // on name so they aren't duplicated.
    const isCodex = sessions.byId[sessionId.value]?.agent === "codex";
    const locals = localCommandEntries(isCodex);
    const localNames = new Set(locals.map((e) => e.name));
    const merged = [
      ...locals,
      ...store
        .list(sessionId.value)
        .filter((e) => !localNames.has(e.name) && !HIDDEN_CLI_COMMANDS.has(e.name.toLowerCase())),
    ];
    return filterSkills(merged, t.query);
  });

  const open = computed(() => token.value !== null && items.value.length > 0);

  // Pull the list for this session (no-op if already cached), then recompute.
  async function refresh(): Promise<void> {
    if (token.value) {
      const s = sessions.byId[sessionId.value];
      await store.ensureLoaded(sessionId.value, {
        ...(s?.cwd ? { cwd: s.cwd } : {}),
        ...(s?.agent ? { agent: s.agent } : {}),
      });
    }
    tick.value++;
    if (activeIndex.value >= items.value.length) activeIndex.value = 0;
  }

  function moveDown(): void {
    if (items.value.length === 0) return;
    activeIndex.value = (activeIndex.value + 1) % items.value.length;
  }
  function moveUp(): void {
    if (items.value.length === 0) return;
    activeIndex.value = (activeIndex.value - 1 + items.value.length) % items.value.length;
  }
  function setActive(i: number): void {
    activeIndex.value = i;
  }
  function close(): void {
    suppressed.value = true;
    tick.value++;
  }
  function notePaste(): void {
    suppressed.value = true;
  }
  function noteInput(): void {
    suppressed.value = false;
  }

  // Compute the text + caret after inserting "/<name> " over the active token.
  // Returns null if there is nothing to accept. Does NOT mutate the input refs;
  // the caller writes the result to the drafts store + textarea.
  function accept(index = activeIndex.value): AcceptResult | null {
    const t = token.value;
    const chosen = items.value[index];
    if (!t || !chosen) return null;
    const before = text.value.slice(0, t.start);
    const after = text.value.slice(caret.value);
    const insert = `/${chosen.name} `;
    return { text: before + insert + after, caret: before.length + insert.length };
  }

  return {
    open,
    items,
    activeIndex: computed(() => activeIndex.value),
    refresh,
    moveDown,
    moveUp,
    setActive,
    close,
    notePaste,
    noteInput,
    accept,
  };
}
