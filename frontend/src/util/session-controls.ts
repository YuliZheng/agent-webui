import type {
  AgentCapabilities,
  AgentKind,
  AgentModelOption,
  AgentSelectOption
} from "@/types";

export interface SessionControlOption {
  value: string;
  label: string;
  description?: string | null;
}

const CLAUDE_EFFORTS: AgentSelectOption[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" }
];

const CODEX_MODELS: AgentModelOption[] = [
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", supportedEfforts: [...CLAUDE_EFFORTS, { value: "ultra", label: "Ultra" }], defaultEffort: "low", isDefault: true },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra", supportedEfforts: [...CLAUDE_EFFORTS, { value: "ultra", label: "Ultra" }], defaultEffort: "medium" },
  { value: "gpt-5.6-luna", label: "GPT-5.6 Luna", supportedEfforts: CLAUDE_EFFORTS, defaultEffort: "medium" },
  { value: "gpt-5.5", label: "GPT-5.5", supportedEfforts: CLAUDE_EFFORTS },
  { value: "gpt-5.4", label: "GPT-5.4", supportedEfforts: CLAUDE_EFFORTS },
  { value: "gpt-5.4-mini", label: "GPT-5.4 mini", supportedEfforts: CLAUDE_EFFORTS },
  { value: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark", supportedEfforts: CLAUDE_EFFORTS }
];

const FALLBACK_CAPABILITIES: Record<AgentKind, AgentCapabilities> = {
  claude: {
    agent: "claude",
    models: [
      { value: "sonnet", label: "Sonnet", supportedEfforts: CLAUDE_EFFORTS },
      { value: "opus", label: "Opus", supportedEfforts: CLAUDE_EFFORTS },
      { value: "haiku", label: "Haiku", supportedEfforts: CLAUDE_EFFORTS }
    ],
    permissionModes: [
      { value: "auto", label: "Auto", description: "Claude decides when a permission prompt is needed." },
      { value: "acceptEdits", label: "Accept edits", description: "Automatically accept file edits." },
      { value: "manual", label: "Manual", description: "Ask before permission-sensitive actions." },
      { value: "dontAsk", label: "Don't ask", description: "Do not open permission prompts." },
      { value: "plan", label: "Plan", description: "Read-only planning mode." },
      { value: "bypassPermissions", label: "Bypass", description: "Bypass Claude permission checks." }
    ],
    sandboxModes: [],
    defaults: {
      model: "sonnet",
      effort: "medium",
      permissionMode: "auto"
    }
  },
  codex: {
    agent: "codex",
    models: CODEX_MODELS,
    permissionModes: [
      { value: "untrusted", label: "Untrusted", description: "Ask for commands outside the trusted allow-list." },
      { value: "on-request", label: "On request", description: "The agent may request elevated execution." },
      { value: "never", label: "Never ask", description: "Never request approval; sandbox rules still apply." }
    ],
    sandboxModes: [
      { value: "read-only", label: "Read only", description: "No filesystem writes." },
      { value: "workspace-write", label: "Workspace write", description: "Allow writes inside the workspace." },
      { value: "danger-full-access", label: "Full access", description: "No filesystem sandbox." }
    ],
    defaults: {
      model: "gpt-5.6-sol",
      effort: "low",
      permissionMode: "never",
      sandboxMode: "danger-full-access"
    }
  }
};

function copyCapabilities(capabilities: AgentCapabilities): AgentCapabilities {
  return {
    ...capabilities,
    models: capabilities.models.map((model) => ({
      ...model,
      supportedEfforts: model.supportedEfforts.map((effort) => ({ ...effort }))
    })),
    permissionModes: capabilities.permissionModes.map((option) => ({ ...option })),
    sandboxModes: capabilities.sandboxModes.map((option) => ({ ...option })),
    defaults: { ...capabilities.defaults }
  };
}

export function fallbackAgentCapabilities(agent: AgentKind): AgentCapabilities {
  return copyCapabilities(FALLBACK_CAPABILITIES[agent]);
}

