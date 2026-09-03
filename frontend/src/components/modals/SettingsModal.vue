<script setup lang="ts">
import { ref, computed } from "vue";
import { useUiStore } from "../../stores/ui.js";
import { usePrefsStore } from "../../stores/prefs.js";
import { useSessionsStore } from "../../stores/sessions.js";
import { useNotificationsStore } from "../../stores/notifications.js";
import type { MessageDisplayStyle, PermissionMode, ThinkingTrigger } from "@claude-webui/shared/prefs";
import { MODEL_CHOICES, PERMISSION_MODES, CODEX_MODEL_CHOICES, CODEX_APPROVAL_PRESETS, CLAUDE_REASONING_EFFORTS, MESSAGE_DISPLAY_STYLE_OPTIONS, TITLE_LANGUAGE_CHOICES } from "@claude-webui/shared/prefs";
import { applyTheme } from "../../util/theme.js";
import { displayCwd } from "../../util/cwd-display.js";
import { deleteSessions, retitleAll } from "../../api/sessions.js";
import { CODEX_REASONING_EFFORTS } from "../../util/codex-efforts.js";
import {
  pwaInstallStatus,
  requestPwaInstall,
  type PwaInstallStatus,
} from "../../util/pwa-install.js";

const emit = defineEmits<{ (e: "close"): void }>();
const ui = useUiStore();
const prefs = usePrefsStore();
const sessions = useSessionsStore();

const newGroup = ref("");
const hiddenFilter = ref("");
const HIDDEN_VISIBLE_CAP = 25;
// Collapsed by default — the list used to dominate the modal even when
// the user opened Settings for an unrelated reason (theme, thinking
// trigger, groups). One click to expand when they actually want to manage.
const hiddenExpanded = ref(false);

interface HiddenItem { id: string; title: string | null; cwdDisplay: string; cwdRaw: string }

const hiddenItemsAll = computed<HiddenItem[]>(() =>
  prefs.hidden.map((id) => {
    const item = sessions.byId[id];
    return {
      id,
      title: item?.title ?? null,
      cwdDisplay: displayCwd(item?.cwd, ui.home),
      cwdRaw: item?.cwd ?? "",
    };
  }),
);

