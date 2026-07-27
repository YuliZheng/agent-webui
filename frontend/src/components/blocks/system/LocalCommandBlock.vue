<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ node: { record: Record<string, unknown> } }>();

type Parsed =
  | { kind: "command"; name: string; args: string }
  | { kind: "stdout"; text: string }
  | { kind: "stderr"; text: string }
  | { kind: "raw"; text: string };

function pick(content: string, tag: string): string | null {
  const m = content.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m?.[1] ?? null;
}

const parsed = computed<Parsed>(() => {
  // System path (type=system, subtype=local_command): content is on the record.
  // User-shape path (type=user with <command-name>/<local-command-stdout>
  // content — emitted when the CLI processes a TUI slash-command, e.g. our
  // set_model control_request): content lives at message.content. Try both.
  const rec = props.node.record as Record<string, unknown>;
  const direct = typeof rec.content === "string" ? rec.content : "";
  const nested = ((rec.message as { content?: unknown } | undefined)?.content);
  const content = direct || (typeof nested === "string" ? nested : "");
  const name = pick(content, "command-name");
  if (name !== null) {
    return { kind: "command", name: name.trim(), args: (pick(content, "command-args") ?? "").trim() };
  }
  const stdout = pick(content, "local-command-stdout");
  if (stdout !== null) return { kind: "stdout", text: stdout };
  const stderr = pick(content, "local-command-stderr");
  if (stderr !== null) return { kind: "stderr", text: stderr };
  return { kind: "raw", text: content };
});
</script>
<template>
  <div v-if="parsed.kind === 'command'" class="px-4 py-1 text-xs opacity-60 font-mono">
    {{ parsed.name }}{{ parsed.args ? ' ' + parsed.args : '' }}
  </div>
  <div v-else-if="parsed.kind === 'stderr'"
       class="px-4 py-1 text-xs font-mono whitespace-pre-wrap text-[var(--cw-text)]  opacity-80">{{ parsed.text }}</div>
  <div v-else class="px-4 py-1 text-xs font-mono whitespace-pre-wrap opacity-60">{{ parsed.text }}</div>
</template>
