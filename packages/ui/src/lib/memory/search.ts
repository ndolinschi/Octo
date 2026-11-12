import type { MemoryHit, MemorySearchKind, MemorySearchParams } from "@octo/agent-client";

export const SEARCH_KINDS: readonly { id: MemorySearchKind; label: string }[] = [
  { id: "tasks", label: "Tasks" },
  { id: "facts", label: "Facts" },
  { id: "files", label: "Files" },
  { id: "messages", label: "Messages" },
  { id: "exchanges", label: "Exchanges" },
];

export type SearchForm = {
  q: string;
  /** Empty means every kind. */
  kinds: MemorySearchKind[];
  /** `YYYY-MM-DD` from a date input, or "". */
  after: string;
  before: string;
};

export const EMPTY_SEARCH: SearchForm = { q: "", kinds: [], after: "", before: "" };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Why a form cannot be sent, or null: an empty query, a date that is not a day, or an inverted range. */
export function searchProblem(f: SearchForm): string | null {
  if (f.q.trim() === "") return "Type what to look for";
  if ((f.after && !DAY.test(f.after)) || (f.before && !DAY.test(f.before))) return "Dates are written year-month-day";
  if (f.after && f.before && f.after >= f.before) return "The end date is not after the start date";
  return null;
}

/** The query for `searchMemory`: all kinds and no dates are left out; `after` is inclusive, `before` exclusive. */
export function searchParams(f: SearchForm): MemorySearchParams {
  const p: MemorySearchParams = { q: f.q.trim() };
  if (f.kinds.length > 0 && f.kinds.length < SEARCH_KINDS.length) p.in = SEARCH_KINDS.map((k) => k.id).filter((id) => f.kinds.includes(id));
  if (f.after) p.after = f.after;
  if (f.before) p.before = f.before;
  return p;
}

export function toggleKind(kinds: readonly MemorySearchKind[], kind: MemorySearchKind): MemorySearchKind[] {
  return kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind];
}

/** Current hits first, superseded ones after (the harness already does this; a bridge that does not is corrected). Stable. */
export function orderHits(hits: readonly MemoryHit[]): MemoryHit[] {
  return [...hits.filter((h) => !h.superseded), ...hits.filter((h) => h.superseded)];
}

export const NOTHING_MATCHES = "Nothing in memory matches";

/** The empty-result text: the harness's message when it sent one, else the fixed sentence. */
export function emptyText(message: string | undefined): string {
  return message && message.trim() !== "" ? message.charAt(0).toUpperCase() + message.slice(1) : NOTHING_MATCHES;
}

export const HIT_KIND_LABEL: Record<MemoryHit["kind"], string> = { task: "Task", fact: "Fact", file: "File", message: "Message", exchange: "Exchange" };

/** Where a hit opens: a task (a fact opens its task and marks the fact), a file, a message in the chat, or an exchange in its session. */
export type HitTarget =
  | { to: "task"; taskId: string; factId: string | null }
  | { to: "file"; path: string }
  | { to: "message"; messageId: number }
  | { to: "session"; sessionId: string; exchangeId: string }
  | null;

/** A fact id as hits and receipts spell it: `<taskId>/<factId>`. */
export function splitFactId(id: string): { taskId: string; factId: string } | null {
  const i = id.indexOf("/");
  return i > 0 && i < id.length - 1 ? { taskId: id.slice(0, i), factId: id.slice(i + 1) } : null;
}

export function hitTarget(hit: MemoryHit): HitTarget {
  switch (hit.kind) {
    case "task":
      return { to: "task", taskId: hit.id, factId: null };
    case "fact": {
      const ref = splitFactId(hit.id);
      const taskId = hit.task_id ?? ref?.taskId;
      return taskId ? { to: "task", taskId, factId: ref?.factId ?? null } : null;
    }
    case "file":
      return { to: "file", path: hit.id };
    case "exchange":
      return hit.session_id ? { to: "session", sessionId: hit.session_id, exchangeId: hit.id } : null;
    case "message": {
      const n = Number(hit.id);
      return Number.isInteger(n) ? { to: "message", messageId: n } : null;
    }
  }
}
