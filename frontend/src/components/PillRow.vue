<script setup lang="ts">
import { computed, onBeforeUnmount, ref, onMounted, nextTick, watch } from "vue";
import type { AgentCapabilities } from "@claude-webui/shared/api";
import { MODEL_CHOICES, CODEX_MODEL_CHOICES, CODEX_DEFAULT_MODEL, CODEX_APPROVAL_PRESETS, CODEX_DEFAULT_APPROVAL, PERMISSION_MODES, CLAUDE_REASONING_EFFORTS } from "@claude-webui/shared/prefs";
import { useSessionSettingsStore } from "../stores/session-settings.js";
import { useSessionsStore } from "../stores/sessions.js";
import { usePrefsStore } from "../stores/prefs.js";
import { useNotificationsStore } from "../stores/notifications.js";
import {
  setSessionModel,
  setSessionPermissionMode,
  setSessionEffort,
  setSessionServiceTier,
  getAgentCapabilities,
  stopSession,
} from "../api/sessions.js";
import { APP_BACK_PRIORITY, registerAppBackHandler } from "../util/app-back.js";
import { resolveCodexEffortChoices } from "../util/codex-efforts.js";
import { setPwaLayerActive } from "../util/pwa-history.js";

const props = defineProps<{ sessionId: string }>();
let unregisterAppBack: (() => void) | undefined;

const settings = useSessionSettingsStore();
const sessions = useSessionsStore();
const prefs = usePrefsStore();
const notifications = useNotificationsStore();

// Codex sessions use a different model list/default and have no claude-style
// permission mode. Drive the pill off the agent.
const isCodex = computed(() => sessions.byId[props.sessionId]?.agent === "codex");
const modelChoices = computed<readonly string[]>(() => isCodex.value ? CODEX_MODEL_CHOICES : MODEL_CHOICES);
const codexEff = computed(() => settings.effectiveCodex(props.sessionId));

// Effort pill. Codex resolves through the codex capability chain; Claude
// through the backend push (set-effort) with the webui pref, then the
// external CLAUDE_CODE_EFFORT_LEVEL (surfaced via claude capabilities), as
// fallbacks.
const currentEffort = computed(() => {
  // Resolve effective effort: session override → global pref default → null
  const raw = isDraft.value
    ? (draft.value?.effort ?? (isCodex.value ? (prefs.defaultCodexEffort || null) : (prefs.defaultClaudeEffort || null)))
    : isCodex.value
      ? (codexEff.value.effort || null)
      : (eff.value.effort || prefs.defaultClaudeEffort || codexCapabilities.value?.defaults.effort || null);
  return raw;
});
// While a service-tier request is in flight, keep the user's newest choice as
// a local display overlay. The button remains clickable so rapid on/off/on
// changes are coalesced and the backend ultimately receives the last choice.
const pendingFastTier = ref<"" | "priority" | null>(null);
const fastBusy = ref(false);
const codexCapabilities = ref<AgentCapabilities | null>(null);
const capabilitiesLoading = ref(false);
const fastTier = computed(() => {
  if (!isCodex.value) return "unknown";
  if (!isDraft.value && pendingFastTier.value !== null) {
    return pendingFastTier.value === "priority" ? "priority" : "standard";
  }
  if (!isDraft.value) {
    // Existing sessions must use session evidence. Falling back to the global
    // capability default here would mislabel an external Standard session as
    // Fast whenever its rollout omits service_tier.
    return codexEff.value.serviceTier;
  }
  if (draft.value?.serviceTier !== undefined) {
    return draft.value.serviceTier === "priority" ? "priority" : "standard";
  }
  if (prefs.loaded) {
    return prefs.defaultCodexServiceTier === "priority" ? "priority" : "standard";
  }
  const defaultTier = codexCapabilities.value?.defaults.serviceTier;
  return defaultTier === "priority" || defaultTier === "fast"
    ? "priority"
    : defaultTier === "standard" || defaultTier === "default"
      ? "standard"
      : "unknown";
});
const fastMode = computed(() => fastTier.value === "priority");
const fastKnown = computed(() =>
  fastTier.value === "priority"
  || fastTier.value === "standard"
  || (isDraft.value && fastTier.value === ""),
);
const fastStateLabel = computed(() => fastKnown.value ? (fastMode.value ? "on" : "off") : "unknown");
const effortLabel = computed(() => {
  // Claude always shows the effective value (never "(default)") — the
  // fallback chain ends at the external settings.json default.
  if (currentEffort.value) return currentEffort.value;
  return isCodex.value ? "(default)" : "?";
});
// stashed on the pending draft (localStorage) and ride along with the
// first newSession call instead of going through the set-model RPC.
const isDraft = computed(() => sessions.isPending(props.sessionId));
const draft = computed(() => sessions.pendingDrafts[props.sessionId]);

