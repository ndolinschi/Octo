export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function agentDuration(
  agent: { started_at: string | null; finished_at: string | null },
  now: number,
): number | null {
  if (!agent.started_at) return null;
  const start = Date.parse(agent.started_at);
  const end = agent.finished_at ? Date.parse(agent.finished_at) : now;
  return end - start;
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
