<script setup lang="ts">
import { computed } from "vue";
import { parseTaskNotification } from "../../parser/task-notification.js";

// Background-task completion notice. claude-code injects these as a user-turn
// whose content is a `<task-notification>…</task-notification>` XML blob (from
// a `Bash run_in_background` task settling). Rendered raw it's an ugly wall of
// task-id / tool-use-id / output-file tags; here we pull out just the
// human-meaningful status + summary and show a compact chip, matching the
// queue-chip styling used elsewhere in the message list.
const props = defineProps<{ node: { record: Record<string, unknown> } }>();

const info = computed(() => {
  const rec = props.node.record as Record<string, unknown>;
  const nested = (rec.message as { content?: unknown } | undefined)?.content;
  const content =
    typeof nested === "string"
      ? nested
      : typeof rec.content === "string"
        ? (rec.content as string)
        : "";
  return parseTaskNotification(content);
});
</script>

<template>
  <!-- Same quiet collapsed-row recipe as the "▶ N tool calls" header
       (.cw-task-notification mirrors .cw-tool-run-header in tailwind.css) —
       completion notices are one uniform low-key row, not a bright banner.
       Failures keep red text so errors still stand out. -->
  <div
    class="cw-task-notification mx-4 my-0.5"
    :class="info.failed ? 'cw-task-notification-failed text-[var(--cw-danger)]' : ''"
    :title="info.outputFile || undefined"
  >
    <span class="shrink-0">{{ info.failed ? '⚠' : '✓' }}</span>
    <span class="flex-1 min-w-0 truncate">{{ info.summary || 'Background task finished' }}</span>
    <span class="shrink-0 text-[10px] uppercase tracking-wide opacity-60">background</span>
  </div>
</template>
