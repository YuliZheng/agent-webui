<script setup lang="ts">
import { computed, ref } from "vue";
import { renderMarkdown } from "../../../render/markdown.js";

const props = defineProps<{ node: { record: Record<string, unknown> } }>();

// Real auto-compact compactMetadata shape (verified against jsonl):
//   { trigger, preTokens, postTokens, durationMs, preservedMessages }
// There is NO `messagesSummarized` field — the old block read it and always
// rendered "0 messages summarized". We surface the meaningful signals only:
// token reduction (how much context was reclaimed), how long it took, and how
// many recent messages survived the cut. Every segment is guarded so a record
// missing a field just drops that segment rather than rendering a bogus 0.
const meta = computed(() => (props.node.record as any).compactMetadata ?? {});
const summary = computed(() => {
  const value = props.node.record.compactSummary;
  return typeof value === "string" ? value.trim() : "";
});
const open = ref(false);
const summaryHtml = computed(() => renderMarkdown(summary.value));
const summaryId = computed(() => {
  const uuid = typeof props.node.record.uuid === "string" ? props.node.record.uuid : "unknown";
  return `compact-summary-${uuid.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
});
const pre = computed(() => Number(meta.value.preTokens));
const post = computed(() => Number(meta.value.postTokens));
const durationMs = computed(() => Number(meta.value.durationMs));
const kept = computed(() => {
  const pm = meta.value.preservedMessages;
  const n = pm?.allUuids?.length ?? pm?.uuids?.length;
  return Number(n);
});

const ok = (n: number) => Number.isFinite(n) && n > 0;

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

const detail = computed(() => {
  const parts: string[] = [];
  // Only show the reduction arrow when BOTH endpoints are known — a lone
  // "432k → 0" would misreport the result.
  if (ok(pre.value) && ok(post.value)) parts.push(`${fmt(pre.value)} → ${fmt(post.value)}`);
  // Partial record (pre but no post): show the pre-compaction size alone rather
  // than a misleading "→ 0".
  else if (ok(pre.value)) parts.push(`整理前 ${fmt(pre.value)}`);
  if (ok(durationMs.value)) parts.push(fmtDuration(durationMs.value));
  if (ok(kept.value)) parts.push(`保留 ${kept.value} 条最近消息`);
  if (summary.value) parts.push("点按查看压缩摘要");
  return parts.length
    ? parts.join(" · ")
    : "摘要已保留给后续对话，但当前没有可展示的明文内容";
});
</script>

<template>
  <div class="cw-compact-boundary mx-3 my-2 overflow-hidden select-none md:mx-4" role="status" aria-label="上下文已整理">
    <component
      :is="summary ? 'button' : 'div'"
      :type="summary ? 'button' : undefined"
      class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
      :class="summary ? 'transition [@media(hover:hover)]:hover:bg-[color-mix(in_srgb,var(--cw-text)_4%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--cw-focus-ring)]' : ''"
      :aria-expanded="summary ? open : undefined"
      :aria-controls="summary ? summaryId : undefined"
      @click="summary && (open = !open)"
    >
      <span class="cw-compact-boundary-icon flex h-7 w-7 shrink-0 items-center justify-center rounded-lg" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4">
          <path d="M8 3v3a2 2 0 0 1-2 2H3" />
          <path d="M16 3v3a2 2 0 0 0 2 2h3" />
          <path d="M8 21v-3a2 2 0 0 0-2-2H3" />
          <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
          <path d="M8 12h8" />
        </svg>
      </span>
      <span class="min-w-0 flex-1">
        <span class="block text-xs font-semibold leading-snug text-[var(--cw-text)]">上下文已整理</span>
        <span class="cw-compact-boundary-label mt-0.5 block text-[11px] leading-snug text-[var(--cw-muted)]">{{ detail }}</span>
      </span>
      <svg v-if="summary" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4 shrink-0 text-[var(--cw-muted)] transition-transform" :class="open ? 'rotate-90' : ''" aria-hidden="true">
        <path d="m7 4 6 6-6 6" />
      </svg>
    </component>
    <div
      v-if="summary && open"
      :id="summaryId"
      class="max-h-96 select-text overflow-y-auto border-t border-[var(--cw-border)] px-3 py-3 md:px-4"
      role="region"
      aria-label="压缩摘要"
    >
      <div class="prose prose-sm dark:prose-invert max-w-none break-words" v-html="summaryHtml" />
    </div>
  </div>
</template>
