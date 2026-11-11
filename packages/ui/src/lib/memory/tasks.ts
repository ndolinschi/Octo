import type { Task, TaskFact, TaskStatus } from "@octo/agent-client";

export type TaskFilter = TaskStatus | "all";
export const TASK_FILTERS: readonly { id: TaskFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "done", label: "Done" },
  { id: "dropped", label: "Dropped" },
];

export const STATUS_LABEL: Record<TaskStatus, string> = { open: "Open", done: "Done", dropped: "Dropped" };

/** How many tasks each filter shows (the filter's own count, shown beside its label). */
export function filterCounts(tasks: readonly Task[]): Record<TaskFilter, number> {
  const counts: Record<TaskFilter, number> = { all: tasks.length, open: 0, done: 0, dropped: 0 };
  for (const t of tasks) counts[t.status] += 1;
  return counts;
}

/** The tasks with the status, newest update first (the harness's order is not relied on). */
export function filterTasks(tasks: readonly Task[], filter: TaskFilter): Task[] {
  return tasks.filter((t) => filter === "all" || t.status === filter).sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
}

/** A fact with what replaced it: `by` is the newer fact, `byTask` is set when it lives in another task. */
export type FactRow = { fact: TaskFact; superseded: boolean; by: TaskFact | null; byTask: Task | null };

/**
 * A task's facts in the order they were learnt (oldest first, ties by id). `superseded_by` is a fact id of the same
 * task or `"<taskId>/<factId>"` when a later request opened another task; `by` is null when the replacement cannot be
 * found (a deleted task), the fact is still marked superseded.
 */
export function factRows(task: Task, all: readonly Task[] = [task]): FactRow[] {
  return [...task.facts]
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
    .map((fact) => {
      const ref = fact.superseded_by;
      if (ref === undefined) return { fact, superseded: false, by: null, byTask: null };
      const slash = ref.indexOf("/");
      const taskId = slash >= 0 ? ref.slice(0, slash) : task.id;
      const factId = slash >= 0 ? ref.slice(slash + 1) : ref;
      const owner = taskId === task.id ? task : all.find((t) => t.id === taskId);
      const by = owner?.facts.find((f) => f.id === factId) ?? null;
      return { fact, superseded: true, by, byTask: owner && owner.id !== task.id && by ? owner : null };
    });
}

/** The facts still true: not superseded. */
export function currentFacts(task: Task): TaskFact[] {
  return task.facts.filter((f) => f.superseded_by === undefined);
}

/** Where the goal came from, as a short caption; null when the orchestrator or the user's own wording is the source. */
export function goalNote(task: Task): string | null {
  if (task.goal_by === "harness") return "First words of the request";
  if (task.goal_by === "digest") return "Summarised after the turn";
  return null;
}

/** "Nov 11" for a timestamp, with the year when it is not this one. */
export function formatDay(iso: string, now: number, locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const year = d.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" as const };
  return d.toLocaleDateString(locale, { month: "short", day: "numeric", ...year });
}
