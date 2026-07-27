import { ref } from "vue";

// Shared 1s-ticking "now" ref. Used by sidebar rows to compute how long a
// running session has been waiting for the next jsonl write, without each
// row spinning up its own interval. One timer module-wide; reactivity fans
// out to whichever components subscribe.
export const nowMs = ref<number>(Date.now());

if (typeof window !== "undefined") {
  setInterval(() => { nowMs.value = Date.now(); }, 1000);
}

export function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm > 0 ? `${h}h ${mm}m` : `${h}h`;
}
