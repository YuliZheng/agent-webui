<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { connected as wsConnected, wake as wsWake } from "../api/ws.js";
import { useSessionsStore } from "../stores/sessions.js";

type Diagnosis = "connecting" | "relay-missing" | "upstream-missing" | "direct-missing";

const sessions = useSessionsStore();
const online = ref(typeof navigator === "undefined" ? true : navigator.onLine);
const diagnosis = ref<Diagnosis>("connecting");
const retrying = ref(false);
let diagnosisTimer: ReturnType<typeof setTimeout> | null = null;
let diagnosisGeneration = 0;

const isRelayLoopback = computed(() => {
  if (typeof location === "undefined") return false;
  const host = location.hostname.toLowerCase();
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  return loopback && (location.port === "38484" || location.port === "38485");
});

const syncing = computed(() => wsConnected.value && sessions.syncInFlight > 0);
const syncFailed = computed(() => (
  wsConnected.value
  && sessions.syncInFlight === 0
  && !!sessions.lastError
));
const visible = computed(() => !wsConnected.value || syncing.value || syncFailed.value);
const active = computed(() => online.value && (retrying.value || diagnosis.value === "connecting" || syncing.value));
const canRetry = computed(() => online.value && !active.value);

const title = computed(() => {
  if (!online.value) return "手机当前没有网络";
  if (syncing.value) return "正在同步会话…";
  if (syncFailed.value) return "会话同步失败";
  if (retrying.value || diagnosis.value === "connecting") return "正在连接电脑…";
  if (diagnosis.value === "relay-missing") return "Tailnet Relay 没有响应";
  if (diagnosis.value === "upstream-missing") return "转接器正常，但还没连到电脑";
  return "暂时没有连到电脑";
});

const detail = computed(() => {
  const cached = sessions.loaded ? "下方显示的是上次保存的会话。" : "";
  if (!online.value) return `请先恢复手机网络。${cached}`;
  if (syncing.value) return cached || "正在获取最新会话，请稍候。";
  if (syncFailed.value) return `${sessions.lastError} ${cached}`.trim();
  if (retrying.value || diagnosis.value === "connecting") {
    return cached || "正在检查手机与电脑之间的连接。";
  }
  if (diagnosis.value === "relay-missing") {
    return `请打开工作资料中带公文包标记的 Tailnet Relay。${cached}`;
  }
  if (diagnosis.value === "upstream-missing") {
    return `请检查工作资料里的 Tailscale，以及电脑上的 Agent WebUI。${cached}`;
  }
  return `请检查 Tailscale 和电脑上的 Agent WebUI。${cached}`;
});

function clearDiagnosisTimer() {
  if (diagnosisTimer) clearTimeout(diagnosisTimer);
  diagnosisTimer = null;
}

function scheduleDiagnosis(delay = 2_800) {
  clearDiagnosisTimer();
  diagnosis.value = "connecting";
  diagnosisTimer = setTimeout(() => { void diagnoseConnection(); }, delay);
}

async function probeRelay(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_500);
  try {
    const response = await fetch("/health", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const body = await response.json() as { status?: unknown };
    return body.status === "running";
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function diagnoseConnection() {
  clearDiagnosisTimer();
  const generation = ++diagnosisGeneration;
  online.value = typeof navigator === "undefined" ? true : navigator.onLine;
  if (!online.value || wsConnected.value) return;
  if (!isRelayLoopback.value) {
    diagnosis.value = "direct-missing";
    return;
  }
  const relayRunning = await probeRelay();
  if (generation !== diagnosisGeneration || wsConnected.value) return;
  diagnosis.value = relayRunning ? "upstream-missing" : "relay-missing";
}

async function retryConnection() {
  if (retrying.value) return;
  retrying.value = true;
  diagnosis.value = "connecting";
  diagnosisGeneration += 1;
  wsWake({ forceReconnect: true });
  try {
    await sessions.fetchAll();
  } finally {
    retrying.value = false;
    if (!wsConnected.value) await diagnoseConnection();
  }
}

function onOnline() {
  online.value = true;
  wsWake({ forceReconnect: true });
  scheduleDiagnosis(2_000);
}

function onOffline() {
  online.value = false;
  clearDiagnosisTimer();
}

watch(wsConnected, (isConnected) => {
  diagnosisGeneration += 1;
  if (isConnected) clearDiagnosisTimer();
  else if (online.value) scheduleDiagnosis();
});

onMounted(() => {
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  if (!wsConnected.value && online.value) scheduleDiagnosis();
});

onBeforeUnmount(() => {
  clearDiagnosisTimer();
  diagnosisGeneration += 1;
  window.removeEventListener("online", onOnline);
  window.removeEventListener("offline", onOffline);
});
</script>

<template>
  <Transition name="cw-home-connection">
    <section
      v-if="visible"
      class="cw-home-connection flex min-h-[58px] shrink-0 items-center gap-2.5 px-3 py-2"
      role="status"
      aria-live="polite"
    >
      <span class="cw-home-connection-icon flex h-7 w-7 shrink-0 items-center justify-center rounded-full" aria-hidden="true">
        <svg
          v-if="active"
          class="cw-home-connection-spinner h-[15px] w-[15px]"
          viewBox="0 0 20 20"
          fill="none"
        >
          <circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="2.25" opacity=".22" />
          <path d="M10 3a7 7 0 0 1 6.3 3.95" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" />
        </svg>
        <svg v-else class="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="10" cy="10" r="7" />
          <path d="M10 6.5v4.2M10 13.7h.01" />
        </svg>
      </span>
      <div class="min-w-0 flex-1">
        <p class="text-[13px] font-medium leading-[18px] text-[var(--cw-text)]">{{ title }}</p>
        <p class="mt-0.5 text-[11px] leading-[15px] text-[var(--cw-muted)]">{{ detail }}</p>
      </div>
      <button
        v-if="canRetry"
        type="button"
        class="cw-home-connection-retry -mr-1 flex min-h-10 shrink-0 items-center rounded-md px-2 text-[12px] font-medium text-[var(--cw-accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cw-accent)] disabled:opacity-50"
        :disabled="retrying"
        @click="retryConnection"
      >
        重新连接
      </button>
    </section>
  </Transition>
</template>

<style scoped>
.cw-home-connection {
  border-bottom: 1px solid color-mix(in srgb, var(--cw-border) 78%, transparent);
  background: color-mix(in srgb, var(--cw-panel-2) 62%, var(--cw-panel-bg));
}

.cw-home-connection-icon {
  color: var(--cw-accent);
  background: color-mix(in srgb, var(--cw-accent) 11%, transparent);
}

.cw-home-connection-spinner {
  animation: cw-home-connection-spin 0.9s linear infinite;
}

.cw-home-connection-retry:active {
  background: color-mix(in srgb, var(--cw-accent) 10%, transparent);
}

.cw-home-connection-enter-active,
.cw-home-connection-leave-active {
  transition: transform 180ms ease-out, opacity 140ms ease-out;
}

.cw-home-connection-enter-from,
.cw-home-connection-leave-to {
  transform: translateY(-4px);
  opacity: 0;
}

.cw-home-connection-enter-to,
.cw-home-connection-leave-from {
  transform: translateY(0);
  opacity: 1;
}

@keyframes cw-home-connection-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .cw-home-connection-spinner { animation-duration: 1.8s; }
  .cw-home-connection-enter-active,
  .cw-home-connection-leave-active { transition: none; }
}
</style>
