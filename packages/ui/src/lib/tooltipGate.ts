/**
 * Whether a waiting tooltip may still show when its delay ends (item 14): its control is still in the page, is still the
 * one armed, and — for a tooltip the pointer armed — still under the pointer (a row that moved or was replaced while the
 * pointer left must not show a tooltip nobody points at). Keyboard focus needs no hover.
 */
export function tipMayShow(t: { armed: boolean; connected: boolean; byPointer: boolean; hovered: boolean }): boolean {
  return t.armed && t.connected && (!t.byPointer || t.hovered);
}
