/** A thrown value from `invoke` (a string for command errors, an Error otherwise) as one readable line. */
export function errorMessage(e: unknown): string {
  if (typeof e === "string" && e.trim()) return e.trim();
  if (e instanceof Error && e.message) return e.message;
  return "Octo's local service could not be started.";
}
