/** Pure parts of the status bar (decision 73). */

/** Distinct files changed across the turns (a file changed in two turns counts once). */
export function changedFileCount(turns: readonly { files: readonly { path: string; folder?: string }[] }[]): number {
  const seen = new Set<string>();
  for (const t of turns) for (const f of t.files) seen.add(`${f.folder ?? ""}\u0001${f.path}`);
  return seen.size;
}

/** "1 changed file" / "3 changed files". */
export function changedText(n: number): string {
  return `${n} changed ${n === 1 ? "file" : "files"}`;
}

/** Projects with an agent at work: "1 project working" / "3 projects working" (the unit said: the count is of projects); null when none (the item is not shown). */
export function workingText(projectsRunning: number): string | null {
  return projectsRunning > 0 ? `${projectsRunning} ${projectsRunning === 1 ? "project" : "projects"} working` : null;
}

/** UX-03: a project whose agent waits for the person (an approval, a form) counts as waiting, not working: waiting wins. */
export function projectCounts(projects: readonly { status: string; needs_you?: boolean; attention?: string }[] | null | undefined): {
  working: number;
  waiting: number;
} {
  let working = 0;
  let waiting = 0;
  for (const p of projects ?? []) {
    if (p.needs_you === true || p.attention === "needs_you") waiting++;
    else if (p.status === "running") working++;
  }
  return { working, waiting };
}

/** UX-03: "1 project needs you" / "2 projects need you"; null when none. */
export function waitingText(projectsWaiting: number): string | null {
  return projectsWaiting > 0 ? `${projectsWaiting} ${projectsWaiting === 1 ? "project needs" : "projects need"} you` : null;
}

/** UX-03: the window title says when the open project waits for the person, ahead of its name. */
export function windowTitle(title: string, needsYou: boolean): string {
  return `${needsYou ? "Needs you · " : ""}${title} · Octo`;
}

/** The connection item: only when the bridge is not fine, and what to do. */
export function connectionText(
  health: "checking" | "online" | "offline",
  cause: "refused" | "unreadable" | "unanswered" | null = null,
): { text: string; hint: string } | null {
  if (health === "online") return null;
  // P2-4: it took the connection and never answered; Octo keeps trying.
  if (cause === "unanswered") return { text: "Not answering", hint: "Octo's local service didn't answer in time. Octo keeps trying; select to retry now." };
  // A15: it answered, and refused this window's token.
  // A15 / P2-4: it answered, so not "offline"; the notice above says what to do.
  if (cause)
    return {
      text: cause === "refused" ? "Access refused" : "Unreadable answer",
      hint: "Octo's local service answered but can't be used. See the notice above.",
    };
  return health === "offline"
    ? { text: "Offline", hint: "Octo's local service isn't answering. Select to retry now." }
    : { text: "Connecting…", hint: "Checking Octo's local service." };
}