const hiddenFiltered = computed<HiddenItem[]>(() => {
  const q = hiddenFilter.value.trim().toLowerCase();
  if (!q) return hiddenItemsAll.value;
  const tokens = q.split(/\s+/).filter(Boolean);
  return hiddenItemsAll.value.filter((h) => {
    const hay = `${h.title ?? ""}\n${h.cwdDisplay}\n${h.cwdRaw}\n${h.id.slice(0, 8)}`.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
});

const hiddenVisible = computed(() => hiddenFiltered.value.slice(0, HIDDEN_VISIBLE_CAP));
const hiddenTruncated = computed(() => Math.max(0, hiddenFiltered.value.length - HIDDEN_VISIBLE_CAP));
const messageDisplayDescription = computed(() =>
  MESSAGE_DISPLAY_STYLE_OPTIONS.find((o) => o.value === prefs.messageDisplayStyle)?.description ?? "",
);

function unhideAllVisible() {
  for (const h of hiddenVisible.value) prefs.unhide(h.id);
}

const notifications = useNotificationsStore();
const purgeInflight = ref(false);

const appInstallDescription = computed(() => {
  const descriptions: Record<PwaInstallStatus, string> = {
    ready: "This browser is ready to install Agent WebUI as an app.",
    prompting: "Waiting for your response to the browser installation prompt.",
    installing: "Waiting for the browser to finish installing the app.",
    stalled: "Chrome accepted the request, but Android did not report completion. WebAPK generation requires Google WebAPK/Play services and network access; Chrome does not expose an installation percentage.",
    installed: "Agent WebUI is installed as an app on this device.",
    unavailable: "The browser install prompt is not currently available. You may still be able to install from the browser menu.",
    dismissed: "Installation was dismissed. The button will become available if the browser offers another prompt.",
  };
  return descriptions[pwaInstallStatus.value];
});

const appInstallButtonLabel = computed(() => {
  const labels: Record<PwaInstallStatus, string> = {
    ready: "Install app",
    prompting: "Opening install prompt…",
    installing: "Installing…",
    stalled: "Install pending",
    installed: "Installed",
    unavailable: "Install unavailable",
    dismissed: "Installation dismissed",
  };
  return labels[pwaInstallStatus.value];
});

async function purgeAllHidden() {
  const all = hiddenItemsAll.value;
  if (all.length === 0 || purgeInflight.value) return;
  const ok = window.confirm(
    `Permanently DELETE ${all.length} hidden session${all.length === 1 ? "" : "s"}?\n\n` +
    `This removes the jsonl files from ~/.claude/projects/ and cannot be undone. ` +
    `Sessions that are currently running will be skipped.`,
  );
  if (!ok) return;
  purgeInflight.value = true;
  const ids = all.map((h) => h.id);
  try {
    const r = await deleteSessions(ids);
    // Drop the deleted ones from the local stores so the sidebar updates.
    if (r.deleted.length) {
      sessions.removeMany(r.deleted);
      for (const id of r.deleted) prefs.unhide(id);
    }
    if (r.failed.length) {
      const sample = r.failed.slice(0, 3).map((f) => `${f.id.slice(0, 8)}: ${f.reason}`).join("; ");
      const more = r.failed.length > 3 ? ` (+${r.failed.length - 3} more)` : "";
      notifications.pushError(`${r.failed.length} session(s) could not be deleted — ${sample}${more}`, { title: "Partial delete" });
    }
  } catch (err) {
    notifications.pushError(err instanceof Error ? err.message : String(err), { title: "Delete failed" });
  } finally {
    purgeInflight.value = false;
  }
}

function setTheme(t: "auto" | "dark" | "light") {
  ui.setTheme(t);
  applyTheme(t);
}

function addGroup() {
  if (!newGroup.value.trim()) return;
  prefs.addGroup(newGroup.value.trim());
  newGroup.value = "";
}

function deleteGroup(name: string) {
  delete prefs.groups[name];
  prefs.schedulePut();
}

// Eligibility for "re-title all" — count locally from the sessions store so
// the confirm dialog can show concrete numbers without a round-trip. Anything
// without a manual title is fair game (auto-titled OR untitled). Hidden
// sessions are excluded from BOTH counters: the user explicitly stashed
// them, no point burning Haiku calls on them, and they shouldn't pad the
// "manual will be skipped" hint either since they're invisible anyway.
const retitleAllStats = computed(() => {
  const hidden = new Set(prefs.hidden);
  let eligible = 0, manual = 0;
  for (const s of sessions.list) {
    if (hidden.has(s.id)) continue;
    if (s.titleSource === "manual") manual++;
    else eligible++;
  }
  return { eligible, manual };
});
const retitleAllInflight = ref(false);

async function doRetitleAll() {
  if (retitleAllInflight.value) return;
  const { eligible, manual } = retitleAllStats.value;
  if (!eligible) {
    notifications.pushInfo("No auto-managed sessions to re-title.", { title: "Nothing to do" });
    return;
  }
  const ok = window.confirm(
    `Re-title ${eligible} auto-managed session${eligible === 1 ? "" : "s"}?\n\n` +
    `${manual} manually-named session${manual === 1 ? "" : "s"} will be skipped — ` +
    `click Auto in their Rename UI to opt them back in individually.\n\n` +
    `Each call hits the auto-titler model (haiku); this may take a minute or two ` +
    `at concurrency 2 and costs a few cents total.`,
  );
  if (!ok) return;
  retitleAllInflight.value = true;
  try {
    const r = await retitleAll();
    notifications.pushInfo(
      `Queued ${r.queued} session${r.queued === 1 ? "" : "s"}. Sidebar rows will spin as each one completes.`,
      { title: "Re-titling started" },
    );
  } catch (err) {
    notifications.pushError(err instanceof Error ? err.message : String(err), { title: "Re-title all failed" });
  } finally {
    retitleAllInflight.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="cw-modal-overlay fixed inset-0 z-40 bg-black/40 flex items-center justify-center" @click.self="emit('close')">
      <div class="cw-modal-card bg-[var(--cw-panel-bg)] rounded-lg p-5 w-[520px] max-w-[95vw] max-h-[90vh] overflow-auto overscroll-contain">
        <header class="flex items-center justify-between mb-3">
          <h2 class="font-semibold">Settings</h2>
          <button @click="emit('close')" class="opacity-60 hover:opacity-100">✕</button>
        </header>

        <section class="mb-5">
          <div class="text-xs uppercase tracking-wider opacity-70 mb-1">Appearance</div>
          <label class="mr-3"><input type="radio" name="theme" :checked="ui.theme === 'auto'" @change="setTheme('auto')" /> Auto</label>
          <label class="mr-3"><input type="radio" name="theme" :checked="ui.theme === 'dark'" @change="setTheme('dark')" /> Dark</label>
          <label><input type="radio" name="theme" :checked="ui.theme === 'light'" @change="setTheme('light')" /> Light</label>
          <div class="mt-3">
            <label class="block">
              <div class="text-xs opacity-70 mb-1">Message display</div>
              <select
                :value="prefs.messageDisplayStyle"
                @change="prefs.setMessageDisplayStyle(($event.target as HTMLSelectElement).value as MessageDisplayStyle)"
                class="w-full text-sm rounded border border-[var(--cw-border)]  bg-[var(--cw-panel-bg)] text-[var(--cw-text)]  px-2 py-1 focus:outline-none focus:border-[var(--cw-accent)] [&>option]:bg-white [&>option]:text-[var(--cw-text)] dark:[&>option]:bg-[var(--cw-panel-2)] dark:[&>option]:text-[var(--cw-text)]"
              >
                <option v-for="o in MESSAGE_DISPLAY_STYLE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
            </label>
            <p class="text-xs opacity-60 mt-1">{{ messageDisplayDescription }}</p>
          </div>
        </section>

        <section class="mb-5">
          <div class="text-xs uppercase tracking-wider opacity-70 mb-1">App installation</div>
          <p class="text-xs opacity-60 mb-2" aria-live="polite">
            {{ appInstallDescription }}
          </p>
          <button
            type="button"
            class="text-sm px-3 py-1.5 rounded border border-[var(--cw-border)] hover:bg-[var(--cw-panel-2)] disabled:opacity-50"
            :disabled="pwaInstallStatus !== 'ready'"
            @click="requestPwaInstall"
          >
            {{ appInstallButtonLabel }}
          </button>
          <div
            v-if="pwaInstallStatus === 'installing' || pwaInstallStatus === 'stalled'"
            class="mt-2 h-1.5 overflow-hidden rounded bg-[var(--cw-panel-2)]"
            role="progressbar"
            aria-label="Waiting for app installation"
          >
            <div class="h-full w-1/2 animate-pulse rounded bg-[var(--cw-accent)]"></div>
          </div>
        </section>

        <section class="mb-5">
          <div class="text-xs uppercase tracking-wider opacity-70 mb-1">Sidebar</div>
          <label class="text-sm flex items-center gap-2">
            <input
              type="checkbox"
              :checked="prefs.showActiveSection"
              @change="prefs.setShowActiveSection(($event.target as HTMLInputElement).checked)"
            />
            Show "● Active" section
          </label>
          <p class="text-xs opacity-60 mt-1 ml-6">
            Surfaces running + unread sessions in a section at the top of the chat
            list. Turn off if you don't want it — those sessions still appear in
            their normal place below.
          </p>
          <label class="text-sm flex items-center gap-2 mt-3">
            <input
              type="checkbox"
              :checked="prefs.showPeerSessions"
              @change="prefs.setShowPeerSessions(($event.target as HTMLInputElement).checked)"
            />
            Show peer sessions
          </label>
          <label class="text-sm flex items-center gap-2 mt-3">
            <input
              type="checkbox"
              :checked="prefs.showSubagentSessions"
              @change="prefs.setShowSubagentSessions(($event.target as HTMLInputElement).checked)"
            />
            显示 Subagent 会话
          </label>
          <p class="text-xs opacity-60 mt-1">
            默认隐藏 Codex 后台 worker；真正的 fork 仍会显示，搜索也始终可以找到它们。
          </p>
          <p class="text-xs opacity-60 mt-1 ml-6">
            Peer sessions are headless Claude↔Codex review workers spawned by the
            call-claude / call-codex bridges. Hidden from the list by default —
            they're tooling artifacts, not real chats. They still show up in search.
          </p>
        </section>

        <section class="mb-5">
          <div class="text-xs uppercase tracking-wider opacity-70 mb-1">Defaults for new sessions</div>
          <p class="text-xs opacity-60 mb-2">
            Passed as <code class="text-[11px]">--model</code> /
            <code class="text-[11px]">--permission-mode</code> at spawn for
            sessions with no per-session override. Per-session overrides
            (set via the pill row above the textarea) take precedence.
          </p>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label class="block">
              <div class="text-xs opacity-70 mb-1">defaultModel</div>
              <select
                :value="prefs.defaultModel"
                @change="prefs.setDefaultModel(($event.target as HTMLSelectElement).value)"
                class="w-full text-sm font-mono rounded border border-[var(--cw-border)]  bg-[var(--cw-panel-bg)] text-[var(--cw-text)]  px-2 py-1 focus:outline-none focus:border-[var(--cw-accent)] [&>option]:bg-white [&>option]:text-[var(--cw-text)] dark:[&>option]:bg-[var(--cw-panel-2)] dark:[&>option]:text-[var(--cw-text)]"
              >
                <option value="">(default)</option>
                <option v-for="m in MODEL_CHOICES" :key="m" :value="m">{{ m }}</option>
              </select>
            </label>
            <label class="block">
              <div class="text-xs opacity-70 mb-1">defaultPermissionMode</div>
              <select
                :value="prefs.defaultPermissionMode"
                @change="prefs.setDefaultPermissionMode(($event.target as HTMLSelectElement).value as PermissionMode | '')"
                class="w-full text-sm font-mono rounded border border-[var(--cw-border)]  bg-[var(--cw-panel-bg)] text-[var(--cw-text)]  px-2 py-1 focus:outline-none focus:border-[var(--cw-accent)] [&>option]:bg-white [&>option]:text-[var(--cw-text)] dark:[&>option]:bg-[var(--cw-panel-2)] dark:[&>option]:text-[var(--cw-text)]"
              >
                <option value="">(default)</option>
                <option v-for="m in PERMISSION_MODES" :key="m" :value="m">{{ m }}</option>
              </select>
            </label>
            <label class="block">
              <div class="text-xs opacity-70 mb-1">defaultEffort</div>
              <select
                :value="prefs.defaultClaudeEffort"
                @change="prefs.setDefaultClaudeEffort(($event.target as HTMLSelectElement).value)"
                class="w-full text-sm font-mono rounded border border-[var(--cw-border)]  bg-[var(--cw-panel-bg)] text-[var(--cw-text)]  px-2 py-1 focus:outline-none focus:border-[var(--cw-accent)] [&>option]:bg-white [&>option]:text-[var(--cw-text)] dark:[&>option]:bg-[var(--cw-panel-2)] dark:[&>option]:text-[var(--cw-text)]"
              >
                <option value="" disabled>未设置 — 跟随外部 ~/.claude/settings.json</option>
                <option v-for="e in CLAUDE_REASONING_EFFORTS" :key="e" :value="e">{{ e }}</option>
              </select>
            </label>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
            <label class="block">
              <div class="text-xs opacity-70 mb-1">codex defaultModel</div>
              <select
                :value="prefs.defaultCodexModel"
                @change="prefs.setDefaultCodexModel(($event.target as HTMLSelectElement).value)"
                class="w-full text-sm font-mono rounded border border-[var(--cw-border)]  bg-[var(--cw-panel-bg)] text-[var(--cw-text)]  px-2 py-1 focus:outline-none focus:border-[var(--cw-accent)] [&>option]:bg-white [&>option]:text-[var(--cw-text)] dark:[&>option]:bg-[var(--cw-panel-2)] dark:[&>option]:text-[var(--cw-text)]"
              >
                <option value="">(default · gpt-5.5)</option>
                <option v-for="m in CODEX_MODEL_CHOICES" :key="m" :value="m">{{ m }}</option>
              </select>
            </label>
            <label class="block">
              <div class="text-xs opacity-70 mb-1">codex defaultEffort</div>
              <select
                :value="prefs.defaultCodexEffort"
                @change="prefs.setDefaultCodexEffort(($event.target as HTMLSelectElement).value)"
                class="w-full text-sm font-mono rounded border border-[var(--cw-border)]  bg-[var(--cw-panel-bg)] text-[var(--cw-text)]  px-2 py-1 focus:outline-none focus:border-[var(--cw-accent)] [&>option]:bg-white [&>option]:text-[var(--cw-text)] dark:[&>option]:bg-[var(--cw-panel-2)] dark:[&>option]:text-[var(--cw-text)]"
              >
                <option value="">(default · medium)</option>
                <option v-for="e in CODEX_REASONING_EFFORTS" :key="e" :value="e">{{ e }}</option>
              </select>
            </label>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
            <label class="block">
              <div class="text-xs opacity-70 mb-1">codex defaultApproval</div>
              <select
                :value="prefs.defaultCodexApproval"
                @change="prefs.setDefaultCodexApproval(($event.target as HTMLSelectElement).value)"
                class="w-full text-sm font-mono rounded border border-[var(--cw-border)]  bg-[var(--cw-panel-bg)] text-[var(--cw-text)]  px-2 py-1 focus:outline-none focus:border-[var(--cw-accent)] [&>option]:bg-white [&>option]:text-[var(--cw-text)] dark:[&>option]:bg-[var(--cw-panel-2)] dark:[&>option]:text-[var(--cw-text)]"
              >
                <option value="">(default · full-access)</option>
                <option v-for="p in CODEX_APPROVAL_PRESETS" :key="p.key" :value="p.key">{{ p.label }}</option>
              </select>
            </label>
            <div class="block">
              <div class="text-xs opacity-70 mb-1">codex Fast by default</div>
              <label class="min-h-[30px] flex items-center gap-2 px-2 rounded border border-[var(--cw-border)] ">
                <input
                  type="checkbox"
                  :checked="prefs.defaultCodexServiceTier === 'priority'"
                  @change="prefs.setDefaultCodexFast(($event.target as HTMLInputElement).checked)"
                />
                <span class="text-sm">Use Fast service tier for supported models</span>
              </label>
            </div>
          </div>
        </section>

        <section class="mb-5">
          <div class="text-xs uppercase tracking-wider opacity-70 mb-1">Extended thinking</div>
          <p class="text-xs opacity-60 mb-2">
            Append a Claude Code thinking-trigger keyword to every outgoing prompt.
            Higher triggers spend more thinking budget per turn.
          </p>
          <select
            :value="prefs.thinkingTrigger"
            @change="prefs.setThinkingTrigger(($event.target as HTMLSelectElement).value as ThinkingTrigger)"
            class="text-sm rounded border border-[var(--cw-border)]  bg-[var(--cw-panel-bg)] text-[var(--cw-text)]  px-2 py-1 focus:outline-none focus:border-[var(--cw-accent)] [&>option]:bg-white [&>option]:text-[var(--cw-text)] dark:[&>option]:bg-[var(--cw-panel-2)] dark:[&>option]:text-[var(--cw-text)]"
          >
            <option value="">Off (no auto-append)</option>
            <option value="think">think (basic)</option>
            <option value="think hard">think hard (medium)</option>
            <option value="think harder">think harder (large)</option>
            <option value="ultrathink">ultrathink (max budget)</option>
          </select>
        </section>

        <section class="mb-5">
          <div class="text-xs uppercase tracking-wider opacity-70 mb-1">Auto re-title</div>
          <p class="text-xs opacity-60 mb-2">
            Periodically re-summarize long conversations to keep their sidebar
            title fresh. Sessions you renamed yourself are skipped — open
            Rename and click Auto to re-enable for one of those.
          </p>
          <label class="text-sm flex items-center gap-2 mb-2">
            <input
              type="checkbox"
              :checked="prefs.autoRetitleEnabled"
              @change="prefs.setAutoRetitleEnabled(($event.target as HTMLInputElement).checked)"
            />
            Enabled
          </label>
          <label class="text-sm flex items-center gap-2" :class="prefs.autoRetitleEnabled ? '' : 'opacity-50'">
            <span>Every</span>
            <!-- Freeform integer input (1+). Set to 1 if you want to test:
                 every completed turn fires a retitle. Default 10 in store. -->
            <input
              type="number"
              min="1"
              max="999"
              step="1"
              :value="prefs.autoRetitleEvery"
              :disabled="!prefs.autoRetitleEnabled"
              @change="prefs.setAutoRetitleEvery(Math.max(1, Math.min(999, Number(($event.target as HTMLInputElement).value) || 10)))"
              class="text-sm w-20 rounded border border-[var(--cw-border)]  bg-[var(--cw-panel-bg)] text-[var(--cw-text)]  px-2 py-1 focus:outline-none focus:border-[var(--cw-accent)]"
            />
            <span>completed turns</span>
          </label>
          <label class="block mt-3">
            <span class="text-sm">Title language</span>
            <select
              :value="prefs.titleLanguage"
              @change="prefs.setTitleLanguage(($event.target as HTMLSelectElement).value)"
              class="mt-1 block text-sm rounded border border-[var(--cw-border)]  bg-[var(--cw-panel-bg)] text-[var(--cw-text)]  px-2 py-1 focus:outline-none focus:border-[var(--cw-accent)]"
            >
              <option v-for="l in TITLE_LANGUAGE_CHOICES" :key="l.value" :value="l.value">{{ l.label }}</option>
            </select>
            <span class="block text-xs opacity-60 mt-1">Applies to new titles. Use “Re-title all” below to rewrite existing ones.</span>
          </label>
          <div class="mt-3 flex items-center gap-2">
            <button
              type="button"
              class="text-xs px-2 py-1 rounded border border-[var(--cw-border)]  hover:bg-[var(--cw-panel-2)]  disabled:opacity-40 disabled:cursor-not-allowed"
              :disabled="retitleAllInflight || retitleAllStats.eligible === 0"
              @click="doRetitleAll"
              :title="`Re-run the auto-titler on all ${retitleAllStats.eligible} auto-managed session${retitleAllStats.eligible === 1 ? '' : 's'}. Manually-named ones are skipped.`"
            >{{ retitleAllInflight ? "Starting…" : `Re-title all auto (${retitleAllStats.eligible})` }}</button>
            <span v-if="retitleAllStats.manual > 0" class="text-[11px] opacity-60">
              {{ retitleAllStats.manual }} manual session{{ retitleAllStats.manual === 1 ? '' : 's' }} will be skipped
            </span>
          </div>
        </section>

        <section class="mb-5">
          <div class="text-xs uppercase tracking-wider opacity-70 mb-1">Ad-hoc / scratch session</div>
          <p class="text-xs opacity-60 mb-2">
            Show the "Ad-hoc / scratch" shortcut in the New Session modal.
            When set, the directory below overrides the default
            <code class="text-[11px]">/tmp/&lt;user&gt;-scratch</code>; leave
            blank to use the default. Paths outside <code class="text-[11px]">/tmp/</code>
            must already exist (the backend won't auto-create them).
          </p>
          <label class="text-sm flex items-center gap-2 mb-2">
            <input
              type="checkbox"
              :checked="prefs.scratchEnabled"
              @change="prefs.setScratchEnabled(($event.target as HTMLInputElement).checked)"
            />
            Enabled
          </label>
          <label class="text-sm flex items-center gap-2" :class="prefs.scratchEnabled ? '' : 'opacity-50'">
            <span class="shrink-0">Directory</span>
            <input
              type="text"
              :value="prefs.scratchDir ?? ''"
              :disabled="!prefs.scratchEnabled"
              placeholder="(default: /tmp/<user>-scratch)"
              @change="prefs.setScratchDir((($event.target as HTMLInputElement).value).trim() || null)"
              class="flex-1 text-sm rounded border border-[var(--cw-border)]  bg-[var(--cw-panel-bg)] text-[var(--cw-text)]  px-2 py-1 focus:outline-none focus:border-[var(--cw-accent)]"
            />
          </label>
        </section>

        <section class="mb-5">
          <div class="text-xs uppercase tracking-wider opacity-70 mb-1">Enter key (desktop)</div>
          <label class="mr-3"><input type="radio" name="enter" :checked="ui.enterBehavior === 'send'" @change="ui.setEnterBehavior('send')" /> Send message</label>
          <label><input type="radio" name="enter" :checked="ui.enterBehavior === 'newline'" @change="ui.setEnterBehavior('newline')" /> Insert newline</label>
          <p class="text-[11px] opacity-60 mt-1">Shift+Enter always inserts a newline. Cmd/Ctrl+Enter always sends.</p>
        </section>

        <section class="mb-5">
          <div class="flex items-center justify-between">
            <button
              type="button"
              class="text-xs uppercase tracking-wider opacity-70 hover:opacity-100 flex items-center gap-1"
              @click="hiddenExpanded = !hiddenExpanded"
              :disabled="!hiddenItemsAll.length"
            >
              <span>{{ hiddenExpanded ? "▾" : "▸" }}</span>
              <span>Hidden sessions ({{ hiddenItemsAll.length }})</span>
            </button>
            <div class="flex items-center gap-3">
              <button
                v-if="hiddenExpanded && hiddenVisible.length > 1"
                class="text-xs underline opacity-70 hover:opacity-100"
                @click="unhideAllVisible"
                :title="`Unhide the ${hiddenVisible.length} session${hiddenVisible.length === 1 ? '' : 's'} shown below`"
              >Unhide all visible</button>
              <button
                v-if="hiddenItemsAll.length > 0"
                class="text-xs underline opacity-80 hover:opacity-100 text-[var(--cw-text)]  disabled:opacity-40 disabled:cursor-not-allowed"
                :disabled="purgeInflight"
                @click="purgeAllHidden"
                :title="`Permanently delete the jsonl files for all ${hiddenItemsAll.length} hidden session${hiddenItemsAll.length === 1 ? '' : 's'}. Cannot be undone.`"
              >{{ purgeInflight ? "Deleting…" : `Delete all (${hiddenItemsAll.length})` }}</button>
            </div>
          </div>
          <div v-if="hiddenExpanded" class="mt-2">
            <input
              v-if="hiddenItemsAll.length > 5"
              v-model="hiddenFilter"
              type="text"
              class="w-full text-sm rounded border border-[var(--cw-border)]  bg-transparent px-2 py-1 mb-2 focus:outline-none focus:border-[var(--cw-accent)]"
              placeholder="Filter by title or path…"
            />
            <p v-if="!hiddenItemsAll.length" class="text-xs opacity-60 italic">
              No hidden sessions. Use ⋯ → Hide on a row to hide one.
            </p>
            <ul v-else class="space-y-1 max-h-48 overflow-auto rounded border border-[var(--cw-border)] ">
              <li
                v-for="h in hiddenVisible"
                :key="h.id"
                class="flex items-center justify-between gap-2 text-sm px-2 py-1.5 hover:bg-[var(--cw-panel-2)] "
              >
                <div class="min-w-0 flex-1">
                  <div class="truncate" :title="h.title || h.id">
                    <template v-if="h.title">{{ h.title }}</template>
                    <template v-else><span class="font-mono">{{ h.id.slice(0, 8) }}…</span></template>
                  </div>
                  <div class="text-[11px] opacity-60 truncate" :title="h.cwdRaw">{{ h.cwdDisplay }}</div>
                </div>
                <button
                  class="text-xs underline opacity-70 hover:opacity-100 shrink-0"
                  @click="prefs.unhide(h.id)"
                >Unhide</button>
              </li>
            </ul>
            <p v-if="hiddenTruncated > 0" class="text-[11px] opacity-60 italic mt-1">
              +{{ hiddenTruncated }} more — refine the filter to narrow.
            </p>
          </div>
        </section>

        <section>
          <div class="text-xs uppercase tracking-wider opacity-70 mb-1">Groups</div>
          <ul class="space-y-1">
            <li v-for="(g, name) in prefs.groups" :key="name" class="flex items-center justify-between text-sm">
              <span>{{ name }} ({{ g.sessions.length }})</span>
              <button class="text-xs underline" @click="deleteGroup(name as unknown as string)">Delete</button>
            </li>
          </ul>
          <div class="flex gap-2 mt-2">
            <input v-model="newGroup" class="flex-1 rounded border border-[var(--cw-border)]  bg-transparent px-2 py-1 text-sm" placeholder="New group name" />
            <button class="px-3 py-1 rounded border" @click="addGroup">+ New group</button>
          </div>
        </section>
      </div>
    </div>
  </Teleport>
</template>
