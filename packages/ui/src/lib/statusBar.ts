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

/** Projects with an agent at work: "1 working" / "3 working"; null when none (the item is not shown). */
export function workingText(projectsRunning: number): string | null {
  return projectsRunning > 0 ? `${projectsRunning} working` : null;
}

/** The connection item: only when the bridge is not fine, and what to do. */
export function connectionText(
  health: "checking" | "online" | "offline",
  cause: "refused" | "unreadable" | null = null,
): { text: string; hint: string } | null {
  if (health === "online") return null;
  // A15: it answered, and refused this window's token.
  // A15 / P2-4: it answered, so not "offline"; the notice above says what to do.
  if (cause)
    return {
      text: cause === "refused" ? "Access refused" : "Unreadable answer",
      hint: "Octo's local service answered but can't be used. See the notice above.",
    };
  return health === "offline"
    ? { text: "Bridge offline", hint: "Nothing answers at the bridge address. Start the bridge, then select to retry." }
    : { text: "Connecting…", hint: "Checking the bridge." };
}
