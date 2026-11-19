/** Time separators between turns (decision 18): read by the transcript, Changes and memory sessions, all lazy chunks. */

/** A gap longer than this between turns earns a time separator (contract v6 decision 18). */
export const SEPARATOR_GAP_MS = 30 * 60_000;

function dayStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** A separator goes before a request that starts > 30 min after the previous turn ended, or on another day (never before the first). */
export function needsSeparator(previousEnd: string | null, start: string): boolean {
  if (!previousEnd) return false;
  const a = Date.parse(previousEnd);
  const b = Date.parse(start);
  return b - a > SEPARATOR_GAP_MS || dayStart(a) !== dayStart(b);
}

/** "Today 10:00", "Yesterday 18:42", "Nov 6, 09:15" ("Nov 6 2025, 09:15" in another year); locale time format. */
export function formatSeparator(iso: string, now: number, locale?: string): string {
  const t = Date.parse(iso);
  const time = new Date(t).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const days = Math.round((dayStart(now) - dayStart(t)) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  const sameYear = new Date(t).getFullYear() === new Date(now).getFullYear();
  const date = new Date(t).toLocaleDateString(locale, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
  return `${date}, ${time}`;
}
