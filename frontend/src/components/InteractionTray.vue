<script setup lang="ts">
import { computed, reactive } from "vue";
import type { Interaction } from "@/types";
import { useInteractionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { answerInteractionOnce, interactionQuestions, interactionToolSummary } from "@/util/interactions";
const props = withDefaults(defineProps<{ sessionId?: string; items?: Interaction[]; inline?: boolean; excludeToolUseIds?: string[] }>(), { items: undefined, sessionId: undefined, inline: false, excludeToolUseIds: () => [] });
const store = useInteractionsStore();
const ui = useUiStore();
const submitting = reactive(new Set<string>());
const items = computed(() => (props.items ?? store.items.filter((item) => item.sessionId === props.sessionId)).filter((item) => !item.toolUseId || !props.excludeToolUseIds.includes(item.toolUseId)));
const answers = reactive<Record<string, Record<string, unknown>>>({});
function choose(requestId: string, key: string, value: unknown, multiple: boolean) {
  const response = answers[requestId] ??= {};
  if (!multiple) response[key] = value;
  else { const list = Array.isArray(response[key]) ? response[key] as unknown[] : []; response[key] = list.includes(value) ? list.filter((item) => item !== value) : [...list, value]; }
}
async function respond(item: Interaction, answer: unknown) {
  if (submitting.has(item.requestId)) return;
  submitting.add(item.requestId);
  try { await answerInteractionOnce(item, answer, (target, value) => store.respond(target, value)); }
  catch (error) { ui.toast(error instanceof Error ? error.message : "Could not answer interaction", "error"); }
  finally { submitting.delete(item.requestId); }
}
</script>
<template>
  <div v-if="items.length" class="cw-interaction-tray" :class="{ 'cw-interaction-inline': inline }">
    <section v-for="item in items" :key="item.requestId">
      <strong>{{ item.title || (item.kind === 'permission' ? 'Permission required' : 'Question') }}</strong><p>{{ item.message || item.description }}</p>
      <div v-if="interactionToolSummary(item)" class="cw-interaction-tool"><b>{{ interactionToolSummary(item)?.name }}</b><pre>{{ interactionToolSummary(item)?.input }}</pre></div>
      <fieldset v-for="question in interactionQuestions(item)" :key="question.key"><legend>{{ question.question }}</legend>
        <button v-for="option in question.options" :key="option.label" :class="{ selected: (answers[item.requestId]?.[question.key] as unknown[])?.includes?.(option.value) || answers[item.requestId]?.[question.key] === option.value }" @click="choose(item.requestId, question.key, option.value, question.multiSelect)">{{ option.label }}<small v-if="option.description">{{ option.description }}</small></button>
      </fieldset>
      <div><button v-for="choice in item.choices" :key="choice" :disabled="submitting.has(item.requestId)" @click="respond(item, choice)">{{ choice }}</button><button v-for="option in item.options" :key="option.label" :disabled="submitting.has(item.requestId)" @click="respond(item, option.value)">{{ option.label }}</button>
        <button v-if="interactionQuestions(item).length" :disabled="submitting.has(item.requestId)" @click="respond(item, answers[item.requestId] || {})">Submit answers</button>
        <template v-else-if="!item.options?.length && !item.choices?.length"><button :disabled="submitting.has(item.requestId)" @click="respond(item, true)">Allow</button><button :disabled="submitting.has(item.requestId)" @click="respond(item, false)">Deny</button></template>
      </div>
    </section>
  </div>
</template>
