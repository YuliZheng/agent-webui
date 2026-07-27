<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useSessionsStore } from "../../stores/sessions.js";
import { useUiStore } from "../../stores/ui.js";
import { usePrefsStore } from "../../stores/prefs.js";
import { newSession, normalizeCwd, completePath, HttpError } from "../../api/sessions.js";
import { getSessionSkills } from "../../api/skills.js";
import { HIDDEN_CLI_COMMANDS } from "../../util/local-commands.js";
import { displayCwd } from "../../util/cwd-display.js";
import AgentBadge from "../AgentBadge.vue";

const emit = defineEmits<{ (e: "close"): void }>();
const sessions = useSessionsStore();
const ui = useUiStore();
const prefs = usePrefsStore();

const cwd = ref("");
const prompt = ref("");
const agent = ref<"claude" | "codex">("codex");
const adHoc = ref(false);
const inflight = ref(false);
const cwdError = ref<string | null>(null);
const generalError = ref<string | null>(null);
let retryFingerprint = "";
let retryClientUuid = "";

function createClientUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Keep the idempotency key stable when the transport outcome is unknown and
// the user retries the same request. A materially different payload gets a
// fresh key so it can create a genuinely new session.
function clientUuidFor(cwdResolved: string, promptText: string, selectedAgent: "claude" | "codex"): string {
  const fingerprint = JSON.stringify([cwdResolved, promptText, selectedAgent]);
  if (!retryClientUuid || retryFingerprint !== fingerprint) {
    retryFingerprint = fingerprint;
    retryClientUuid = createClientUuid();
  }
  return retryClientUuid;
}

function clearRetryClientUuid() {
  retryFingerprint = "";
  retryClientUuid = "";
}

// Parent keeps its trailing slash so the leaf reads naturally; the parent
// gets middle-truncated in the UI while the leaf is always shown in full.
interface CwdSuggestion {
  raw: string;
  input: string;
  parent: string;
  leaf: string;
}

function splitPath(input: string) {
  const idx = input.lastIndexOf("/");
  return {
    parent: idx > 0 ? input.slice(0, idx + 1) : "",
    leaf: idx >= 0 ? input.slice(idx + 1) : input,
  };
}

function recentSuggestion(raw: string): CwdSuggestion {
  const input = displayCwd(raw, ui.home);
  return { raw, input, ...splitPath(input) };
}

function pathSuggestion(raw: string): CwdSuggestion {
  return { raw, input: raw, ...splitPath(raw) };
}

function selectSuggestion(s: CwdSuggestion) {
  cwd.value = s.input;
}

function isSelectedSuggestion(s: CwdSuggestion): boolean {
  const current = cwd.value.trim();
  return current === s.input || current === s.raw;
}

const recents = computed(() =>
  Array.from(new Set(sessions.list.map((s) => s.cwd).filter(Boolean)))
    .slice(0, 8)
    .map(recentSuggestion),
);

// Live filesystem completions for whatever the user is currently typing.
// Debounced; a sequence guard drops out-of-order responses.
const completions = ref<string[]>([]);
let completeSeq = 0;
let completeTimer: ReturnType<typeof setTimeout> | undefined;
watch(cwd, (val) => {
  const v = val.trim();
  if (!v.includes("/")) {
    completeSeq++;
    clearTimeout(completeTimer);
    completions.value = [];
    return;
  }
  const seq = ++completeSeq;
  clearTimeout(completeTimer);
  completeTimer = setTimeout(async () => {
    try {
      const paths = await completePath(v);
      if (seq === completeSeq) completions.value = paths;
    } catch {
      if (seq === completeSeq) completions.value = [];
    }
  }, 120);
});

// What the picker shows: empty field → recents; typing a path (has "/") →
// live fs completions; typing a bare word → recents filtered by substring.
const suggestions = computed(() => {
  const v = cwd.value.trim();
  if (!v) return recents.value;
  if (v.includes("/")) return completions.value.map(pathSuggestion);
  const q = v.toLowerCase();
  return recents.value.filter((r) => (r.parent + r.leaf).toLowerCase().includes(q));
});

