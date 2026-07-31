<script setup lang="ts">
import { computed, ref } from "vue";
import { useLightboxStore } from "../../../stores/lightbox.js";
import { extractToolResultImages } from "../../../util/tool-result-images.js";

const props = defineProps<{ value: unknown; isError?: boolean; hideImages?: boolean }>();

interface Display { text: string; lines: number; chars: number }

// Base64 image blocks embedded in tool_result content arrays:
//   { type: "image", source: { type: "base64", media_type, data } }
// Rendered as data-URL thumbnails; entries missing that shape fall back to
// the literal "[image]" text in the body.
const images = computed(() => extractToolResultImages(props.value));
const visibleImages = computed(() => props.hideImages ? [] : images.value);

const display = computed<Display>(() => {
  const v = props.value;
  let text = "";
  if (typeof v === "string") text = v;
  else if (Array.isArray(v)) {
    text = v.map((b: any) => {
      if (b?.type === "text") return b.text ?? "";
      if (b?.type === "image") {
        // Parseable images render as thumbnails below; keep "[image]" only
        // for malformed entries.
        return b.source?.type === "base64" && typeof b.source.data === "string" ? "" : "[image]";
      }
      return JSON.stringify(b, null, 2);
      // Only drop the "" placeholders from parseable images — filter(Boolean)
      // would also eat a text block whose entire text is "0".
    }).filter((t) => t !== "").join("\n");
  } else {
    text = JSON.stringify(v, null, 2);
  }
  return { text, lines: text.split("\n").length, chars: text.length };
});

const expanded = ref(props.isError === true || images.value.length > 0);
// Images count toward collapsing too: an image-only result has text="" and
// would otherwise paint every base64 thumbnail expanded on load.
const collapsedByDefault = computed(() => display.value.lines > 10 || display.value.chars > 1000);
const open = computed({
  get() { return expanded.value || !collapsedByDefault.value; },
  set(v) { expanded.value = v; },
});

const lightbox = useLightboxStore();
</script>

<template>
  <div :class="isError ? 'border-l-2 border-[var(--cw-danger)] pl-2' : 'pl-2'">
    <div class="text-xs opacity-70 cursor-pointer" @click="expanded = !expanded">
      ╰─ Result{{ display.text ? ` · ${display.lines} lines` : "" }}{{ images.length ? ` · ${images.length} image${images.length > 1 ? "s" : ""}` : "" }}{{ isError ? " · error" : "" }} {{ open ? "▾" : "▸" }}
    </div>
    <template v-if="open">
      <pre v-if="display.text" class="whitespace-pre-wrap text-xs mt-1">{{ display.text }}</pre>
      <div v-if="visibleImages.length" class="flex flex-wrap gap-2 mt-1">
        <button
          v-for="(img, i) in visibleImages"
          :key="i"
          type="button"
          class="block rounded overflow-hidden border border-[var(--cw-border)]  bg-[var(--cw-panel-bg)] hover:opacity-90 active:opacity-80 transition cursor-zoom-in"
          @click.stop="lightbox.open(img.url, '[image]')"
        >
          <img :src="img.url" alt="[image]" loading="lazy" decoding="async" class="block max-h-[200px] object-contain" />
        </button>
      </div>
    </template>
  </div>
</template>
