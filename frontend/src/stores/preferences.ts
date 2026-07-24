import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import { DEFAULT_PREFS, type ColorScheme, type MessageDisplayStyle, type PrefsBlob } from "@/types";
import { mainSocket } from "@/api/ws";

export const THEME_OPTIONS: ReadonlyArray<{ value: MessageDisplayStyle; label: string }> = [
  { value: "wechat", label: "WeChat" }, { value: "claude-code", label: "Claude Code" }
];

export function normalizePrefs(raw: Partial<PrefsBlob> & { colorScheme?: unknown }): PrefsBlob {
  const color = raw.colorPreference ?? raw.colorScheme;
  const { colorScheme: _legacyColorScheme, ...wireFields } = raw;
  const frequency = raw.autoTitleFrequency;
  return {
    ...DEFAULT_PREFS, ...wireFields,
    messageDisplayStyle: raw.messageDisplayStyle === "claude-code" ? "claude-code" : "wechat",
    colorPreference: (["light", "dark", "system"] as ColorScheme[]).includes(color as ColorScheme) ? color as ColorScheme : "system",
    autoTitleFrequency: Number.isSafeInteger(frequency) && Number(frequency) >= 1 && Number(frequency) <= 100
      ? Number(frequency)
      : DEFAULT_PREFS.autoTitleFrequency,
    hiddenSessionIds: Array.isArray(raw.hiddenSessionIds) ? raw.hiddenSessionIds : [],
    groups: Array.isArray(raw.groups) ? raw.groups : [],
    pinnedSessionIds: Array.isArray(raw.pinnedSessionIds) ? raw.pinnedSessionIds : [],
    pinnedGroupIds: Array.isArray(raw.pinnedGroupIds) ? raw.pinnedGroupIds : []
  };
}

export const usePreferencesStore = defineStore("preferences", () => {
  const prefs = ref<PrefsBlob>({ ...DEFAULT_PREFS });
  const ready = ref(false);
  const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : undefined;
  const systemDark = ref(media?.matches ?? false);
  media?.addEventListener("change", (event) => { systemDark.value = event.matches; applyTheme(); });
  const isDark = computed(() => prefs.value.colorPreference === "dark" || (prefs.value.colorPreference === "system" && systemDark.value));
  const messageDisplayStyle = computed(() => prefs.value.messageDisplayStyle);

  async function load(): Promise<void> {
    try { prefs.value = normalizePrefs(await mainSocket.request<PrefsBlob>("get-prefs")); } catch { prefs.value = { ...DEFAULT_PREFS }; }
    ready.value = true; applyTheme();
  }
  async function save(next?: PrefsBlob): Promise<void> {
    const normalized = normalizePrefs(next ?? prefs.value);
    if (next) {
      await mainSocket.request("put-prefs", { prefs: normalized });
      prefs.value = normalized;
      applyTheme();
      return;
    }
    prefs.value = normalized;
    applyTheme();
    await mainSocket.request("put-prefs", { prefs: normalized });
  }
  function applyTheme(): void {
    const html = document.documentElement;
    html.classList.remove("cw-style-wechat", "cw-style-claude-code", "dark", "light");
    html.classList.add(`cw-style-${prefs.value.messageDisplayStyle}`);
    if (prefs.value.colorPreference === "light") html.classList.add("light");
    else if (isDark.value) html.classList.add("dark");
    html.style.colorScheme = isDark.value ? "dark" : "light";
  }
  function setDisplayStyle(value: MessageDisplayStyle): void { prefs.value.messageDisplayStyle = value; void save(); }
  function setColorScheme(value: ColorScheme): void { prefs.value.colorPreference = value; void save(); }
  watch(isDark, applyTheme);
  return { prefs, ready, isDark, messageDisplayStyle, load, save, applyTheme, setDisplayStyle, setColorScheme };
});
