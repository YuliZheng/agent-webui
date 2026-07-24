<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import AgentBadge from "@/components/AgentBadge.vue";
import { LoaderCircle } from "@/components/icons";
import { mainSocket } from "@/api/ws";
import { usePreferencesStore } from "@/stores/preferences";
import type { AgentKind } from "@/types";

const props = withDefaults(defineProps<{
  initialCwd?: string;
  recentCwds?: string[];
}>(), {
  initialCwd: "",
  recentCwds: () => [],
});
const emit = defineEmits<{
  close: [];
  create: [data: { cwd: string; agent: AgentKind; prompt: string }];
}>();

const prefs = usePreferencesStore();
const cwd = ref(props.initialCwd);
const agent = ref<AgentKind>("claude");
const prompt = ref("");
const suggestions = ref<string[]>([]);
const completing = ref(false);
const scratch = ref(false);
const cwdInput = ref<HTMLInputElement | null>(null);
let completionTimer: ReturnType<typeof setTimeout> | undefined;
let completionSequence = 0;

const canCreate = computed(() => cwd.value.trim().length > 0);
const scratchAvailable = computed(() =>
  prefs.prefs.scratchSessionEnabled && prefs.prefs.scratchSessionPath.trim().length > 0,
);

watch(() => props.initialCwd, (value) => {
  cwd.value = value;
}, { immediate: true });

watch(cwd, (value) => {
  clearTimeout(completionTimer);
  const sequence = ++completionSequence;
  suggestions.value = [];
  if (!value.trim()) return;
  completionTimer = setTimeout(async () => {
    completing.value = true;
    try {
      const result = await mainSocket.request<{ paths: string[] }>("complete-path", { path: value }, 8_000);
      if (sequence === completionSequence) suggestions.value = result.paths.slice(0, 8);
    } catch {
      if (sequence === completionSequence) suggestions.value = [];
    } finally {
      if (sequence === completionSequence) completing.value = false;
    }
  }, 180);
});

watch(scratch, (enabled) => {
  if (enabled && scratchAvailable.value) cwd.value = prefs.prefs.scratchSessionPath;
});

onBeforeUnmount(() => clearTimeout(completionTimer));

function chooseCwd(path: string) {
  cwd.value = path;
  suggestions.value = [];
  void nextTick(() => cwdInput.value?.focus());
}

function submit(sendPrompt: boolean) {
  if (!canCreate.value) {
    cwdInput.value?.focus();
    return;
  }
  emit("create", {
    cwd: cwd.value.trim(),
    agent: agent.value,
    prompt: sendPrompt ? prompt.value : "",
  });
}
</script>

<template>
  <Teleport to="body">
    <div class="cw-modal-scrim cw-modal-overlay" @click.self="emit('close')">
      <form class="cw-modal cw-modal-card cw-new-session-modal" @submit.prevent="submit(true)">
        <header class="cw-new-session-header">
          <div>
            <h2>New session</h2>
            <p>Choose an agent and working directory.</p>
          </div>
          <button type="button" aria-label="Close new session" @click="emit('close')">×</button>
        </header>

        <fieldset class="cw-agent-segment" aria-label="Agent">
          <button type="button" :class="{ selected: agent === 'claude' }" @click="agent = 'claude'">
            <AgentBadge agent="claude" :size="24" />
            <span><strong>Claude Code</strong><small>Claude CLI session</small></span>
          </button>
          <button type="button" :class="{ selected: agent === 'codex' }" @click="agent = 'codex'">
            <AgentBadge agent="codex" :size="24" />
            <span><strong>Codex</strong><small>Codex app-server thread</small></span>
          </button>
        </fieldset>

        <label class="cw-new-session-cwd">
          <span>Working directory</span>
          <span class="cw-path-input-wrap">
            <input
              ref="cwdInput"
              v-model="cwd"
              required
              autocomplete="off"
              spellcheck="false"
              placeholder="~/projects/my-app"
            />
            <LoaderCircle v-if="completing" class="cw-spin" :size="14" />
          </span>
        </label>

        <div v-if="suggestions.length" class="cw-path-suggestions" role="listbox" aria-label="Directory suggestions">
          <button v-for="path in suggestions" :key="path" type="button" role="option" @click="chooseCwd(path)">
            {{ path }}
          </button>
        </div>

        <div v-if="recentCwds.length" class="cw-recent-cwds">
          <span>Recent</span>
          <button v-for="path in recentCwds" :key="path" type="button" :title="path" @click="chooseCwd(path)">
            {{ path }}
          </button>
        </div>

        <label v-if="scratchAvailable" class="cw-settings-check cw-new-session-scratch">
          <input v-model="scratch" type="checkbox" />
          <span>Use scratch directory</span>
        </label>

        <label>
          First prompt <small>(optional)</small>
          <textarea v-model="prompt" rows="4" placeholder="What should the agent work on?" />
        </label>

        <div class="cw-modal-actions">
          <button type="button" @click="emit('close')">Cancel</button>
          <button type="button" :disabled="!canCreate" @click="submit(false)">Create</button>
          <button class="primary" :disabled="!canCreate || !prompt.trim()">Create + send</button>
        </div>
      </form>
    </div>
  </Teleport>
</template>
