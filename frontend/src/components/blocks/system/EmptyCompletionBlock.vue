<script setup lang="ts">
import { computed, ref } from "vue";
import { sendPrompt } from "../../../api/sessions.js";
import { useNotificationsStore } from "../../../stores/notifications.js";
import { useSessionsStore } from "../../../stores/sessions.js";

const props = defineProps<{
  node: { record: Record<string, unknown> };
  sessionId: string;
}>();

const RECOVERY_PROMPT = "继续完成刚才未结束的任务。先检查已有工具结果和当前工作区状态，不要重复已完成的操作，然后给出最终结果。";

const notifications = useNotificationsStore();
const sessions = useSessionsStore();
const sending = ref(false);
const sent = ref(false);
const running = computed(() => sessions.statusBySession[props.sessionId] === "running");
const disabled = computed(() => sending.value || sent.value || running.value);
const buttonLabel = computed(() => {
  if (sending.value) return "正在继续…";
  if (sent.value || running.value) return "已继续";
  return "继续本轮";
});

async function retryTurn() {
  if (disabled.value) return;
  sending.value = true;
  const uuid = typeof props.node.record.uuid === "string" ? props.node.record.uuid : "unknown";
  try {
    await sendPrompt(props.sessionId, RECOVERY_PROMPT, undefined, `recover:${uuid}`);
    sent.value = true;
  } catch (error) {
    notifications.pushError(error instanceof Error ? error.message : String(error), { title: "继续失败" });
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <div class="cw-empty-completion mx-3 my-2 px-3.5 py-3 md:mx-4" role="alert" aria-label="本轮未生成最终回复">
    <div class="flex items-start gap-3">
      <span class="cw-empty-completion-icon mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="h-[17px] w-[17px]">
          <path d="M12 8v4" />
          <path d="M12 16h.01" />
          <circle cx="12" cy="12" r="9" />
        </svg>
      </span>
      <div class="min-w-0 flex-1">
        <div class="text-sm font-semibold leading-snug text-[var(--cw-text)]">本轮未生成最终回复</div>
        <div class="mt-1 text-xs leading-relaxed text-[var(--cw-muted)]">工具执行可能已经完成，但 Codex 在收尾前结束。继续时会先核对现状，避免重复已完成的操作。</div>
      </div>
      <button
        type="button"
        class="min-h-9 shrink-0 rounded-lg bg-[var(--cw-accent)] px-3 text-xs font-semibold text-[var(--cw-accent-text)] transition active:opacity-75 [@media(hover:hover)]:hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cw-focus-ring)] disabled:cursor-default disabled:opacity-55"
        :disabled="disabled"
        @click="retryTurn"
      >{{ buttonLabel }}</button>
    </div>
  </div>
</template>

<style scoped>
.cw-empty-completion {
  border: 1px solid color-mix(in srgb, var(--cw-danger) 24%, var(--cw-border));
  border-radius: 14px;
  background: color-mix(in srgb, var(--cw-danger) 6%, var(--cw-panel-bg));
}
.cw-empty-completion-icon {
  color: var(--cw-danger);
  background: color-mix(in srgb, var(--cw-danger) 11%, transparent);
}
@media (max-width: 480px) {
  .cw-empty-completion > div {
    align-items: center;
    flex-wrap: wrap;
  }
  .cw-empty-completion button {
    width: 100%;
  }
}
</style>
