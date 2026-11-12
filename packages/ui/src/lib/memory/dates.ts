/** "Nov 11" for a timestamp, with the year when it is not this one. */
export function formatDay(iso: string, now: number, locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const year = d.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" as const };
  return d.toLocaleDateString(locale, { month: "short", day: "numeric", ...year });
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/**
 * The short time at the right end of a row: "9:15 AM" for today, "Yesterday", else "Nov 11". Never wider than a
 * time of day, so the right column of a list stays narrow (decision 93).
 */
export function formatWhen(iso: string, now: number, locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (sameDay(d, new Date(now))) return d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  if (sameDay(d, new Date(now - 86_400_000))) return "Yesterday";
  return formatDay(iso, now, locale);
}
