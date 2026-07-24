<script setup lang="ts">
import { computed, ref } from "vue";
import { useUiStore } from "@/stores/ui";

const props = defineProps<{ value: unknown; isError?: boolean }>();
interface Display { text: string; lines: number; chars: number }
const ui = useUiStore();

const images = computed(() => {
  if (!Array.isArray(props.value)) return [] as string[];
  return props.value.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const item = block as { type?: unknown; source?: { type?: unknown; media_type?: unknown; data?: unknown }; url?: unknown };
    if (item.type !== "image") return [];
    if (typeof item.url === "string") return [item.url];
    if (item.source?.type === "base64" && typeof item.source.data === "string") {
      return [`data:${String(item.source.media_type ?? "image/png")};base64,${item.source.data}`];
    }
    return [];
  });
});
const display = computed<Display>(() => {
  let text = "";
  if (typeof props.value === "string") text = props.value;
  else if (Array.isArray(props.value)) {
    text = props.value.map((block) => {
      if (block && typeof block === "object") {
        const item = block as { type?: unknown; text?: unknown; source?: { type?: unknown; data?: unknown } };
        if (item.type === "text") return typeof item.text === "string" ? item.text : "";
        if (item.type === "image") return item.source?.type === "base64" && typeof item.source.data === "string" ? "" : "[image]";
      }
      return JSON.stringify(block, null, 2);
    }).filter(Boolean).join("\n");
  } else if (props.value !== undefined) {
    text = JSON.stringify(props.value, null, 2);
  }
  return { text, lines: text ? text.split("\n").length : 0, chars: text.length };
});
const expanded = ref(props.isError === true);
const collapsedByDefault = computed(() => display.value.lines > 10 || display.value.chars > 1000 || images.value.length > 0);
const open = computed(() => expanded.value || !collapsedByDefault.value);
</script>

<template>
  <div :class="isError ? 'cw-tool-result cw-tool-result-error' : 'cw-tool-result'">
    <button type="button" class="cw-tool-result-toggle" @click="expanded = !expanded">
      ╰─ Result{{ display.text ? ` · ${display.lines} lines` : "" }}{{ images.length ? ` · ${images.length} image${images.length > 1 ? "s" : ""}` : "" }}{{ isError ? " · error" : "" }} {{ open ? "▾" : "▸" }}
    </button>
    <template v-if="open">
      <pre v-if="display.text" class="cw-tool-result-text">{{ display.text }}</pre>
      <div v-if="images.length" class="cw-tool-result-images">
        <button v-for="(image, index) in images" :key="index" type="button" @click.stop="ui.lightboxUrl = image">
          <img :src="image" alt="[image]" loading="lazy" decoding="async" />
        </button>
      </div>
    </template>
  </div>
</template>