function optionWithUnknown(
  options: readonly AgentSelectOption[],
  current?: string
): SessionControlOption[] {
  const value = current?.trim() ?? "";
  return [
    ...(!value || options.some((option) => option.value === value)
      ? []
      : [{ value, label: value }]),
    ...options
  ];
}

function nonBlank(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

export function effectiveModelValue(
  agent: AgentKind,
  current?: string,
  capabilities = fallbackAgentCapabilities(agent)
): string {
  return nonBlank(current)
    || nonBlank(capabilities.defaults.model)
    || capabilities.models.find((option) => option.isDefault)?.value
    || capabilities.models[0]?.value
    || "";
}

function effortsForModel(
  agent: AgentKind,
  model: string | undefined,
  capabilities: AgentCapabilities
): AgentSelectOption[] {
  const effectiveModel = effectiveModelValue(agent, model, capabilities);
  const selectedModel = capabilities.models.find((item) => item.value === effectiveModel);
  return selectedModel?.supportedEfforts.length
    ? selectedModel.supportedEfforts
    : capabilities.models.flatMap((item) => item.supportedEfforts).filter((option, index, all) =>
      all.findIndex((candidate) => candidate.value === option.value) === index
    );
}

export function effectiveEffortValue(
  agent: AgentKind,
  model?: string,
  current?: string,
  capabilities = fallbackAgentCapabilities(agent)
): string {
  const effectiveModel = effectiveModelValue(agent, model, capabilities);
  const selectedModel = capabilities.models.find((item) => item.value === effectiveModel);
  const efforts = effortsForModel(agent, effectiveModel, capabilities);
  return nonBlank(current)
    || nonBlank(selectedModel?.defaultEffort)
    || nonBlank(capabilities.defaults.effort)
    || efforts[0]?.value
    || "";
}

export function effectivePermissionValue(
  agent: AgentKind,
  current?: string,
  capabilities = fallbackAgentCapabilities(agent)
): string {
  return nonBlank(current)
    || nonBlank(capabilities.defaults.permissionMode)
    || capabilities.permissionModes[0]?.value
    || "";
}

export function effectiveSandboxValue(
  current?: string,
  capabilities = fallbackAgentCapabilities("codex")
): string {
  return nonBlank(current)
    || nonBlank(capabilities.defaults.sandboxMode)
    || capabilities.sandboxModes[0]?.value
    || "";
}

export function modelControlOptions(
  agent: AgentKind,
  current?: string,
  capabilities = fallbackAgentCapabilities(agent)
): SessionControlOption[] {
  return optionWithUnknown(
    capabilities.models,
    effectiveModelValue(agent, current, capabilities)
  );
}

export function effortControlOptions(
  agent: AgentKind,
  model?: string,
  current?: string,
  capabilities = fallbackAgentCapabilities(agent)
): SessionControlOption[] {
  const efforts = effortsForModel(agent, model, capabilities);
  return optionWithUnknown(
    efforts,
    effectiveEffortValue(agent, model, current, capabilities)
  );
}

export function permissionControlOptions(
  agent: AgentKind,
  current?: string,
  capabilities = fallbackAgentCapabilities(agent)
): SessionControlOption[] {
  return optionWithUnknown(
    capabilities.permissionModes,
    effectivePermissionValue(agent, current, capabilities)
  );
}

export function sandboxControlOptions(
  current?: string,
  capabilities = fallbackAgentCapabilities("codex")
): SessionControlOption[] {
  return optionWithUnknown(
    capabilities.sandboxModes,
    effectiveSandboxValue(current, capabilities)
  );
}

export function isCodexYolo(
  permissionMode: string | undefined,
  sandboxMode: string | undefined,
  capabilities = fallbackAgentCapabilities("codex")
): boolean {
  const effectivePermission = permissionMode || capabilities.defaults.permissionMode;
  const effectiveSandbox = sandboxMode || capabilities.defaults.sandboxMode;
  return effectivePermission === "never" && effectiveSandbox === "danger-full-access";
}
