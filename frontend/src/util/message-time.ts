export const MESSAGE_TIME_GAP_MS = 5 * 60 * 1000;

export function parseMessageTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Accept both Unix seconds and browser-style millisecond timestamps.
    const milliseconds = Math.abs(value) < 1_000_000_000_000 ? value * 1000 : value;
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function shouldShowMessageTime(
  previousTimestamp: number | null,
  timestamp: number,
  gapMs = MESSAGE_TIME_GAP_MS,
): boolean {
  if (previousTimestamp === null) return true;
  if (timestamp <= previousTimestamp) return false;
  const previous = new Date(previousTimestamp);
  const current = new Date(timestamp);
  const crossedCalendarDay = previous.getFullYear() !== current.getFullYear()
    || previous.getMonth() !== current.getMonth()
    || previous.getDate() !== current.getDate();
  return crossedCalendarDay || timestamp - previousTimestamp >= gapMs;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function clock(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function calendarDay(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}

const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"] as const;

/** Format a local-time label using the same progressive detail as WeChat. */
export function formatMessageTime(timestamp: number, nowTimestamp = Date.now()): string {
  const date = new Date(timestamp);
  const now = new Date(nowTimestamp);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(now.getTime())) return "";

  const time = clock(date);
  const dayDelta = calendarDay(now) - calendarDay(date);
  if (dayDelta === 0) return time;
  if (dayDelta === 1) return `昨天 ${time}`;
  if (dayDelta > 1 && dayDelta < 7) return `${WEEKDAYS[date.getDay()]} ${time}`;
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}