const eff = computed(() => settings.effective(props.sessionId));
// Draft: show the draft's stash, falling back to the relevant global
// default. Codex: show the backend override if set, else the codex default
// — NOT the claude prefs fallback that eff() would return. Claude: use eff().
const currentModel = computed(() => {
  if (isDraft.value) {
    return draft.value?.model
      ?? (isCodex.value ? (prefs.defaultCodexModel || CODEX_DEFAULT_MODEL) : (prefs.defaultModel || null));
  }
  return isCodex.value
    ? codexEff.value.model
    : eff.value.model;
});
const currentModelCapability = computed(() =>
  codexCapabilities.value?.models.find(model => model.value === currentModel.value),
);
const effortChoices = computed(() =>
  isCodex.value
    ? resolveCodexEffortChoices(currentModelCapability.value?.supportedEfforts)
    : CLAUDE_REASONING_EFFORTS,
);
const fastSupportKnown = computed(() => currentModelCapability.value?.serviceTiers !== undefined);
const fastSupported = computed(() =>
  currentModelCapability.value?.serviceTiers?.some(tier => tier.value === "priority") ?? true,
);
const fastUnavailable = computed(() => fastSupportKnown.value && !fastSupported.value && !fastMode.value);
// Strip the dead-weight `claude-` prefix from the visible pill label. The
// full id still shows in the popover and the tooltip, so nothing is hidden.
const modelLabel = computed(() => {
  const m = currentModel.value;
  if (!m) return "(default)";
  return m.startsWith("claude-") ? m.slice("claude-".length) : m;
});
// Permission pill = claude permission mode OR codex approval preset.
const permChoices = computed<{ value: string; label: string }[]>(() =>
  isCodex.value
    ? CODEX_APPROVAL_PRESETS.map((p) => ({ value: p.key, label: p.label }))
    : PERMISSION_MODES.map((m) => ({ value: m, label: m })),
);
const currentPerm = computed(() => {
  if (isDraft.value) {
    return draft.value?.permissionMode
      ?? (isCodex.value ? (prefs.defaultCodexApproval || CODEX_DEFAULT_APPROVAL) : (prefs.defaultPermissionMode || null));
  }
  return isCodex.value
    ? codexEff.value.permissionMode
    : eff.value.permissionMode;
});
const permLabel = computed(() => currentPerm.value || "(default)");

// Popover state. Only one open at a time — opening the other closes the first.
const open = ref<null | "model" | "effort" | "perm">(null);
watch(open, value => {
  setPwaLayerActive(`pill-menu:${props.sessionId}`, value !== null, props.sessionId);
});
// Pill triggers + the floating popover are anchored via fixed coordinates and
// Teleported to <body>. The claude-code desktop composer (.cw-cc-composer) has
// `overflow: hidden` to clip its rounded corners, which would otherwise slice
// off the top of an upward popover (only the last model row stayed visible).
const modelBtn = ref<HTMLElement | null>(null);
const effortBtn = ref<HTMLElement | null>(null);
const permBtn = ref<HTMLElement | null>(null);
const popStyle = ref<Record<string, string>>({});

// Place the popover above its trigger, left-aligned, clamped into the viewport.
// `max-height` is bounded to the room above the pill so a long model list
// scrolls instead of running off the top of the screen.
function positionPop(anchor: HTMLElement | null) {
  if (!anchor) return;
  const r = anchor.getBoundingClientRect();
  const gap = 6;
  const POP_W = 360;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - POP_W - 8));
  popStyle.value = {
    position: "fixed",
    left: `${Math.round(left)}px`,
    bottom: `${Math.round(window.innerHeight - r.top + gap)}px`,
    maxHeight: `${Math.max(120, Math.round(r.top - gap - 8))}px`,
  };
}

