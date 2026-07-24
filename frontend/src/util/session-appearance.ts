import type { AgentKind } from "@/types";

export const SIDEBAR_WIDTH_STORAGE_KEY = "agent-webui:sidebar-width:v1";
export const SIDEBAR_MIN_WIDTH = 300;
export const SIDEBAR_MAX_WIDTH = 700;
export const SIDEBAR_DEFAULT_RATIO = 420 / 2048;

const SESSION_COLORS = [
  "#37adad",
  "#835bc6",
  "#d3a523",
  "#3e8fc8",
  "#4aa45e",
  "#c26478",
  "#b97338",
  "#5d74c8",
  "#9a6ab2",
  "#2f9b79",
] as const;

const SESSION_EMOJIS = [
  "🤖",
  "🔧",
  "🔐",
  "🖨️",
  "🎵",
  "🧠",
  "🧩",
  "🚀",
  "🧪",
  "💬",
  "🛠️",
  "📦",
] as const;

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function normalizeSessionPath(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/\/+$/, "").toLocaleLowerCase();
}

export function sessionAppearance(path: string, agent?: AgentKind, sessionId?: string): { color: string; emoji: string } {
  const normalized = normalizeSessionPath(path) || "/";
  const pathHash = hashString(normalized);
  // Colors belong to the folder; individual chats in that folder still get
  // their own stable emoji, like the reference list.
  const iconHash = hashString(`${sessionId || normalized}:${agent ?? "agent"}`);
  return {
    color: SESSION_COLORS[pathHash % SESSION_COLORS.length]!,
    emoji: SESSION_EMOJIS[iconHash % SESSION_EMOJIS.length]!,
  };
}

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_MIN_WIDTH;
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)));
}

export function defaultSidebarWidth(viewportWidth: number): number {
  return clampSidebarWidth(viewportWidth * SIDEBAR_DEFAULT_RATIO);
}

export function storedSidebarWidth(value: string | null, viewportWidth: number): number {
  if (value == null || value.trim() === "") return defaultSidebarWidth(viewportWidth);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clampSidebarWidth(parsed) : defaultSidebarWidth(viewportWidth);
}

export function formatSessionListTime(value: string | Date, now = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayDelta = Math.round((startOfToday.getTime() - startOfDate.getTime()) / 86_400_000);
  if (dayDelta === 0) return new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  if (dayDelta === 1) return "Yesterday";
  if (dayDelta > 1 && dayDelta < 7) return new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date);
  return new Intl.DateTimeFormat("en-US", date.getFullYear() === now.getFullYear()
    ? { month: "short", day: "numeric" }
    : { year: "numeric", month: "short", day: "numeric" }).format(date);
}
