<script setup lang="ts">
import type { AgentKind } from "@/types";
import AgentLogo from "./AgentLogo.vue";

withDefaults(defineProps<{
  agent: AgentKind;
  size?: number;
}>(), {
  size: 28,
});
</script>

<template>
  <span
    class="cw-agent-badge"
    :class="{
      'cw-agent-badge-claude': agent === 'claude',
      'cw-agent-badge-codex': agent === 'codex',
    }"
    :style="{ width: `${size}px`, height: `${size}px` }"
    :title="agent === 'codex' ? 'Codex' : 'Claude Code'"
  >
    <AgentLogo :agent="agent" />
  </span>
</template>