function toggle(which: "model" | "effort" | "perm") {
  if (open.value === which) { close(); return; }
  open.value = which;
  if (which === "model" || which === "effort") void loadCapabilities();
  void nextTick(() => positionPop(
    which === "model" ? modelBtn.value :
    which === "effort" ? effortBtn.value :
    permBtn.value
  ));
}
function close() { open.value = null; }

// Close on outside click + Escape. The popover lives at <body> (Teleport), so
// "inside" means within the pill row OR within the floating popover itself.
const root = ref<HTMLElement | null>(null);
function onDocClick(e: MouseEvent) {
  if (!open.value) return;
  const target = e.target as Element | null;
  if (target && root.value?.contains(target)) return;
  if (target && target.closest(".pill-pop")) return;
  close();
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape" && open.value) { e.preventDefault(); close(); }
}
function onResize() { if (open.value) close(); }
async function loadCapabilities() {
  if (capabilitiesLoading.value || codexCapabilities.value) return;
  capabilitiesLoading.value = true;
  try {
    codexCapabilities.value = await getAgentCapabilities(
      isCodex.value ? "codex" : "claude",
      sessions.byId[props.sessionId]?.cwd,
    );
  } catch {
    // Older or temporarily disconnected backends remain usable. Unknown
    // capability state keeps the control available and lets app-server decide.
  } finally {
    capabilitiesLoading.value = false;
  }
}
onMounted(() => {
  unregisterAppBack = registerAppBackHandler(() => {
    if (!open.value) return false;
    close();
    return true;
  }, APP_BACK_PRIORITY.menu);
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", onResize);
});
onBeforeUnmount(() => {
  unregisterAppBack?.();
  document.removeEventListener("click", onDocClick);
  document.removeEventListener("keydown", onKey);
  window.removeEventListener("resize", onResize);
});

async function pickModel(model: string) {
  close();
  if (model === currentModel.value) return;
  if (isDraft.value) {
    sessions.setPendingSettings(props.sessionId, { model });
    return;
  }
  try {
    await setSessionModel(props.sessionId, model);
  } catch (err) {
    notifications.pushError(err instanceof Error ? err.message : String(err), { title: "Set model failed" });
  }
}

async function pickEffort(effort: string) {
  close();
  if (effort === currentEffort.value) return;
  if (isDraft.value) {
    sessions.setPendingSettings(props.sessionId, { effort });
    return;
  }
  try {
    await setSessionEffort(props.sessionId, effort);
  } catch (err) {
    notifications.pushError(err instanceof Error ? err.message : String(err), { title: "Set effort failed" });
  }
}

async function syncFastTier() {
  if (fastBusy.value || isDraft.value) return;
  fastBusy.value = true;
  try {
    // Serialize writes but coalesce any clicks made during the round trip. If
    // the desired value changes, the loop sends only the newest value next.
    while (pendingFastTier.value !== null) {
      const requested = pendingFastTier.value;
      await setSessionServiceTier(props.sessionId, requested);
      if (pendingFastTier.value === requested) {
        // Empty is the wire command for "turn Fast off", but `null` means
        // "no authoritative override" in the settings resolver. Persist the
        // confirmed off state explicitly so an older rollout `priority` record
        // cannot make the pill spring back on before the next turn lands.
        const confirmedTier = requested === "priority" ? "priority" : "standard";
        settings.apply({ id: props.sessionId, serviceTier: confirmedTier });
        pendingFastTier.value = null;
        notifications.pushInfo(
          `Fast turned ${requested === "priority" ? "on" : "off"} — applies from the next turn.`,
          { title: "Fast" },
        );
      }
    }
  } catch (err) {
    // Removing the overlay reveals the last backend-confirmed setting.
    pendingFastTier.value = null;
    notifications.pushError(err instanceof Error ? err.message : String(err), { title: "Toggle fast mode failed" });
  } finally {
    fastBusy.value = false;
  }
}

function toggleFast() {
  if (fastUnavailable.value) {
    notifications.pushError(`Fast is not supported by ${currentModel.value || "the current model"}.`, { title: "Fast unavailable" });
    return;
  }
  const next: "" | "priority" = fastMode.value ? "" : "priority";
  if (isDraft.value) {
    sessions.setPendingSettings(props.sessionId, { serviceTier: next });
    notifications.pushInfo(
      `Fast will be ${next === "priority" ? "on" : "off"} when this session starts.`,
      { title: "Fast" },
    );
    return;
  }
  pendingFastTier.value = next;
  void syncFastTier();
}

