/**
 * P2-4: a read that is never answered (a proxy that hangs, a half-written response) must not hold a first load forever: it
 * fails after `ms` with the code `unanswered`, and the caller's retry policy takes over. The read itself is not aborted.
 */
export class DeadlineError extends Error {
  readonly code = "unanswered";
  constructor() {
    super("Octo's local service didn't answer in time.");
    this.name = "DeadlineError";
  }
}

/** How long a first-load read (health, config, projects, a project, its sessions, the providers) may take. */
export const READ_DEADLINE_MS = 10_000;

/** `p`, or a `DeadlineError` when it has not settled within `ms`. */
export function withDeadline<T>(p: Promise<T>, ms: number = READ_DEADLINE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError()), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** Whether `e` is a read that ran out of time. */
export function isUnanswered(e: unknown): boolean {
  return e instanceof DeadlineError;
}
