<script setup lang="ts">
import { computed, ref } from "vue";
import type { ToolPair } from "../../../parser/group.js";
import { toolSummary } from "../../../parser/tool-summaries.js";
import { useUiStore } from "../../../stores/ui.js";
import { usePendingInteractionsStore } from "../../../stores/pending-interactions.js";
import ToolResult from "./ToolResult.vue";
import WorkflowProgressBlock from "./WorkflowProgressBlock.vue";
import EditDiff from "./EditDiff.vue";
import SubagentBlock from "../SubagentBlock.vue";
import PreviewChip from "./PreviewChip.vue";
import AskUserQuestionInteractive from "./AskUserQuestionInteractive.vue";
import InteractionCard from "../../InteractionCard.vue";

const props = defineProps<{
  pair: ToolPair;
  hideResultImages?: boolean;
  expanded?: boolean | undefined;
}>();
const emit = defineEmits<{ (event: "update:expanded", value: boolean): void }>();
const localOpen = ref(false);
const open = computed({
  get: () => props.expanded ?? localOpen.value,
  set: (value: boolean) => {
    localOpen.value = value;
    emit("update:expanded", value);
  },
});
const header = () => `▶ ${toolSummary(props.pair.use.name, props.pair.use.input)}`;

const isErr = (v: unknown) => Array.isArray(v) ? false : typeof v === "object" && v !== null && (v as any).is_error === true;

// While AskUserQuestion is awaiting an answer, pair.result is undefined and a
// matching pending interaction exists. Render the inline interactive form
// instead of the folded ▶ row so the user can answer in-place; the form lives
// inside the message-list scroll area so tall multi-question forms scroll
// naturally with the conversation.
const ui = useUiStore();
const pending = usePendingInteractionsStore();
const pendingAsk = computed(() => {
  if (props.pair.use.name !== "AskUserQuestion") return null;
  if (props.pair.result !== undefined) return null;
  const sid = ui.selectedSessionId;
  if (!sid) return null;
  // At any given moment the SDK has at most one pending AskUserQuestion per
  // session (tools run serially), so name-match without tool_use_id is safe.
  return pending.list(sid).find((p) => p.toolName === "AskUserQuestion") ?? null;
});

// Generic tool permission (Bash/Edit/Write/...): match by tool_use_id so a
// message with multiple same-named tool_uses still routes the card to the
// right row. Empirically (exp-permission-order.mjs) can_use_tool can arrive
// up to a few hundred ms BEFORE the assistant message carrying the tool_use
// — during that gap MainPane's bottom strip renders the fallback card, then
// once pair.use lands the inline card takes over and MainPane filters it out.
const pendingPermission = computed(() => {
  if (props.pair.use.name === "AskUserQuestion") return null;
  if (props.pair.result !== undefined) return null;
  const sid = ui.selectedSessionId;
  if (!sid) return null;
  return pending.list(sid).find((p) => p.toolUseId === props.pair.use.id) ?? null;
});
</script>

<template>
  <template v-if="pair.preview">
    <PreviewChip :summary="pair.preview.summary" :path="pair.preview.path" />
  </template>
  <AskUserQuestionInteractive
    v-else-if="pendingAsk && ui.selectedSessionId"
    :session-id="ui.selectedSessionId"
    :request-id="pendingAsk.requestId"
    :input="(pendingAsk.input ?? pair.use.input) as Record<string, unknown>"
  />
  <InteractionCard
    v-else-if="pendingPermission && ui.selectedSessionId"
    :session-id="ui.selectedSessionId"
    :interaction="pendingPermission"
  />
  <div v-else class="cw-tool-call px-4 py-1 border-l-2 border-[var(--cw-border)]  opacity-80">
    <div class="cw-tool-call-header text-xs font-mono cursor-pointer hover:underline" @click="open = !open">{{ header() }}</div>
    <div v-if="open" class="mt-1 pl-3">
      <EditDiff v-if="pair.use.name === 'Edit'" :input="pair.use.input as any" />
      <pre v-else class="text-xs whitespace-pre-wrap bg-[var(--cw-panel-2)] p-2 rounded-sm">{{ JSON.stringify(pair.use.input, null, 2) }}</pre>
      <SubagentBlock v-if="pair.subagentTimeline" :timeline="pair.subagentTimeline" />
      <WorkflowProgressBlock v-if="pair.workflow" :workflow="pair.workflow" class="mb-1" />
      <ToolResult
        v-if="pair.result !== undefined"
        :value="pair.result"
        :is-error="isErr(pair.result)"
        :hide-images="hideResultImages === true"
      />
    </div>
  </div>
</template>
