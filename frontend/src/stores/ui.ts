import { reactive, ref } from "vue";
import { defineStore } from "pinia";
import type { Interaction } from "@/types";

export interface UiToast {
  id: string;
  message: string;
  kind?: "error" | "info";
  sticky?: boolean;
  sessionId?: string;
  requestId?: string;
}

export const useUiStore = defineStore("ui", () => {
  const mobileListVisible = ref(true);
  const sidebarOpen = ref(true);
  const searchTarget = ref<{ sessionId: string; uuid?: string; index?: number } | null>(null);
  const lightboxUrl = ref<string | null>(null);
  const localFile = ref<{ path: string; content: string; line?: number } | null>(null);
  const previewUrl = ref<string | null>(null);
  const openSessionRequest = ref<{ sessionId: string; nonce: string } | null>(null);
  const toasts = reactive<UiToast[]>([]);
  function dismissToast(id: string): void { const index = toasts.findIndex((item) => item.id === id); if (index >= 0) toasts.splice(index, 1); }
  function toast(message: string, kind: "error" | "info" = "info", options: Omit<UiToast, "id" | "message" | "kind"> = {}): string {
    const id = crypto.randomUUID(); toasts.push({ id, message, kind, ...options });
    if (!options.sticky) setTimeout(() => dismissToast(id), 5000);
    return id;
  }
  function showInteractionToast(item: Interaction): void {
    if (toasts.some((toast) => toast.requestId === item.requestId && toast.sessionId === item.sessionId)) return;
    const label = item.title || (item.kind === "permission" ? "Permission required" : "Question waiting");
    toast(`${label} in a background session${item.toolName ? `: ${item.toolName}` : ""}`, "info", { sticky: true, sessionId: item.sessionId, requestId: item.requestId });
  }
  function dismissInteractionToast(sessionId: string, requestId: string): void {
    for (const item of [...toasts]) if (item.sessionId === sessionId && item.requestId === requestId) dismissToast(item.id);
  }
  function syncInteractionToasts(items: readonly Interaction[]): void {
    const pending = new Set(items.map((item) => `${item.sessionId}\u0000${item.requestId}`));
    for (const item of [...toasts]) {
      if (item.sessionId && item.requestId && !pending.has(`${item.sessionId}\u0000${item.requestId}`)) dismissToast(item.id);
    }
    for (const item of items) showInteractionToast(item);
  }
  function requestSessionOpen(sessionId: string): void { openSessionRequest.value = { sessionId, nonce: crypto.randomUUID() }; }
  return { mobileListVisible, sidebarOpen, searchTarget, lightboxUrl, localFile, previewUrl, openSessionRequest, toasts, toast, dismissToast, showInteractionToast, dismissInteractionToast, syncInteractionToasts, requestSessionOpen };
});

// Focused names for independent UI concerns while retaining a compact implementation.
export const useNotificationsStore = useUiStore;
export const useLightboxStore = useUiStore;
export const useLocalFileViewerStore = useUiStore;
export const usePreviewStore = useUiStore;
