<script setup lang="ts">
import { computed } from "vue";
import type { Interaction, MessageDisplayStyle, NormalizedBlock } from "@/types";
import UserPromptBlock from "./blocks/UserPromptBlock.vue";
import AssistantBlock from "./blocks/AssistantBlock.vue";
import ToolBlock from "./blocks/ToolBlock.vue";
import ToolRunBlock from "./blocks/ToolRunBlock.vue";
import SystemBlock from "./blocks/SystemBlock.vue";

const props = withDefaults(defineProps<{
  block: NormalizedBlock;
  actions?: boolean;
  interactions?: Interaction[];
  displayStyle?: MessageDisplayStyle;
  sessionEmoji?: string;
}>(), {
  actions: true,
  interactions: () => [],
  displayStyle: "claude-code"
});
defineEmits<{ rewind: [block: NormalizedBlock]; fork: [block: NormalizedBlock] }>();

const blockName = computed(() => {
  if (props.block.kind === "user") return "UserPromptBlock";
  if (props.block.kind === "assistant" || props.block.kind === "thinking") return "AssistantBlock";
  if (props.block.kind === "tool-run") return "ToolRunBlock";
  if (props.block.kind === "tool") return "AssistantBlock";
  return "SystemBlock";
});
const role = computed(() => props.block.kind === "user" ? "user" : props.block.kind === "assistant" || props.block.kind === "thinking" || props.block.kind === "tool" || props.block.kind === "tool-run" ? "assistant" : "system");
const entryUuid = computed(() => props.block.uuid || props.block.toolUseId || undefined);
const isWechatAvatarEntry = computed(() =>
  props.block.kind === "user" ||
  (props.block.kind === "assistant" && !!props.block.text?.trim())
);
</script>

<template>
  <div
    v-if="!block.meta?.usageOnly"
    class="cw-message-entry"
    :class="{ 'cw-search-highlight': block.matched }"
    :data-block="blockName"
    :data-role="role"
    :data-uuid="entryUuid"
    :data-bubble-uuid="entryUuid"
    :data-message-uuid="entryUuid"
    :data-message-key="block.key"
    :data-source-index="block.index"
  >
    <span
      v-if="blockName === 'UserPromptBlock' || blockName === 'AssistantBlock' || blockName === 'ToolRunBlock'"
      class="cw-message-avatar"
      :class="[
        blockName === 'UserPromptBlock' ? 'cw-message-avatar-user' : 'cw-message-avatar-assistant',
        isWechatAvatarEntry ? '' : 'cw-message-avatar-empty'
      ]"
      aria-hidden="true"
    >
      <template v-if="isWechatAvatarEntry">
        <template v-if="blockName === 'UserPromptBlock'">
          <span class="cw-message-avatar-fallback cw-session-message-emoji">{{ sessionEmoji || "💬" }}</span>
        </template>
        <span v-else class="cw-agent-badge" :title="block.agent === 'codex' ? 'Codex' : 'Claude Code'">🤖</span>
      </template>
    </span>
    <UserPromptBlock
      v-if="block.kind === 'user'"
      :block="block"
      :display-style="displayStyle"
      :hide-actions="!actions"
      @rewind="$emit('rewind', $event)"
      @fork="$emit('fork', $event)"
    />
    <AssistantBlock v-else-if="block.kind === 'assistant' || block.kind === 'thinking'" :block="block" />
    <ToolRunBlock v-else-if="block.kind === 'tool-run'" :items="block.children ?? []" :interactions="interactions" />
    <div v-else-if="block.kind === 'tool'" class="cw-block cw-assistant-block">
      <ToolBlock :block="block" :interactions="interactions" />
    </div>
    <SystemBlock v-else :block="block" />
  </div>
</template>
