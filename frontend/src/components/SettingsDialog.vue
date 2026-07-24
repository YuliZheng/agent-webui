<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { LoaderCircle } from "@/components/icons";
import { THEME_OPTIONS, normalizePrefs, usePreferencesStore } from "@/stores/preferences";
import { mainSocket } from "@/api/ws";
import type { AgentCapabilities, AgentKind, PrefsBlob } from "@/types";
import {
  effectiveEffortValue,
  effectiveModelValue,
  effectivePermissionValue,
  effectiveSandboxValue,
  effortControlOptions,
  fallbackAgentCapabilities,
  isCodexYolo,
  modelControlOptions,
  permissionControlOptions,
  sandboxControlOptions
} from "@/util/session-controls";

const emit = defineEmits<{ close: [] }>();
const store = usePreferencesStore();
const draft = reactive<PrefsBlob>(normalizePrefs({ ...store.prefs }));
const saving = ref(false);
const saveError = ref("");
const capabilitiesLoading = ref(true);
const claudeCapabilities = ref(fallbackAgentCapabilities("claude"));
const codexCapabilities = ref(fallbackAgentCapabilities("codex"));
const rememberedThinkingTrigger = ref(draft.thinkingTrigger.trim() || "think");
const thinkingTriggerEnabled = computed({
  get: () => draft.thinkingTrigger.trim().length > 0,
  set: (enabled: boolean) => {
    if (enabled) {
      draft.thinkingTrigger = rememberedThinkingTrigger.value || "think";
      return;
    }
    const current = draft.thinkingTrigger.trim();
    if (current) rememberedThinkingTrigger.value = current;
    draft.thinkingTrigger = "";
  }
});

watch(() => draft.thinkingTrigger, (value) => {
  const next = value.trim();
  if (next) rememberedThinkingTrigger.value = next;
});

const claudeModelOptions = computed(() =>
  modelControlOptions("claude", draft.defaultClaudeModel, claudeCapabilities.value)
);
const claudeEffortOptions = computed(() =>
  effortControlOptions("claude", draft.defaultClaudeModel, draft.defaultClaudeEffort, claudeCapabilities.value)
);
const claudePermissionOptions = computed(() =>
  permissionControlOptions("claude", draft.defaultClaudePermissionMode, claudeCapabilities.value)
);
const codexModelOptions = computed(() =>
  modelControlOptions("codex", draft.defaultCodexModel, codexCapabilities.value)
);
const codexEffortOptions = computed(() =>
  effortControlOptions("codex", draft.defaultCodexModel, draft.defaultCodexEffort, codexCapabilities.value)
);
const codexApprovalOptions = computed(() =>
  permissionControlOptions("codex", draft.defaultCodexApprovalPreset, codexCapabilities.value)
);
const codexSandboxOptions = computed(() =>
  sandboxControlOptions(draft.defaultCodexSandboxMode, codexCapabilities.value)
);
const codexYolo = computed(() => isCodexYolo(
  draft.defaultCodexApprovalPreset,
  draft.defaultCodexSandboxMode,
  codexCapabilities.value
));

async function loadCapabilities(agent: AgentKind) {
  try {
    const result = await mainSocket.request<AgentCapabilities>("get-agent-capabilities", { agent });
    if (
      !result
      || result.agent !== agent
      || !Array.isArray(result.models)
      || !Array.isArray(result.permissionModes)
      || !Array.isArray(result.sandboxModes)
    ) return;
    if (agent === "claude") claudeCapabilities.value = result;
    else codexCapabilities.value = result;
  } catch {
    // Keep exact installed-version fallbacks when capability discovery is unavailable.
  }
}

