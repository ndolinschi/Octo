/**
 * P2-12: "now" on the service's clock. When this machine's clock is off by more than 30 s (the offset comes from the
 * `Date` header of the service's answers, `Bridge.clockOffset`), relative times ("2m ago") are measured against the clock
 * that stamped the messages, so a fresh answer never reads "3d ago".
 */
let offset = 0;
const listeners = new Set<() => void>();

export function setClockOffset(ms: number): void {
  const next = Number.isFinite(ms) ? ms : 0;
  if (next === offset) return;
  offset = next;
  // Clocks already on screen read the corrected time now, not at their next tick.
  for (const l of listeners) l();
}

export function onClockOffset(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function clockNow(): number {
  return Date.now() + offset;
}
