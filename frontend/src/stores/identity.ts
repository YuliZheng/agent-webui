import { ref } from "vue";
import { defineStore } from "pinia";
import { api } from "@/api/http";

export function initialsFromHome(home: string): string {
  const username = home.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  const words = username.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!words.length) return "ME";
  if (words.length > 1) {
    return `${Array.from(words[0]!)[0] ?? ""}${Array.from(words.at(-1)!)[0] ?? ""}`.toUpperCase() || "ME";
  }
  return Array.from(words[0]!).slice(0, 2).join("").toUpperCase() || "ME";
}

export const useIdentityStore = defineStore("identity", () => {
  const initials = ref("ME");
  const home = ref("");
  let inFlight: Promise<void> | null = null;

  function load(): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = api<{ home: string }>("/api/me")
      .then((result) => {
        home.value = result.home;
        initials.value = initialsFromHome(result.home);
      })
      .catch(() => undefined)
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  return { initials, home, load };
});