// Scratch cwd: user-overridable via prefs.scratchDir. When null, fall back
// to `/tmp/${user}-scratch` derived from home (e.g. /home/alice →
// /tmp/alice-scratch). The backend auto-mkdirs any /tmp/ path; other
// paths must already exist.
const scratchCwd = computed<string>(() => {
  const override = prefs.scratchDir?.trim();
  if (override) return override;
  const home = ui.home || "";
  const m = home.match(/\/([^/]+)\/?$/);
  const user = m?.[1] ?? "claude-webui";
  return `/tmp/${user}-scratch`;
});

const effectiveCwd = computed(() => (adHoc.value ? scratchCwd.value : cwd.value));

async function submit() {
  // Re-entry guard. `inflight` used to be set only AFTER `await normalizeCwd`,
  // so from the click until that round-trip returned the button stayed live —
  // rapid clicks each passed the guard and spawned a SEPARATE session. Lock
  // synchronously, before any await, so the first click owns the submit and
  // every later click is a no-op until it resolves.
  if (inflight.value) return;
  cwdError.value = null;
  generalError.value = null;
  const rawCwd = effectiveCwd.value.trim();
  if (!rawCwd) return;
  inflight.value = true;
  try {
    // Canonicalize first (expand ~, resolve symlinks) so a hand-typed "~/aksrc"
    // becomes the same fully-resolved path the watcher will report for the
    // spawned session. Otherwise the draft↔real reconciliation in live.ts (which
    // matches on cwd equality) fails → duplicate row + "opened elsewhere". Fall
    // back to the raw input if the backend round-trip fails.
    let cwdResolved = rawCwd;
    try { cwdResolved = await normalizeCwd(rawCwd); } catch { /* keep raw */ }
    // Empty prompt → create a pending draft in the sidebar; user can type the
    // first message in the regular composer and the spawn happens then.
    if (!prompt.value.trim()) {
      const draftId = sessions.createPending(cwdResolved, agent.value);
      ui.select(draftId);
      emit("close");
      return;
    }
    const slashCommands = prompt.value.startsWith("/")
      ? (await getSessionSkills("new-session", { cwd: cwdResolved, agent: agent.value }))
          .map((s) => s.name)
          .filter((n) => !HIDDEN_CLI_COMMANDS.has(n.toLowerCase()))
      : [];
    const clientUuid = clientUuidFor(cwdResolved, prompt.value, agent.value);
    await newSession({
      cwd: cwdResolved,
      prompt: prompt.value,
      clientUuid,
      agent: agent.value,
      ...(slashCommands.length ? { slashCommands } : {}),
    });
    clearRetryClientUuid();
    emit("close");
  } catch (err) {
    if (err instanceof HttpError && err.code === 400) cwdError.value = err.message || "invalid cwd";
    else generalError.value = (err as Error).message;
  } finally {
    inflight.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="cw-modal-overlay fixed inset-0 z-40 bg-black/40 flex items-center justify-center" @click.self="emit('close')">
      <div class="cw-modal-card bg-[var(--cw-panel-bg)] rounded-lg p-5 w-[480px] max-w-[95vw]">
        <header class="flex items-center justify-between mb-3">
          <h2 class="font-semibold">New session</h2>
          <button @click="emit('close')" class="opacity-60 hover:opacity-100">✕</button>
        </header>

        <div
          class="cw-agent-switch inline-grid grid-cols-2 gap-0.5 rounded-lg border p-0.5 text-sm mb-3"
          role="group"
          aria-label="Session agent"
        >
          <button
            type="button"
            @click="agent = 'codex'"
            :class="['cw-agent-switch-option h-8 rounded-md px-3 transition-colors focus:outline-none', { 'cw-agent-switch-option-selected': agent === 'codex' }]"
            :aria-pressed="agent === 'codex'"
          >
            <AgentBadge agent="codex" :size="18" label />
          </button>
          <button
            type="button"
            @click="agent = 'claude'"
            :class="['cw-agent-switch-option h-8 rounded-md px-3 transition-colors focus:outline-none', { 'cw-agent-switch-option-selected': agent === 'claude' }]"
            :aria-pressed="agent === 'claude'"
          >
            <AgentBadge agent="claude" :size="18" label />
          </button>
        </div>

        <label v-if="prefs.scratchEnabled" class="flex items-center gap-2 text-sm mb-3 select-none">
          <input type="checkbox" v-model="adHoc" />
          <span>
            Ad-hoc / scratch — no project, work in
            <code class="text-[11px] opacity-80">{{ scratchCwd }}</code>
          </span>
        </label>

        <template v-if="!adHoc">
          <label class="block text-xs uppercase tracking-wider opacity-70 mb-1">cwd</label>
          <input
            v-model="cwd"
            placeholder="~/aksrc/master/k2"
            class="w-full mb-1 rounded border border-[var(--cw-border)]  bg-transparent px-2 py-1 text-sm font-mono"
          />
          <!-- Tappable path picker (datalist has no usable mobile dropdown).
               Live fs completions while typing a path, recents otherwise.
               Parent dir is dimmed + middle-truncated; the leaf folder stays
               fully visible since that's the part that disambiguates paths. -->
          <div
            v-if="suggestions.length"
            class="mb-1 max-h-44 overflow-auto rounded-lg border border-[var(--cw-border)] divide-y divide-[var(--cw-border)]"
          >
            <button
              v-for="r in suggestions"
              :key="r.raw + '\n' + r.input"
              type="button"
              @click="selectSuggestion(r)"
              :title="r.raw"
              :class="['group flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors', isSelectedSuggestion(r) ? 'bg-[color-mix(in_srgb,var(--cw-accent)_10%,transparent)] text-[var(--cw-accent)]' : 'hover:bg-[var(--cw-panel-2)]']"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="h-4 w-4 shrink-0 opacity-50">
                <path stroke-linecap="round" stroke-linejoin="round" d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
              </svg>
              <span class="flex min-w-0 flex-1 items-baseline font-mono">
                <span class="truncate opacity-50">{{ r.parent }}</span>
                <span class="shrink-0 font-medium">{{ r.leaf }}</span>
              </span>
              <svg v-if="isSelectedSuggestion(r)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" class="h-3.5 w-3.5 shrink-0">
                <path stroke-linecap="round" stroke-linejoin="round" d="m5 13 4 4L19 7" />
              </svg>
            </button>
          </div>
          <div v-if="cwdError" class="text-xs text-[var(--cw-danger)] mb-2">{{ cwdError }}</div>
        </template>

        <label class="block text-xs uppercase tracking-wider opacity-70 mt-3 mb-1">Prompt</label>
        <textarea v-model="prompt" rows="5" class="w-full rounded border border-[var(--cw-border)]  bg-transparent px-2 py-1 text-sm" />
        <div v-if="generalError" class="text-xs text-[var(--cw-danger)] mt-2">{{ generalError }}</div>
        <div class="flex justify-end gap-2 mt-4">
          <button @click="emit('close')" class="px-3 py-1 rounded border">Cancel</button>
          <button
            @click="submit"
            :disabled="!effectiveCwd.trim() || inflight"
            class="cw-modal-primary px-3 py-1 rounded bg-[var(--cw-accent)] text-[var(--cw-accent-text)] disabled:opacity-50"
            :title="prompt.trim() ? 'Spawn now with this prompt' : 'Open an empty session — type the first message in the composer'"
          >
            {{ inflight ? "Creating…" : (prompt.trim() ? "Create + send" : "Create") }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
