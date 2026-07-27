export function relativeTime(iso: string): string {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return "";
    const sec = Math.max(1, Math.round((Date.now() - t) / 1000));
    if (sec < 60) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const d = Math.round(hr / 24);
    return `${d}d ago`;
}

// IM-style compact time: today → "HH:MM", yesterday → "Yesterday",
// this week → weekday short ("Mon"), older this year → "MMM D",
// older years → "YYYY/M/D". Matches Telegram / WeChat row right-side time.
export function imTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate()
  ) {
    return "Yesterday";
  }
  // Cap at 6 days, not 7. At exactly 7 days ago the weekday name matches
  // today's, so "Mon" on a Monday is ambiguous between "today" (caught
  // earlier) and "exactly a week ago" (would be confusing). Past 6 days
  // we fall through to the explicit "MMM D" branch.
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays < 6) {
    return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()] ?? "";
  }
  if (d.getFullYear() === now.getFullYear()) {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${months[d.getMonth()]} ${d.getDate()}`;
  }
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
