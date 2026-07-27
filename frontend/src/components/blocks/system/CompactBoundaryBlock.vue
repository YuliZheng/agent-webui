<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ node: { record: Record<string, unknown> } }>();

// Real auto-compact compactMetadata shape (verified against jsonl):
//   { trigger, preTokens, postTokens, durationMs, preservedMessages }
// There is NO `messagesSummarized` field — the old block read it and always
// rendered "0 messages summarized". We surface the meaningful signals only:
// token reduction (how much context was reclaimed), how long it took, and how
// many recent messages survived the cut. Every segment is guarded so a record
// missing a field just drops that segment rather than rendering a bogus 0.
const meta = computed(() => (props.node.record as any).compactMetadata ?? {});
const trigger = computed(() => String(meta.value.trigger ?? ""));
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
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

const label = computed(() => {
  const verb = trigger.value === "auto" ? "auto-compacted" : "compacted";
  const parts = [`Context ${verb}`];
  // Only show the reduction arrow when BOTH endpoints are known — a lone
  // "432k → 0" would misreport the result.
  if (ok(pre.value) && ok(post.value)) parts.push(`${fmt(pre.value)} → ${fmt(post.value)} tokens`);
  // Partial record (pre but no post): show the pre-compaction size alone rather
  // than a misleading "→ 0".
  else if (ok(pre.value)) parts.push(`${fmt(pre.value)} tokens`);
  if (ok(durationMs.value)) parts.push(fmtDuration(durationMs.value));
  if (ok(kept.value)) parts.push(`${kept.value} kept`);
  return parts.join(" · ");
});
</script>

<template>
  <div class="cw-compact-boundary flex items-center gap-3 px-4 py-2 my-1 select-none text-[11px]">
    <span class="cw-compact-boundary-rule flex-1 h-px" />
    <span class="cw-compact-boundary-label whitespace-nowrap tracking-wide">🗜 {{ label }}</span>
    <span class="cw-compact-boundary-rule flex-1 h-px" />
  </div>
</template>
