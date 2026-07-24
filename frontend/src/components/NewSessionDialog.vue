<script setup lang="ts">
import { ref } from "vue";
import type { AgentKind } from "@/types";
const emit = defineEmits<{ close: []; create: [data: { cwd: string; agent: AgentKind; prompt: string }] }>();
const cwd = ref(""); const agent = ref<AgentKind>("claude"); const prompt = ref("");
</script>
<template><Teleport to="body"><div class="cw-modal-scrim" @click.self="emit('close')"><form class="cw-modal" @submit.prevent="emit('create', { cwd, agent, prompt })"><h2>New session</h2><label>Working directory<input v-model="cwd" required placeholder="~/projects/my-app" /></label><label>Agent<select v-model="agent"><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label><label>First prompt (optional)<textarea v-model="prompt" rows="4" /></label><div class="cw-modal-actions"><button type="button" @click="emit('close')">Cancel</button><button class="primary">Create</button></div></form></div></Teleport></template>
