/** A read in progress, failed or done (the Memory view's four tabs share it). */
export type Load<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; value: T };

/** A bridge error that means "not there": a receipt for a turn from before receipts, a file that was deleted. */
export function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && "status" in e && e.status === 404;
}
