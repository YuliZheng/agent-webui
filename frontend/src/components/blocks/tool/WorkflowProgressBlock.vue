<script setup lang="ts">
import { computed } from "vue";
import type { WorkflowInfo, WorkflowProgressEntry } from "../../../parser/group.js";
import { formatElapsed } from "../../../util/now-tick.js";

// Compact collapsed <details> view of a workflow's progress trail
// (toolUseResult.task.workflowProgress). All field access is defensive —
// malformed entries just drop out and the caller's text rendering remains.
const props = defineProps<{ workflow: WorkflowInfo }>();

const s = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);

interface AgentRow { label: string; state: string; duration: string }
interface Phase { index: number; title: string; agents: AgentRow[] }

const phases = computed<Phase[]>(() => {
  const byIndex = new Map<number, Phase>();
  const orphan: Phase = { index: -1, title: "", agents: [] };
  for (const e of props.workflow.entries) {
    if (e.type === "workflow_phase") {
      const idx = num(e.index);
      if (Number.isFinite(idx) && !byIndex.has(idx)) {
        byIndex.set(idx, { index: idx, title: s(e.title) || `Phase ${idx}`, agents: [] });
      }
    }
  }
  for (const e of props.workflow.entries) {
    if (e.type !== "workflow_agent") continue;
    const row: AgentRow = {
      label: s(e.label) || s(e.agentId) || "agent",
      state: s(e.state) || "queued",
      duration: durationOf(e),
    };
    const phase = byIndex.get(num(e.phaseIndex));
    (phase ?? orphan).agents.push(row);
  }
  const out = [...byIndex.values()].sort((a, b) => a.index - b.index);
  if (orphan.agents.length) out.push(orphan);
  return out;
});

function durationOf(e: WorkflowProgressEntry): string {
  const ms = num(e.durationMs);
  if (Number.isFinite(ms)) return formatElapsed(ms);
  return "";
}

const agentCount = computed(() => phases.value.reduce((acc, p) => acc + p.agents.length, 0));
const stateCounts = computed(() => {
  const c: Record<string, number> = {};
  for (const p of phases.value) for (const a of p.agents) c[a.state] = (c[a.state] ?? 0) + 1;
  return Object.entries(c).map(([k, v]) => `${v} ${k}`).join(", ");
});
const phaseCount = computed(() => phases.value.filter((p) => p.index >= 0).length);
const name = computed(() => props.workflow.description);

const STATE_GLYPH: Record<string, string> = { queued: "○", running: "◐", done: "●" };
</script>

<template>
  <details class="cw-workflow-progress text-xs opacity-80">
    <summary class="cursor-pointer select-none opacity-70 hover:opacity-100">
      ⚙ workflow<template v-if="name">: {{ name }}</template>
      — {{ phaseCount }} {{ phaseCount === 1 ? "phase" : "phases" }},
      {{ agentCount }} {{ agentCount === 1 ? "agent" : "agents" }}<template v-if="stateCounts"> ({{ stateCounts }})</template>
    </summary>
    <div class="mt-1 pl-4 space-y-1">
      <div v-for="p in phases" :key="p.index">
        <div v-if="p.index >= 0" class="font-medium opacity-70">{{ p.index }}. {{ p.title }}</div>
        <div
          v-for="(a, i) in p.agents"
          :key="i"
          class="pl-3 flex items-center gap-1.5 min-w-0"
        >
          <span
            class="shrink-0"
            :class="a.state === 'running' ? 'text-[var(--cw-info)]'
              : a.state === 'done' ? 'text-[var(--cw-success)]'
              : 'opacity-50'"
            :title="a.state"
          >{{ STATE_GLYPH[a.state] ?? "○" }}</span>
          <span class="truncate">{{ a.label }}</span>
          <span v-if="a.duration" class="shrink-0 opacity-50 tabular-nums">{{ a.duration }}</span>
        </div>
      </div>
    </div>
  </details>
</template>
