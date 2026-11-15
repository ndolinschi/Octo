import type { RememberKind, Task, TaskFact, TaskStatus } from "@octo/agent-client";
import { formatDay } from "./dates";

export const TASK_FILTERS: readonly { id: TaskStatus; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "done", label: "Done" },
  { id: "dropped", label: "Dropped" },
];

export const STATUS_LABEL: Record<TaskStatus, string> = { open: "Open", done: "Done", dropped: "Dropped" };

/** How many tasks each filter shows (the filter's own count, shown beside its label). */
export function filterCounts(tasks: readonly Task[]): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = { open: 0, done: 0, dropped: 0 };
  for (const t of tasks) counts[t.status] += 1;
  return counts;
}

/** The tasks with the status, newest update first (the harness's order is not relied on). */
export function filterTasks(tasks: readonly Task[], status: TaskStatus): Task[] {
  return tasks.filter((t) => t.status === status).sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
}

/** The dim line of a task row: the first line of its goal. */
export function taskDescription(t: Task): string {
  const line = t.goal.split("\n").find((l) => l.trim() !== "");
  return line ? line.replace(/\s+/g, " ").trim() : "No goal written yet";
}

/** A remembered item: the current fact, with the earlier versions it replaced folded under it (decision 93 e). */
export type RememberedItem = { key: string; taskId: string; taskTitle: string; fact: TaskFact; earlier: TaskFact[] };

const MAX_CHAIN = 32;

/**
 * Every fact still true, newest first. A fact another one replaced (`superseded_by` is a fact id of its task or
 * `"<taskId>/<factId>"`) is never listed by itself: it is attached, newest first, to the fact at the end of its chain.
 * A replaced fact whose replacement cannot be found (a deleted task) is left out; search still finds it.
 */
export function rememberedItems(tasks: readonly Task[]): RememberedItem[] {
  const byKey = new Map<string, { task: Task; fact: TaskFact }>();
  for (const task of tasks) for (const fact of task.facts) byKey.set(`${task.id}/${fact.id}`, { task, fact });
  const items = new Map<string, RememberedItem>();
  for (const [key, { task, fact }] of byKey) {
    if (fact.superseded_by === undefined) items.set(key, { key, taskId: task.id, taskTitle: task.title, fact, earlier: [] });
  }
  for (const { task, fact } of byKey.values()) {
    if (fact.superseded_by === undefined) continue;
    let ref = fact.superseded_by;
    let owner = task;
    for (let hops = 0; hops < MAX_CHAIN; hops++) {
      const key = ref.includes("/") ? ref : `${owner.id}/${ref}`;
      const next = byKey.get(key);
      if (!next) break;
      if (next.fact.superseded_by === undefined) {
        items.get(key)?.earlier.push(fact);
        break;
      }
      ref = next.fact.superseded_by;
      owner = next.task;
    }
  }
  const newest = (a: TaskFact, b: TaskFact) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id);
  const list = [...items.values()];
  for (const item of list) item.earlier.sort(newest);
  return list.sort((a, b) => newest(a.fact, b.fact) || a.key.localeCompare(b.key));
}

const KIND_LABEL: Record<RememberKind, string | null> = { fact: null, decision: "Decision", preference: "Preference", todo: "To do" };

/** The kind as people read it; a plain fact (the default, and every fact the harness learnt itself) carries no label. */
export function kindLabel(kind: RememberKind | undefined): string | null {
  return kind === undefined ? null : KIND_LABEL[kind];
}

/** Who kept an item, as a name: "You" for the user, the agent's own name when known, else "Octo". */
export function keeperName(by: string | undefined, agentName: (id: string) => string | null): string | null {
  if (by === undefined) return null;
  return by === "user" ? "You" : (agentName(by) ?? "Octo");
}

/**
 * The dim line of a remembered row: its kind and how many versions it replaced. The subject is the group's header, so it is
 * not repeated; "" when there is nothing to say, and the row is then one line.
 */
export function itemDescription(item: RememberedItem): string {
  const n = item.earlier.length;
  return [kindLabel(item.fact.kind), n > 0 ? `${n} earlier ${n === 1 ? "version" : "versions"}` : null].filter(Boolean).join(" · ");
}

export const GENERAL = "General";

/** Remembered items of one subject (the fact's `about`; "General" when it has none), newest first. */
export type RememberedGroup = { key: string; subject: string; items: RememberedItem[]; newest: string };

/** Items grouped by subject; the group touched most recently first (ties by name). Items keep their order. */
export function rememberedGroups(items: readonly RememberedItem[]): RememberedGroup[] {
  const groups = new Map<string, RememberedGroup>();
  for (const item of items) {
    const subject = item.fact.about?.trim() || GENERAL;
    const g = groups.get(subject) ?? { key: subject, subject, items: [], newest: "" };
    g.items.push(item);
    if (item.fact.date > g.newest) g.newest = item.fact.date;
    groups.set(subject, g);
  }
  return [...groups.values()].sort((a, b) => b.newest.localeCompare(a.newest) || a.subject.localeCompare(b.subject));
}

/** "Remembered by Octo · Nov 12", or "Noted · Nov 12" for a fact nobody kept on purpose. */
export function sourceText(fact: TaskFact, keeper: string | null, now: number): string {
  return `${keeper ? `Remembered by ${keeper}` : "Noted"} · ${formatDay(fact.date, now)}`;
}

/** A fact is repeated in its open row only when the one-line row may have cut it (or it has several lines). */
export const FACT_ROW_CHARS = 56;
export function needsFullFact(text: string): boolean {
  const t = text.trim();
  return t.includes("\n") || t.length > FACT_ROW_CHARS;
}

export const FOLD_LIMIT = 8;
/** Items shown per group before "Show N more". */
export const GROUP_FOLD = 5;

/** The first `limit` of a long list unless it is unfolded, and how many are left out. */
export function fold<T>(items: readonly T[], unfolded: boolean, limit = FOLD_LIMIT): { shown: T[]; hidden: number } {
  if (unfolded || items.length <= limit + 1) return { shown: [...items], hidden: 0 };
  return { shown: items.slice(0, limit), hidden: items.length - limit };
}
