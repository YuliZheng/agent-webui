<script setup lang="ts">
import { useUiStore } from "@/stores/ui";
import { useInteractionsStore } from "@/stores/sessions";
import { answerInteractionOnce, interactionQuestions } from "@/util/interactions";
const ui = useUiStore();
const interactions = useInteractionsStore();
function interactionFor(sessionId?: string, requestId?: string) { return interactions.items.find((item) => item.sessionId === sessionId && item.requestId === requestId); }
function isSimplePermission(sessionId?: string, requestId?: string) { const item = interactionFor(sessionId, requestId); return item?.kind === "permission" && !interactionQuestions(item).length && !item.choices?.length && !item.options?.length; }
function openToast(toast: { id: string; sessionId?: string }) {
  if (!toast.sessionId) return;
  ui.requestSessionOpen(toast.sessionId);
  ui.dismissToast(toast.id);
}
async function respond(sessionId: string | undefined, requestId: string | undefined, answer: unknown) {
  const item = interactionFor(sessionId, requestId); if (!item) return;
  try { await answerInteractionOnce(item, answer, (target, value) => interactions.respond(target, value)); ui.dismissInteractionToast(item.sessionId, item.requestId); }
  catch (error) { ui.toast(error instanceof Error ? error.message : "Could not answer interaction", "error"); }
}
</script>
<template><Teleport to="body">
  <div class="cw-toast-stack"><div
    v-for="toast in ui.toasts"
    :key="toast.id"
    class="cw-toast"
    :class="[toast.kind, { sticky: toast.sticky, actionable: !!toast.sessionId && !toast.sticky }]"
    :role="toast.sessionId && !toast.sticky ? 'button' : undefined"
    :tabindex="toast.sessionId && !toast.sticky ? 0 : undefined"
    @click="openToast(toast)"
    @keydown.enter="openToast(toast)"
    @keydown.space.prevent="openToast(toast)"
  >
    <span>{{ toast.message }}</span>
    <div v-if="toast.sticky" class="cw-toast-actions" @click.stop @keydown.stop>
      <button v-if="toast.sessionId" @click="openToast(toast)">Open</button>
      <template v-if="isSimplePermission(toast.sessionId, toast.requestId)">
        <button @click="respond(toast.sessionId, toast.requestId, true)">Allow</button><button @click="respond(toast.sessionId, toast.requestId, false)">Deny</button>
      </template>
      <button title="Dismiss" @click="ui.dismissToast(toast.id)">×</button>
    </div>
  </div></div>
  <div v-if="ui.lightboxUrl" class="cw-modal-scrim cw-lightbox" @click="ui.lightboxUrl = null"><img :src="ui.lightboxUrl" /></div>
  <div v-if="ui.previewUrl" class="cw-modal-scrim"><div class="cw-preview-modal"><button @click="ui.previewUrl = null">Close</button><iframe :src="ui.previewUrl" sandbox="allow-scripts" /></div></div>
  <div v-if="ui.localFile" class="cw-modal-scrim" @click.self="ui.localFile = null"><section class="cw-source-modal"><header>{{ ui.localFile.path }}<button @click="ui.localFile = null">Close</button></header><pre>{{ ui.localFile.content }}</pre></section></div>
</Teleport></template>
