/**
 * The jump side of the turn window's protocol (`useTurnWindow`): a module of its own so the eager jump code (`turnTracking`)
 * does not pull the transcript's chunk into the entry.
 */
export const MOUNT_EVENT = "octo:turn-mount";

/** Mounts the turn of `section` (and its neighbours) now, so a jump measures its real prompt (`turnTracking`). */
export function revealTurn(section: HTMLElement): void {
  section.dispatchEvent(new Event(MOUNT_EVENT, { bubbles: true }));
}
