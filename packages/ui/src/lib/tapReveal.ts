/** How long a tapped-open action stays shown when nothing else happens (A2, phone). */
export const REVEAL_MS = 5000;

/**
 * Whether a tap on an element toggles its revealed action: not when the tap landed on a control inside it (a link, "Show
 * more") or ended a text selection, which keep their own meaning.
 */
export function revealOnTap(onControl: boolean, selecting: boolean): boolean {
  return !onControl && !selecting;
}
