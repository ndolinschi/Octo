/**
 * The Octo commands whose answer waits for the model (`/clear` and `/compact` summarise the conversation first, seconds with a real
 * model): the composer says so at once instead of leaving the old conversation on screen without a word.
 */
const PENDING: Readonly<Record<string, string>> = {
  clear: "Starting a new session…",
  compact: "Compacting the conversation…",
};

/** The calm line for a command that is running, or null for one that answers at once. */
export function pendingLine(name: string): string | null {
  return Object.hasOwn(PENDING, name) ? (PENDING[name] ?? null) : null;
}
