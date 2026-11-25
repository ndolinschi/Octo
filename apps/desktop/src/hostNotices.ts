/** Something the Tauri shell wants the person to know without blocking them (`bridge_notices`). */
export interface HostNotice {
  kind: string;
  message: string;
  logTail: string;
}

/**
 * The `bridge_notices` result as notices: `[{ kind, message, log_tail }]`. Tolerant of anything else (an older shell
 * without the command, a malformed entry): such entries are dropped, never thrown on.
 */
export function parseNotices(raw: unknown): HostNotice[] {
  if (!Array.isArray(raw)) return [];
  const out: HostNotice[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.kind !== "string" || typeof r.message !== "string" || !r.message.trim()) continue;
    out.push({ kind: r.kind, message: r.message.trim(), logTail: typeof r.log_tail === "string" ? r.log_tail : "" });
  }
  return out;
}

/** The one-line text of a notice: the router notice says what still works. */
export function noticeSummary(n: HostNotice): string {
  if (n.kind === "router_failed") return `The Octo router did not start. Octo works without it. ${n.message}`;
  return n.message;
}
