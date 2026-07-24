<script setup lang="ts">
import { computed, ref } from "vue";
import type { Interaction, NormalizedBlock } from "@/types";
import { useUiStore } from "@/stores/ui";
import { mainSocket } from "@/api/ws";
import { toolSummary } from "@/util/tool-summary";
import InteractionTray from "@/components/InteractionTray.vue";
import ToolResult from "./ToolResult.vue";

const props = withDefaults(defineProps<{ block: NormalizedBlock; interactions?: Interaction[]; embedded?: boolean }>(), {
  interactions: () => [],
  embedded: false
});
const open = ref(false);
const ui = useUiStore();
const input = computed(() => props.block.toolInput && typeof props.block.toolInput === "object" ? props.block.toolInput as Record<string, unknown> : {});
const sourcePath = computed(() => [input.value.file_path, input.value.path, input.value.filename].find((value) => typeof value === "string") as string | undefined);
const result = computed(() => props.block.toolResult && typeof props.block.toolResult === "object" ? props.block.toolResult as Record<string, unknown> : {});
const previewUrl = computed(() => [result.value.previewUrl, result.value.url].find((value) => typeof value === "string" && value.startsWith("/preview/")) as string | undefined);
const imageUrl = computed(() => [result.value.imageUrl, result.value.image, result.value.url].find((value) => typeof value === "string" && (/^data:image\//.test(value) || /^\/api\/(images|codex-image)/.test(value))) as string | undefined);
const header = computed(() => `▶ ${toolSummary(props.block.toolName, props.block.toolInput)}`);

async function openSource() {
  if (!sourcePath.value) return;
  const data = await mainSocket.request<Record<string, unknown>>("read-local-file", { path: sourcePath.value });
  ui.localFile = {
    path: String(data.path ?? sourcePath.value),
    content: String(data.content ?? data.text ?? ""),
    line: typeof data.line === "number" ? data.line : undefined
  };
}
</script>

<template>
  <div class="cw-block cw-tool-call px-4 py-1 border-l-2 border-gray-300 dark:border-gray-700 opacity-80" :class="{ 'cw-tool-call-error': block.isError, 'cw-tool-call-embedded': embedded }">
    <button type="button" class="cw-tool-call-header text-xs font-mono cursor-pointer" :aria-expanded="open" @click="open = !open">{{ header }}</button>
    <InteractionTray v-if="interactions.length" :items="interactions" inline />
    <div v-if="sourcePath || previewUrl || imageUrl" class="cw-tool-links">
      <button v-if="sourcePath" @click="openSource">⌘ Source</button>
      <button v-if="previewUrl" @click="ui.previewUrl = previewUrl">↗ Preview</button>
      <button v-if="imageUrl" @click="ui.lightboxUrl = imageUrl">▧ Image</button>
    </div>
    <div v-if="open" class="cw-tool-body">
      <pre class="cw-tool-input text-xs whitespace-pre-wrap bg-gray-50 dark:bg-gray-900 p-2 rounded-sm">{{ JSON.stringify(block.toolInput, null, 2) }}</pre>
      <ToolResult v-if="block.toolResult !== undefined" :value="block.toolResult" :is-error="block.isError" />
      <div v-if="block.children?.length" class="cw-subagent-timeline">
        <strong>Subagent timeline</strong>
        <section v-for="child in block.children" :key="child.key">
          <b>{{ child.toolName || child.kind }}</b>
          <div v-if="child.text">{{ child.text }}</div>
          <pre v-if="child.toolInput != null">{{ JSON.stringify(child.toolInput, null, 2) }}</pre>
        </section>
      </div>
    </div>
  </div>
</template>