onMounted(async () => {
  await Promise.all([loadCapabilities("claude"), loadCapabilities("codex")]);
  draft.defaultClaudeModel = effectiveModelValue("claude", draft.defaultClaudeModel, claudeCapabilities.value);
  draft.defaultClaudeEffort = effectiveEffortValue("claude", draft.defaultClaudeModel, draft.defaultClaudeEffort, claudeCapabilities.value);
  draft.defaultClaudePermissionMode = effectivePermissionValue("claude", draft.defaultClaudePermissionMode, claudeCapabilities.value);
  draft.defaultCodexModel = effectiveModelValue("codex", draft.defaultCodexModel, codexCapabilities.value);
  draft.defaultCodexEffort = effectiveEffortValue("codex", draft.defaultCodexModel, draft.defaultCodexEffort, codexCapabilities.value);
  draft.defaultCodexApprovalPreset = effectivePermissionValue("codex", draft.defaultCodexApprovalPreset, codexCapabilities.value);
  draft.defaultCodexSandboxMode = effectiveSandboxValue(draft.defaultCodexSandboxMode, codexCapabilities.value);
  capabilitiesLoading.value = false;
});

async function save(): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  saveError.value = "";
  const next = normalizePrefs({
    ...draft,
    autoTitleFrequency: Number(draft.autoTitleFrequency)
  });
  try {
    await store.save(next);
    emit("close");
  } catch (error) {
    saveError.value = error instanceof Error ? error.message : "Could not save settings";
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="cw-modal-scrim" @click.self="emit('close')">
      <form
        class="cw-modal cw-settings-modal"
        aria-labelledby="cw-settings-title"
        @submit.prevent="save"
      >
        <header class="cw-settings-header">
          <div>
            <h2 id="cw-settings-title">Settings</h2>
            <p>Selections apply to new sessions unless a session overrides them.</p>
          </div>
          <button type="button" aria-label="Close settings" @click="emit('close')">×</button>
        </header>

        <div class="cw-settings-scroll">
          <section class="cw-settings-section">
            <h3>Appearance</h3>
            <div class="cw-settings-grid">
              <label>
                Message display
                <select v-model="draft.messageDisplayStyle" data-testid="display-style">
                  <option v-for="item in THEME_OPTIONS" :key="item.value" :value="item.value">
                    {{ item.label }}
                  </option>
                </select>
              </label>
              <label>
                Color
                <select v-model="draft.colorPreference" data-testid="color-preference">
                  <option value="system">Auto</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </label>
            </div>
            <label class="cw-settings-check">
              <input v-model="draft.showActiveSection" type="checkbox" />
              <span>Show active sessions section</span>
            </label>
            <label class="cw-settings-check">
              <input v-model="draft.showPeerSessions" type="checkbox" />
              <span>Show sessions started outside this WebUI</span>
            </label>
          </section>

          <section class="cw-settings-section">
            <h3>Automatic titles</h3>
            <label class="cw-settings-check">
              <input
                v-model="draft.autoTitleEnabled"
                data-testid="auto-title-enabled"
                type="checkbox"
              />
              <span>Generate titles automatically</span>
            </label>
            <div class="cw-settings-grid">
              <label>
                Retitle frequency (turns)
                <input
                  v-model.number="draft.autoTitleFrequency"
                  data-testid="auto-title-frequency"
                  type="number"
                  min="1"
                  max="100"
                  step="1"
                  :disabled="!draft.autoTitleEnabled"
                />
              </label>
              <label>
                Title language
                <input
                  v-model.trim="draft.autoTitleLanguage"
                  data-testid="auto-title-language"
                  list="cw-title-languages"
                  placeholder="auto"
                  :disabled="!draft.autoTitleEnabled"
                />
                <datalist id="cw-title-languages">
                  <option value="auto" />
                  <option value="English" />
                  <option value="中文" />
                </datalist>
              </label>
            </div>
          </section>

          <section class="cw-settings-section">
            <h3>Claude Code <LoaderCircle v-if="capabilitiesLoading" class="cw-spin" :size="13" /></h3>
            <div class="cw-settings-grid">
              <label>
                Model
                <select
                  v-model="draft.defaultClaudeModel"
                  data-testid="default-claude-model"
                >
                  <option v-for="option in claudeModelOptions" :key="option.value" :value="option.value" :title="option.description || undefined">{{ option.value }}</option>
                </select>
              </label>
              <label>
                Effort
                <select
                  v-model="draft.defaultClaudeEffort"
                  data-testid="default-claude-effort"
                >
                  <option v-for="option in claudeEffortOptions" :key="option.value" :value="option.value" :title="option.description || undefined">{{ option.value }}</option>
                </select>
              </label>
              <label>
                Permission mode
                <select
                  v-model="draft.defaultClaudePermissionMode"
                  data-testid="default-claude-permission"
                >
                  <option v-for="option in claudePermissionOptions" :key="option.value" :value="option.value" :title="option.description || undefined">{{ option.value }}</option>
                </select>
              </label>
            </div>
            <p class="cw-settings-help">These are the permission-mode values accepted by the installed Claude CLI.</p>
          </section>

          <section class="cw-settings-section">
            <h3>Codex <LoaderCircle v-if="capabilitiesLoading" class="cw-spin" :size="13" /></h3>
            <div class="cw-settings-grid">
              <label>
                Model
                <select
                  v-model="draft.defaultCodexModel"
                  data-testid="default-codex-model"
                >
                  <option v-for="option in codexModelOptions" :key="option.value" :value="option.value" :title="option.description || undefined">{{ option.value }}</option>
                </select>
              </label>
              <label>
                Effort
                <select
                  v-model="draft.defaultCodexEffort"
                  data-testid="default-codex-effort"
                >
                  <option v-for="option in codexEffortOptions" :key="option.value" :value="option.value" :title="option.description || undefined">{{ option.value }}</option>
                </select>
              </label>
              <label>
                Approval policy
                <select
                  v-model="draft.defaultCodexApprovalPreset"
                  data-testid="default-codex-approval"
                >
                  <option v-for="option in codexApprovalOptions" :key="option.value" :value="option.value" :title="option.description || undefined">{{ option.value }}</option>
                </select>
              </label>
              <label>
                Sandbox
                <select
                  v-model="draft.defaultCodexSandboxMode"
                  data-testid="default-codex-sandbox"
                >
                  <option v-for="option in codexSandboxOptions" :key="option.value" :value="option.value" :title="option.description || undefined">{{ option.value }}</option>
                </select>
              </label>
            </div>
            <p class="cw-settings-help">
              <strong v-if="codexYolo" class="cw-yolo-inline">YOLO:</strong>
              {{ codexYolo ? "approval is never and the filesystem sandbox is disabled." : "YOLO requires both Never ask and Full access." }}
            </p>
          </section>

          <section class="cw-settings-section">
            <h3>Scratch session</h3>
            <label class="cw-settings-check">
              <input
                v-model="draft.scratchSessionEnabled"
                data-testid="scratch-enabled"
                type="checkbox"
              />
              <span>Enable a dedicated scratch session</span>
            </label>
            <label>
              Working directory
              <input
                v-model.trim="draft.scratchSessionPath"
                data-testid="scratch-path"
                placeholder="~/scratch"
                :disabled="!draft.scratchSessionEnabled"
              />
            </label>
          </section>

          <section class="cw-settings-section">
            <h3>Agent behavior</h3>
            <label class="cw-settings-check">
              <input
                v-model="thinkingTriggerEnabled"
                data-testid="thinking-trigger-enabled"
                type="checkbox"
              />
              <span>Enable thinking trigger</span>
            </label>
            <label>
              Trigger phrase
              <input
                v-model="draft.thinkingTrigger"
                data-testid="thinking-trigger"
                placeholder="think"
                :disabled="!thinkingTriggerEnabled"
              />
            </label>
            <p class="cw-settings-help">Turn this off to disable automatic thinking-trigger expansion.</p>
          </section>
        </div>

        <p v-if="saveError" class="cw-settings-error" role="alert">{{ saveError }}</p>
        <div class="cw-modal-actions">
          <button type="button" :disabled="saving" @click="emit('close')">Cancel</button>
          <button class="primary" data-testid="settings-save" :disabled="saving">
            {{ saving ? "Saving…" : "Save" }}
          </button>
        </div>
      </form>
    </div>
  </Teleport>
</template>
