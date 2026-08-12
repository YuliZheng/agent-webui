import { defineStore } from "pinia";
import { CODEX_DEFAULT_APPROVAL, CODEX_DEFAULT_MODEL } from "@claude-webui/shared/prefs";
import { usePrefsStore } from "./prefs.js";
import { useSessionCacheStore } from "./session-cache.js";

// Per-session effective model + permissionMode + effort + serviceTier, mirrored from the
// backend's session-settings push.
//
// What the FE pill displays falls back through 4 levels:
//   1. backend push (bySession[sessionId]) — authoritative if backend has
//      anything (wire-observed or user-override).
//   2. derived from the on-disk jsonl cache — last assistant.message.model
//      for model, last user.permissionMode for permissionMode. Used for
//      dead sessions the backend hasn't tailed in this lifetime.
//   3. global prefs default (defaultModel / defaultPermissionMode).
//   4. empty string — visible literal so the user knows nothing was inferred.
//
// Only (1) gets written to the store; (2)-(4) are computed on demand by
// `effective()`.

interface BackendSettings {
  model: string | null;
  permissionMode: string | null;
  effort: string | null;
  serviceTier: string | null;
}

interface DerivedCodexSettings {
  model: string | null;
  permissionMode: string | null;
  effort: string | null;
  serviceTier: "priority" | "standard" | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function serviceTierValue(value: unknown): "priority" | "standard" | null {
  const tier = stringValue(value);
  if (tier === "priority" || tier === "fast") return "priority";
  if (tier === "default" || tier === "standard") return "standard";
  return null;
}

function sandboxMode(value: unknown): string | null {
  if (typeof value === "string") return stringValue(value);
  const obj = record(value);
  return stringValue(obj?.type) ?? stringValue(obj?.mode);
}

function approvalPreset(approval: unknown, sandbox: unknown): string | null {
  const policy = stringValue(approval);
  const mode = sandboxMode(sandbox);
  if (policy === "never" && mode === "danger-full-access") return "full-access";
  if ((policy === "on-failure" || policy === "untrusted") && mode === "workspace-write") return "auto";
  if (policy === "on-request" && mode === "read-only") return "read-only";
  if (policy === "on-request" && mode === "workspace-write") return "ask";
  if (policy === "full-access" || policy === "auto" || policy === "ask" || policy === "read-only") return policy;
  return null;
}

function deriveCodexSettings(lines: string[]): DerivedCodexSettings {
  const derived: DerivedCodexSettings = {
    model: null,
    permissionMode: null,
    effort: null,
    serviceTier: null,
  };
  for (let i = lines.length - 1; i >= 0; i--) {
    if (derived.model && derived.permissionMode && derived.effort && derived.serviceTier) break;
    let parsed: Record<string, unknown> | null = null;
    try { parsed = record(JSON.parse(lines[i]!)); } catch { continue; }
    if (!parsed) continue;
    const payload = record(parsed.payload);
    if (parsed.type === "turn_context" && payload) {
      derived.model ??= stringValue(payload.model);
      derived.effort ??= stringValue(payload.effort) ?? stringValue(payload.reasoning_effort);
      derived.permissionMode ??= approvalPreset(payload.approval_policy, payload.sandbox_policy);
      continue;
    }
    if (parsed.type === "event_msg" && payload?.type === "thread_settings_applied") {
      const applied = record(payload.thread_settings);
      if (!applied) continue;
      derived.model ??= stringValue(applied.model);
      derived.effort ??= stringValue(applied.reasoning_effort) ?? stringValue(applied.effort);
      derived.permissionMode ??= approvalPreset(
        applied.approval_policy,
        applied.sandbox_policy ?? applied.sandbox_mode,
      );
      derived.serviceTier ??= serviceTierValue(applied.service_tier ?? applied.serviceTier);
    }
  }
  return derived;
}

export const useSessionSettingsStore = defineStore("session-settings", {
  state: () => ({
    bySession: {} as Record<string, BackendSettings>,
  }),
  actions: {
    apply(evt: {
      id: string;
      model?: string | null;
      permissionMode?: string | null;
      effort?: string | null;
      serviceTier?: string | null;
    }) {
      if (!evt.id) return;
      const cur = this.bySession[evt.id] ?? { model: null, permissionMode: null, effort: null, serviceTier: null };
      if (evt.model !== undefined) cur.model = evt.model;
      if (evt.permissionMode !== undefined) cur.permissionMode = evt.permissionMode;
      if (evt.effort !== undefined) cur.effort = evt.effort;
      if (evt.serviceTier !== undefined) cur.serviceTier = evt.serviceTier;
      if (cur.model === null && cur.permissionMode === null && cur.effort === null && cur.serviceTier === null) {
        delete this.bySession[evt.id];
        return;
      }
      this.bySession[evt.id] = cur;
    },
    /**
     * 4-level fallback. Always returns a {model, permissionMode} object;
     * either field may be the empty string when nothing is known.
     */
    effective(sessionId: string): { model: string; permissionMode: string; effort: string; serviceTier: string } {
      const backend = this.bySession[sessionId];
      let model = backend?.model ?? null;
      let permissionMode = backend?.permissionMode ?? null;
      let effort = backend?.effort ?? null;
      // Derive missing fields from the jsonl cache. Walk from the end so we
      // get the most recent values.
      if (!model || !permissionMode) {
        const cache = useSessionCacheStore();
        const entry = cache.bySession[sessionId];
        if (entry && entry.lines.length > 0) {
          for (let i = entry.lines.length - 1; i >= 0; i--) {
            if (model && permissionMode) break;
            let parsed: Record<string, unknown> | null = null;
            try { parsed = JSON.parse(entry.lines[i]!) as Record<string, unknown>; } catch { continue; }
            if (!parsed) continue;
            const t = parsed.type as string;
            if (!model && t === "assistant") {
              const msg = parsed.message as Record<string, unknown> | undefined;
              const m = msg && typeof msg.model === "string" ? msg.model : null;
              if (m) model = m;
            }
            if (!permissionMode && t === "user") {
              const pm = typeof parsed.permissionMode === "string" ? parsed.permissionMode : null;
              if (pm) permissionMode = pm;
            }
          }
        }
      }
      if (!model || !permissionMode) {
        const prefs = usePrefsStore();
        if (!model) model = prefs.defaultModel ?? "";
        if (!permissionMode) permissionMode = prefs.defaultPermissionMode ?? "";
      }
      return {
        model: model ?? "",
        permissionMode: permissionMode ?? "",
        effort: effort ?? "",
        serviceTier: backend?.serviceTier ?? "",
      };
    },
    /**
     * Codex has independent defaults and must not inherit the Claude/jsonl
     * fallbacks in effective(). Composer pills and local commands share this
     * resolver so they cannot disagree about the active settings.
     */
    effectiveCodex(sessionId: string): { model: string; permissionMode: string; effort: string; serviceTier: string } {
      const backend = this.bySession[sessionId];
      const prefs = usePrefsStore();
      const cache = useSessionCacheStore();
      const derived = deriveCodexSettings(cache.bySession[sessionId]?.lines ?? []);
      return {
        model: backend?.model || derived.model || prefs.defaultCodexModel || CODEX_DEFAULT_MODEL,
        permissionMode: backend?.permissionMode || derived.permissionMode || prefs.defaultCodexApproval || CODEX_DEFAULT_APPROVAL,
        effort: backend?.effort || derived.effort || prefs.defaultCodexEffort || "",
        // Codex 0.144.x omits service_tier from turn_context. Do not turn that
        // absence into a false "Fast off"; only an applied/persisted tier is
        // authoritative.
        serviceTier: serviceTierValue(backend?.serviceTier) ?? derived.serviceTier ?? "unknown",
      };
    },
  },
});
