<script setup lang="ts">
import { computed, ref } from "vue";
import { usePendingInteractionsStore } from "../../../stores/pending-interactions.js";
import { useNotificationsStore } from "../../../stores/notifications.js";

// Inline interactive form for a pending AskUserQuestion. Lives inside the
// message-list scroll area so a tall multi-question form scrolls naturally
// with the conversation. Once answered, the tool_result lands in jsonl,
// pair.result populates, and ToolCall renders the historical row instead.

interface Option { label: string; description?: string }
interface AskQ {
  question: string;
  header?: string;
  options?: Option[];
  multiSelect?: boolean;
}

const props = defineProps<{
  sessionId: string;
  requestId: string;
  input: Record<string, unknown>;
}>();

const store = usePendingInteractionsStore();
const notifications = useNotificationsStore();

const inflight = computed(() => store.isInflight(props.sessionId, props.requestId));
const questions = computed<AskQ[]>(() => {
  const arr = props.input?.questions;
  return Array.isArray(arr) ? arr as AskQ[] : [];
});

const selectedSingle = ref<(string | null)[]>([]);
const otherTextById = ref<string[]>([]);
const selectedMulti = ref<Set<string>[]>([]);

function ensureInit(n: number) {
  while (selectedSingle.value.length < n) selectedSingle.value.push(null);
  while (otherTextById.value.length < n) otherTextById.value.push("");
  while (selectedMulti.value.length < n) selectedMulti.value.push(new Set());
}

function pickSingle(qIdx: number, label: string) {
  ensureInit(qIdx + 1);
  selectedSingle.value[qIdx] = label;
  otherTextById.value[qIdx] = "";
}

function toggleMulti(qIdx: number, label: string) {
  ensureInit(qIdx + 1);
  const set = new Set(selectedMulti.value[qIdx]);
  if (set.has(label)) set.delete(label); else set.add(label);
  selectedMulti.value[qIdx] = set;
}

function selectOther(qIdx: number) {
  ensureInit(qIdx + 1);
  selectedSingle.value[qIdx] = null;
}

const canSubmit = computed(() => {
  ensureInit(questions.value.length);
  return questions.value.every((q, i) => {
    const otherFilled = (otherTextById.value[i] ?? "").trim().length > 0;
    if (q.multiSelect) return selectedMulti.value[i]!.size > 0 || otherFilled;
    return selectedSingle.value[i] !== null || otherFilled;
  });
});

async function submit() {
  ensureInit(questions.value.length);
  const answers = questions.value.map((q, i): { selectedLabel: string | null; otherText?: string } => {
    const other = (otherTextById.value[i] ?? "").trim();
    if (q.multiSelect) {
      const labels = [...selectedMulti.value[i]!];
      const parts = [...labels];
      if (other) parts.push(`Other: ${other}`);
      if (parts.length === 0) return { selectedLabel: null, otherText: other };
      return { selectedLabel: parts.join(", ") };
    }
    const single = selectedSingle.value[i];
    if (single !== null && single !== undefined) return { selectedLabel: single };
    return { selectedLabel: null, otherText: other };
  });
  try {
    await store.respond(props.sessionId, props.requestId, { kind: "ask-answers", answers });
  } catch (e) {
    notifications.pushError(e instanceof Error ? e.message : String(e), { title: "Answer failed" });
  }
}
</script>

<template>
  <div class="cw-ask-question px-4 py-2 border-l-4 text-sm">
    <div class="flex items-center gap-2 mb-1.5">
      <span class="cw-ask-question-badge text-[10px] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded">
        Question
      </span>
      <span class="text-[11px] opacity-70 font-mono ml-auto">{{ requestId.slice(0, 8) }}</span>
    </div>
    <div v-for="(q, qIdx) in questions" :key="qIdx" class="mb-2.5 last:mb-1.5">
      <div class="font-medium mb-1.5">{{ q.question }}</div>
      <div class="flex flex-col gap-1">
        <button
          v-for="opt in q.options"
          :key="opt.label"
          type="button"
          class="text-left px-2.5 py-1.5 rounded border text-sm"
          :class="(q.multiSelect ? selectedMulti[qIdx]?.has(opt.label) : selectedSingle[qIdx] === opt.label)
            ? 'cw-ask-question-opt-selected'
            : 'border-[var(--cw-border)] bg-[color-mix(in_srgb,var(--cw-panel-bg)_70%,transparent)] hover:bg-[var(--cw-panel-2)]'"
          :disabled="inflight"
          @click="q.multiSelect ? toggleMulti(qIdx, opt.label) : pickSingle(qIdx, opt.label)"
        >
          <div class="font-medium">{{ opt.label }}</div>
          <div v-if="opt.description" class="text-xs opacity-70 mt-0.5">{{ opt.description }}</div>
        </button>
        <input
          v-model="otherTextById[qIdx]"
          type="text"
          placeholder="Other (free text)…"
          class="px-2 py-1.5 rounded border border-[var(--cw-border)] bg-[color-mix(in_srgb,var(--cw-panel-bg)_80%,transparent)] text-sm"
          :disabled="inflight"
          @focus="selectOther(qIdx)"
        />
      </div>
    </div>
    <div class="flex justify-end mt-2">
      <button
        type="button"
        class="cw-ask-question-submit px-3 py-1 text-xs rounded disabled:opacity-50"
        :disabled="!canSubmit || inflight"
        @click="submit"
      >
        {{ inflight ? "Sending…" : "Submit" }}
      </button>
    </div>
  </div>
</template>
