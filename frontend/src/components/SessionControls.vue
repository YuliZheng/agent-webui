<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Check, ChevronDown, LoaderCircle, Square } from "lucide-vue-next";
import { mainSocket } from "@/api/ws";
import type {
  AgentCapabilities,
  SessionListItem,
  SessionSettings,
  SessionStatus
} from "@/types";
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
  sandboxControlOptions,
  type SessionControlOption
} from "@/util/session-controls";
import { useUiStore } from "@/stores/ui";

type MenuKind = "model" | "effort" | "permission" | null;

const props = defineProps<{
  session: SessionListItem;
  status?: SessionStatus;
  settings?: SessionSettings;
}>();

const ui = useUiStore();
const capabilities = ref<AgentCapabilities>(fallbackAgentCapabilities(props.session.agent));
const loaded = ref(false);
const loading = ref(false);
const activeMenu = ref<MenuKind>(null);
const anchor = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const menuPosition = ref({ left: 8, top: 8 });
const pendingValues = ref<Partial<SessionSettings>>({});
let loadSequence = 0;

const model = computed(() => effectiveModelValue(
  props.session.agent,
  pendingValues.value.model ?? props.settings?.model,
  capabilities.value
));
const effort = computed(() => effectiveEffortValue(
  props.session.agent,
  model.value,
  pendingValues.value.effort ?? props.settings?.effort,
  capabilities.value
));
const permission = computed(() => effectivePermissionValue(
  props.session.agent,
  pendingValues.value.permissionMode ?? props.settings?.permissionMode,
  capabilities.value
));
const sandbox = computed(() => effectiveSandboxValue(
  pendingValues.value.sandboxMode ?? props.settings?.sandboxMode,
  capabilities.value
));
const models = computed(() => modelControlOptions(props.session.agent, model.value, capabilities.value));
const efforts = computed(() => effortControlOptions(props.session.agent, model.value, effort.value, capabilities.value));
const permissions = computed(() => permissionControlOptions(props.session.agent, permission.value, capabilities.value));
const sandboxes = computed(() => sandboxControlOptions(sandbox.value, capabilities.value));
const modelLabel = computed(() => optionLabel(models.value, model.value));
const effortLabel = computed(() => optionLabel(efforts.value, effort.value));
const permissionLabel = computed(() =>
  props.session.agent === "codex" && isCodexYolo(permission.value, sandbox.value, capabilities.value)
    ? "YOLO mode"
    : optionLabel(permissions.value, permission.value)
);

function optionLabel(options: readonly SessionControlOption[], value: string): string {
  return options.find((option) => option.value === value)?.label || value;
}

async function ensureCapabilities(): Promise<void> {
  if (loaded.value || loading.value) return;
  const sequence = ++loadSequence;
  const sessionId = props.session.id;
  loading.value = true;
  try {
    const result = await mainSocket.request<AgentCapabilities>("get-agent-capabilities", {
      agent: props.session.agent,
      cwd: props.session.cwd
    });
    if (sequence !== loadSequence || sessionId !== props.session.id) return;
    if (
      result?.agent === props.session.agent
      && Array.isArray(result.models)
      && Array.isArray(result.permissionModes)
      && Array.isArray(result.sandboxModes)
    ) capabilities.value = result;
  } catch {
    // Explicit, version-safe fallback options remain usable.
  } finally {
    if (sequence === loadSequence) {
      loading.value = false;
      loaded.value = true;
    }
  }
}

function open(kind: Exclude<MenuKind, null>, event: MouseEvent): void {
  if (activeMenu.value === kind) {
    close();
    return;
  }
  anchor.value = event.currentTarget as HTMLButtonElement;
  activeMenu.value = kind;
  positionMenu();
  void ensureCapabilities();
  void nextTick(() => menu.value?.querySelector<HTMLButtonElement>("[role=option]")?.focus());
}

function positionMenu(): void {
  const rect = anchor.value?.getBoundingClientRect();
  if (!rect) return;
  const width = activeMenu.value === "permission" && props.session.agent === "codex" ? 286 : 238;
  const estimatedHeight = activeMenu.value === "permission" && props.session.agent === "codex" ? 360 : 300;
  const above = rect.top - estimatedHeight - 8;
  menuPosition.value = {
    left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
    top: Math.max(8, above >= 8 ? above : Math.min(rect.bottom + 6, window.innerHeight - estimatedHeight - 8))
  };
}

function close(): void {
  activeMenu.value = null;
  anchor.value = null;
}

async function choose(kind: Exclude<MenuKind, null>, value: string): Promise<void> {
  try {
    if (kind === "model") {
      pendingValues.value = { ...pendingValues.value, model: value };
      await mainSocket.request("set-model", { sessionId: props.session.id, model: value });
    } else if (kind === "effort") {
      pendingValues.value = { ...pendingValues.value, effort: value };
      await mainSocket.request("set-effort", { sessionId: props.session.id, effort: value });
    } else {
      pendingValues.value = { ...pendingValues.value, permissionMode: value };
      await mainSocket.request("set-permission-mode", { sessionId: props.session.id, mode: value });
    }
    close();
  } catch (error) {
    ui.toast(error instanceof Error ? error.message : "Could not update session settings", "error");
  }
}