async function pickPerm(mode: string) {
  close();
  if (mode === currentPerm.value) return;
  if (isDraft.value) {
    sessions.setPendingSettings(props.sessionId, { permissionMode: mode });
    return;
  }
  try {
    await setSessionPermissionMode(props.sessionId, mode);
  } catch (err) {
    notifications.pushError(err instanceof Error ? err.message : String(err), { title: "Set permission mode failed" });
  }
}

async function interrupt() {
  try {
    await stopSession(props.sessionId);
  } catch (err) {
    notifications.pushError(err instanceof Error ? err.message : String(err), { title: "Interrupt failed" });
  }
}
</script>

<template>
  <!-- Outer wrapper owns `relative` so popovers anchor against the row even
       though the inner scroller has `overflow-x: auto` (which would clip
       absolutely-positioned children). Inner scroller is `flex-nowrap` so
       the row never wraps onto two lines on narrow screens. -->
  <div ref="root" class="relative mb-2">
    <div class="pill-scroll flex items-center gap-1.5 flex-nowrap overflow-x-auto">
      <!-- Model pill -->
      <button
        ref="modelBtn"
        type="button"
        class="pill-btn shrink-0"
        :class="open === 'model' ? 'pill-active' : ''"
        :title="`model = ${currentModel || '(default)'} — click to switch`"
        @click="toggle('model')"
      >
        <span class="font-mono">{{ modelLabel }}</span>
        <span class="chev">▾</span>
      </button>

      <!-- Effort pill — Codex has Fast tier marks, Claude plain effort -->
      <button
        ref="effortBtn"
        type="button"
        class="pill-btn shrink-0"
        :class="{ 'pill-active': open === 'effort', 'pill-fast-on': fastMode }"
        :title="isCodex ? `effort = ${currentEffort || '(default)'} · Fast ${fastStateLabel} — click to switch` : `effort = ${currentEffort || '(default)'} — click to switch`"
        @click="toggle('effort')"
      >
        <span v-if="fastMode" class="fast-inline-mark" aria-hidden="true">⚡</span>
        <span v-else-if="!fastKnown" class="fast-inline-mark" aria-hidden="true">?</span>
        <span class="font-mono">{{ effortLabel }}</span>
        <span class="chev">▾</span>
      </button>

      <!-- Permission pill — claude permission mode OR codex approval policy -->
      <button
        ref="permBtn"
        type="button"
        class="pill-btn shrink-0"
        :class="open === 'perm' ? 'pill-active' : ''"
        :title="`${isCodex ? 'approval' : 'permissionMode'} = ${currentPerm || '(default)'} — click to switch`"
        @click="toggle('perm')"
      >
        <span class="font-mono">{{ permLabel }}</span>
        <span class="chev">▾</span>
      </button>

      <!-- Interrupt pill — always live, no status gating. doStop sends an
           interrupt control_request to our process (keeps it alive) and
           SIGTERMs any foreign claude bound to the same session. Hidden for
           drafts: nothing is running yet, there's nothing to interrupt. -->
      <button
        v-if="!isDraft"
        type="button"
        class="pill-btn shrink-0"
        title="Send interrupt control_request — stops the current turn without killing the process"
        @click="interrupt"
      >
        <span>■</span>
      </button>
    </div>

    <!-- Model popover — Teleported to <body> so the composer's overflow:hidden
         can't clip it; positioned via fixed coords against the pill button. -->
    <Teleport to="body">
    <div
      v-if="open === 'model'"
      class="pill-pop"
      :style="popStyle"
    >
      <button type="button" class="pill-pop-item" @click="pickModel('')">
        <span class="lbl font-mono">(default)</span>
        <span v-if="isDraft ? !draft?.model : (!isCodex && !eff.model)" class="tick">✓</span>
      </button>
      <div class="pill-pop-sep"></div>
      <button
        v-for="m in modelChoices"
        :key="m"
        type="button"
        class="pill-pop-item"
        @click="pickModel(m)"
      >
        <span class="lbl font-mono">{{ m }}</span>
        <span v-if="m === currentModel" class="tick">✓</span>
      </button>
    </div>
    </Teleport>

    <!-- Effort popover -->
    <Teleport to="body">
    <div
      v-if="open === 'effort'"
      class="pill-pop"
      :style="popStyle"
    >
      <button
        v-if="isCodex"
        type="button"
        class="pill-pop-item pill-pop-fast"
        :class="{ 'pill-pop-fast-active': fastMode, 'pill-pop-fast-syncing': fastBusy }"
        :title="fastUnavailable ? `Fast is not supported by ${currentModel || 'the current model'}` : fastMode ? 'Disable Fast service tier for the next turn' : fastKnown ? 'Enable Fast service tier for the next turn' : 'Fast tier unknown — click to enable for the next turn'"
        :aria-pressed="fastKnown ? fastMode : 'mixed'"
        :aria-busy="fastBusy"
        :aria-disabled="fastUnavailable"
        :disabled="fastUnavailable"
        @click="toggleFast"
      >
        <span class="lbl font-mono">⚡ Fast{{ fastUnavailable ? " (unavailable)" : fastKnown ? "" : " (?)" }}</span>
        <span class="fast-toggle" aria-hidden="true">
          <span class="fast-toggle-knob"></span>
        </span>
      </button>
      <div class="pill-pop-sep"></div>
      <button
        v-for="e in effortChoices"
        :key="e"
        type="button"
        class="pill-pop-item"
        @click="pickEffort(e)"
      >
        <span class="lbl font-mono">{{ e }}</span>
        <span v-if="e === currentEffort" class="tick">✓</span>
      </button>
    </div>
    </Teleport>

    <!-- Permission popover — Teleported to <body> (same rationale as model). -->
    <Teleport to="body">
    <div
      v-if="open === 'perm'"
      class="pill-pop"
      :style="popStyle"
    >
      <button type="button" class="pill-pop-item" @click="pickPerm('')">
        <span class="lbl font-mono">(default)</span>
        <span v-if="isDraft ? !draft?.permissionMode : (!isCodex && !eff.permissionMode)" class="tick">✓</span>
      </button>
      <div class="pill-pop-sep"></div>
      <button
        v-for="m in permChoices"
        :key="m.value"
        type="button"
        class="pill-pop-item"
        @click="pickPerm(m.value)"
      >
        <span class="lbl font-mono">{{ m.label }}</span>
        <span v-if="m.value === currentPerm" class="tick">✓</span>
      </button>
    </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* Hide the horizontal scrollbar — the row is short and the scroll affordance
   would dominate it. Users still scroll via touch drag / wheel / trackpad. */
