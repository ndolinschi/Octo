import type { ErrorFields } from "@octo/agent-client";

/** The text of a caught value: an Error's message, else its string form. The one place errors become user-visible text. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The bridge's error code (`plan_not_pending`, `steer_unsupported` …) of a caught value; null for anything else. */
export function errorCode(e: unknown): string | null {
  return typeof e === "object" && e !== null && "code" in e && typeof e.code === "string" ? e.code : null;
}

/**
 * The structured failure of a caught value (decision 94b): the harness's plain `message` with `hint`, `command`, `action`
 * and `details` when they came. Null for anything that is not a bridge error. The UI shows these fields first.
 */
export function structuredError(e: unknown): ({ message: string } & ErrorFields) | null {
  if (!(e instanceof Error) || !("code" in e)) return null;
  const o = e as Error & ErrorFields;
  const out: { message: string } & ErrorFields = { message: e.message };
  if (o.hint) out.hint = o.hint;
  if (o.command) out.command = o.command;
  if (o.action) out.action = o.action;
  if (o.details) out.details = o.details;
  return out;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function formatRelative(iso: string, now: number): string {
  const diff = Math.max(0, now - Date.parse(iso));
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "2h ago", "just now", or a date for anything older than a week. */
export function timeAgo(iso: string, now: number): string {
  const rel = formatRelative(iso, now);
  if (rel === "now") return "just now";
  return /^\d+[mhd]$/.test(rel) ? `${rel} ago` : rel;
}

export function excerpt(markdown: string, max = 220): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#+\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\|.*\|\s*$/gm, " ")
    .replace(/\*\*|__|[*`]/g, "")
    .replace(/^>\s*/gm, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

export function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Shortens a long path or name in the middle, keeping its end (the file name / extension) visible. */
export function middleTruncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const slash = text.lastIndexOf("/");
  const tail = slash >= 0 && text.length - slash <= max - 8 ? text.slice(slash) : text.slice(-Math.ceil((max - 1) / 2));
  return `${text.slice(0, max - 1 - tail.length)}…${tail}`;
}

/** Token totals as a quiet count: 820, 2.4k, 24k, 1.2M, 1B. A value that rounds up to the next unit shows that unit. */
export function formatTokens(n: number): string {
  const scaled = (unit: number) => (n / unit).toFixed(1).replace(/\.0$/, "");
  if (n < 1000) return String(n);
  if (n < 10_000) return `${scaled(1e3)}k`;
  if (n < 999_500) return `${Math.round(n / 1e3)}k`;
  if (n < 999_950_000) return `${scaled(1e6)}M`;
  return `${scaled(1e9)}B`;
}

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