async function chooseSandbox(value: string): Promise<void> {
  try {
    pendingValues.value = { ...pendingValues.value, sandboxMode: value };
    await mainSocket.request("set-sandbox-mode", { sessionId: props.session.id, mode: value });
  } catch (error) {
    ui.toast(error instanceof Error ? error.message : "Could not update sandbox mode", "error");
  }
}

async function stop(): Promise<void> {
  try {
    await mainSocket.request("stop", { sessionId: props.session.id });
  } catch (error) {
    ui.toast(error instanceof Error ? error.message : "Could not stop the active turn", "error");
  }
}

function onMenuKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    close();
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const options = [...(menu.value?.querySelectorAll<HTMLButtonElement>("[role=option]:not(:disabled)") ?? [])];
  if (!options.length) return;
  event.preventDefault();
  const index = options.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0
    : event.key === "End" ? options.length - 1
    : event.key === "ArrowUp" ? (index <= 0 ? options.length - 1 : index - 1)
    : (index + 1) % options.length;
  options[next]?.focus();
}

watch(() => [props.session.id, props.session.agent], () => {
  loadSequence++;
  capabilities.value = fallbackAgentCapabilities(props.session.agent);
  loaded.value = false;
  loading.value = false;
  pendingValues.value = {};
  close();
}, { immediate: true });
watch(() => props.settings, () => {
  const next = { ...pendingValues.value };
  if (props.settings?.model === next.model) delete next.model;
  if (props.settings?.effort === next.effort) delete next.effort;
  if (props.settings?.permissionMode === next.permissionMode) delete next.permissionMode;
  if (props.settings?.sandboxMode === next.sandboxMode) delete next.sandboxMode;
  pendingValues.value = next;
}, { deep: true });
onBeforeUnmount(() => {
  loadSequence++;
  close();
});
</script>

<template>
  <div class="cw-composer-controls" aria-label="Session controls">
    <button class="cw-control-pill" type="button" data-testid="session-model" aria-haspopup="listbox" :aria-expanded="activeMenu === 'model'" title="Model" @click="open('model', $event)">
      <span>{{ modelLabel }}</span><ChevronDown :size="12" />
    </button>
    <button v-if="session.agent === 'codex' && efforts.length" class="cw-control-pill" type="button" data-testid="session-effort" aria-haspopup="listbox" :aria-expanded="activeMenu === 'effort'" title="Reasoning effort" @click="open('effort', $event)">
      <span>{{ effortLabel }}</span><ChevronDown :size="12" />
    </button>
    <button class="cw-control-pill" type="button" data-testid="session-permission" aria-haspopup="listbox" :aria-expanded="activeMenu === 'permission'" :title="session.agent === 'codex' ? 'Approval and sandbox' : 'Permission mode'" @click="open('permission', $event)">
      <span>{{ permissionLabel }}</span><ChevronDown :size="12" />
    </button>
    <button class="cw-control-stop" type="button" data-testid="session-stop" title="Stop turn" aria-label="Stop turn" :disabled="status?.status !== 'running'" @click="stop">
      <Square :size="9" :stroke-width="0" fill="currentColor" />
    </button>
    <LoaderCircle v-if="loading" class="cw-capabilities-loading cw-spin" :size="12" aria-label="Reading installed agent capabilities" />
  </div>

  <Teleport to="body">
    <template v-if="activeMenu">
      <button class="cw-popover-scrim" aria-label="Close setting menu" @click="close" />
      <section
        ref="menu"
        class="cw-control-popover"
        :class="`is-${activeMenu}`"
        role="listbox"
        :aria-label="activeMenu"
        :style="{ left: `${menuPosition.left}px`, top: `${menuPosition.top}px` }"
        @keydown="onMenuKeydown"
      >
        <header>{{ activeMenu === "model" ? "Model" : activeMenu === "effort" ? "Reasoning effort" : session.agent === "codex" ? "Approval policy" : "Permission mode" }}</header>
        <template v-if="activeMenu === 'model'">
          <button v-for="option in models" :key="option.value" role="option" :aria-selected="option.value === model" @click="choose('model', option.value)">
            <span><strong>{{ option.label }}</strong><small v-if="option.description">{{ option.description }}</small></span>
            <Check v-if="option.value === model" :size="14" />
          </button>
        </template>
        <template v-else-if="activeMenu === 'effort'">
          <button v-for="option in efforts" :key="option.value" role="option" :aria-selected="option.value === effort" @click="choose('effort', option.value)">
            <span><strong>{{ option.label }}</strong><small v-if="option.description">{{ option.description }}</small></span>
            <Check v-if="option.value === effort" :size="14" />
          </button>
        </template>
        <template v-else>
          <button v-for="option in permissions" :key="option.value" role="option" :aria-selected="option.value === permission" @click="choose('permission', option.value)">
            <span><strong>{{ option.label }}</strong><small v-if="option.description">{{ option.description }}</small></span>
            <Check v-if="option.value === permission" :size="14" />
          </button>
          <template v-if="session.agent === 'codex'">
            <div class="cw-control-popover-divider">Filesystem sandbox</div>
            <button v-for="option in sandboxes" :key="option.value" role="option" :aria-selected="option.value === sandbox" @click="chooseSandbox(option.value)">
              <span><strong>{{ option.label }}</strong><small v-if="option.description">{{ option.description }}</small></span>
              <Check v-if="option.value === sandbox" :size="14" />
            </button>
          </template>
        </template>
      </section>
    </template>
  </Teleport>
</template>