.pill-scroll {
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.pill-scroll::-webkit-scrollbar { display: none; }

.pill-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 8px;
  border-radius: 9999px;
  font-size: 12px;
  line-height: 1;
  font-weight: 500;
  color: var(--cw-pill-fg, #374151);
  background: var(--cw-pill-bg, #f3f4f6);
  border: 1px solid var(--cw-pill-border, #e5e7eb);
  cursor: pointer;
  user-select: none;
  transition: background 0.12s;
}
.pill-btn:hover { background: var(--cw-pill-hover-bg, #e5e7eb); }
.pill-btn.pill-active { outline: 2px solid var(--cw-pill-active-outline, rgb(59 130 246 / 0.5)); outline-offset: 1px; }
.pill-btn .fast-inline-mark {
  color: var(--cw-fast-pill-border, #d97706);
  font-size: 11px;
  line-height: 1;
}
.pill-btn .chev { opacity: 0.55; }
:global(.dark) .pill-btn,
.dark .pill-btn {
  color: var(--cw-pill-fg, #d1d5db);
  background: var(--cw-pill-bg, #1f2937);
  border-color: var(--cw-pill-border, #374151);
}
:global(.dark) .pill-btn:hover,
.dark .pill-btn:hover { background: var(--cw-pill-hover-bg, #374151); }
@media (prefers-color-scheme: dark) {
  html:not(.light) .pill-btn {
    color: var(--cw-pill-fg, #d1d5db);
    background: var(--cw-pill-bg, #1f2937);
    border-color: var(--cw-pill-border, #374151);
  }
  html:not(.light) .pill-btn:hover { background: var(--cw-pill-hover-bg, #374151); }
}

.pill-pop {
  position: absolute;
  z-index: 30;
  background: var(--cw-popover-bg, white);
  border: 1px solid var(--cw-popover-border, #e5e7eb);
  border-radius: 12px;
  box-shadow: var(--cw-popover-shadow, 0 10px 30px rgba(0, 0, 0, 0.15));
  padding: 4px;
  min-width: 220px;
  max-width: 360px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
:global(.dark) .pill-pop,
.dark .pill-pop {
  background: var(--cw-popover-bg, #0f172a);
  border-color: var(--cw-popover-border, #1f2937);
  box-shadow: var(--cw-popover-shadow, 0 10px 30px rgba(0, 0, 0, 0.6));
}
@media (prefers-color-scheme: dark) {
  html:not(.light) .pill-pop {
    background: var(--cw-popover-bg, #0f172a);
    border-color: var(--cw-popover-border, #1f2937);
    box-shadow: var(--cw-popover-shadow, 0 10px 30px rgba(0, 0, 0, 0.6));
  }
}
.pill-pop-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  color: var(--cw-popover-fg, #1f2937);
  background: transparent;
  border: 0;
  text-align: left;
}
.pill-pop-item:hover { background: var(--cw-popover-hover-bg, #f3f4f6); }
:global(.dark) .pill-pop-item,
.dark .pill-pop-item { color: var(--cw-popover-fg, #e5e7eb); }
:global(.dark) .pill-pop-item:hover,
.dark .pill-pop-item:hover { background: var(--cw-popover-hover-bg, #1f2937); }
@media (prefers-color-scheme: dark) {
  html:not(.light) .pill-pop-item { color: var(--cw-popover-fg, #e5e7eb); }
  html:not(.light) .pill-pop-item:hover { background: var(--cw-popover-hover-bg, #1f2937); }
}
.pill-pop-fast {
  transition: color 0.12s ease, background 0.12s ease;
}
.pill-pop-fast-active {
  color: var(--cw-fast-menu-fg, #92400e);
  background: var(--cw-fast-menu-bg, #fffbeb);
}
.pill-pop-fast-active:hover {
  background: var(--cw-fast-menu-hover-bg, #fef3c7);
}
.fast-toggle {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  width: 30px;
  height: 17px;
  padding: 2px;
  border-radius: 9999px;
  background: var(--cw-fast-toggle-off-bg, #d1d5db);
  box-shadow: inset 0 0 0 1px var(--cw-fast-toggle-off-border, #cbd5e1);
  transition: background 0.14s ease, box-shadow 0.14s ease;
}
.fast-toggle-knob {
  display: block;
  width: 13px;
  height: 13px;
  border-radius: 9999px;
  background: #fff;
  box-shadow: 0 1px 2px rgb(15 23 42 / 0.25);
  transform: translateX(0);
  transition: transform 0.14s ease;
}
.pill-pop-fast-active .fast-toggle {
  background: var(--cw-fast-toggle-on-bg, #f59e0b);
  box-shadow: inset 0 0 0 1px var(--cw-fast-toggle-on-border, #d97706);
}
.pill-pop-fast-active .fast-toggle-knob {
  transform: translateX(13px);
}
.pill-pop-fast-syncing .fast-toggle {
  animation: fast-toggle-pulse 0.8s ease-in-out infinite alternate;
}
:global(.dark) .pill-pop-fast-active,
.dark .pill-pop-fast-active {
  color: var(--cw-fast-menu-fg, #fde68a);
  background: var(--cw-fast-menu-bg, #342707);
}
:global(.dark) .pill-pop-fast-active:hover,
.dark .pill-pop-fast-active:hover {
  background: var(--cw-fast-menu-hover-bg, #463509);
}
@media (prefers-color-scheme: dark) {
  html:not(.light) .pill-pop-fast-active {
    color: var(--cw-fast-menu-fg, #fde68a);
    background: var(--cw-fast-menu-bg, #342707);
  }
  html:not(.light) .pill-pop-fast-active:hover {
    background: var(--cw-fast-menu-hover-bg, #463509);
  }
}
@keyframes fast-toggle-pulse {
  from { opacity: 0.62; }
  to { opacity: 1; }
}
.pill-pop-item .lbl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pill-pop-item .tick { color: var(--cw-accent, #2563eb); font-weight: 700; }
.pill-pop-sep {
  height: 1px;
  background: var(--cw-popover-border, #e5e7eb);
  margin: 4px 6px;
}
:global(.dark) .pill-pop-sep,
.dark .pill-pop-sep { background: var(--cw-popover-border, #1f2937); }
@media (prefers-color-scheme: dark) {
  html:not(.light) .pill-pop-sep { background: var(--cw-popover-border, #1f2937); }
}
</style>
