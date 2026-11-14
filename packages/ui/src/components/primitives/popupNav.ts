/**
 * Keyboard contract of every popup list (decision 95), written once here and used by every list (`PopupList` through its
 * owners — the slash and mention menus, the "+" menu, `Picker`, the model picker —, `Menu`, the command palette). Pure, so
 * it is tested without a DOM.
 *
 * - ↓ / ↑ move the active row and wrap at both ends; with no active row ↓ lands on the first and ↑ on the last.
 * - Home / End depend on where the keys come from:
 *   - a list whose keys come from a text field the person types in (the composer's text under the slash and mention menus,
 *     the search field of the "+" menu and of every picker): Home / End move the caret in the field, as in any text field;
 *     Ctrl+Home / Ctrl+End (Cmd on macOS) jump to the first / last row;
 *   - a list with no text field (`Menu`): Home / End jump to the first / last row.
 * - Tab has one meaning per kind of list:
 *   - in the two typing menus (slash, mention) Tab accepts the active row: it is a completion of what is typed (so is the
 *     folder picker's path completion, which replaces the query with the active folder's path and keeps the list open);
 *   - in every other list Tab and Shift+Tab move focus, and an anchored popup never lets focus leave it while it is open:
 *     they cycle through its focusable elements (`Popover`, the "+" menu, `Menu`'s items). If focus leaves anyway (a click
 *     elsewhere, a programmatic focus) the popup closes.
 * - Enter runs the active row; Escape closes and focus goes back to the opener (the text for the typing menus).
 */

/** The parts of a keyboard event the contract reads. */
export type ListKeyEvent = { key: string; ctrlKey: boolean; metaKey: boolean };

type ListKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

/**
 * The list key an event is under the contract, or null when it is not the list's (the field keeps it). `typing`: the keys come
 * from a text field the person types in, so plain Home / End stay with the caret and only Ctrl / Cmd + Home / End jump.
 */
export function popupListKey(e: ListKeyEvent, typing: boolean): ListKey | null {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") return e.key;
  if (e.key !== "Home" && e.key !== "End") return null;
  return !typing || e.ctrlKey || e.metaKey ? e.key : null;
}

/** `popupTarget` for a keyboard event under the contract (`popupListKey`): the id to make active, or null when the key is not the list's. */
export function popupMove(e: ListKeyEvent, typing: boolean, ids: readonly string[], active: string | null): string | null {
  const key = popupListKey(e, typing);
  return key === null ? null : popupTarget(key, ids, active);
}

/**
 * The id a list key moves to among the enabled row ids: ↓ and ↑ wrap at both ends, Home and End jump; with no active row ↓ lands on
 * the first and ↑ on the last. Null for any other key or an empty list. A caller with a keyboard event uses `popupMove`.
 */
export function popupTarget(key: string, ids: readonly string[], active: string | null): string | null {
  if (ids.length === 0) return null;
  const at = active === null ? -1 : ids.indexOf(active);
  if (key === "Home") return ids[0] ?? null;
  if (key === "End") return ids[ids.length - 1] ?? null;
  if (key !== "ArrowDown" && key !== "ArrowUp") return null;
  const step = key === "ArrowDown" ? 1 : -1;
  if (at < 0) return (step > 0 ? ids[0] : ids[ids.length - 1]) ?? null;
  return ids[(at + step + ids.length) % ids.length] ?? null;
}

/**
 * A gate for `pointermove` on rows: true only when the pointer really moved. A list that scrolls (or appears) under a resting
 * mouse makes the browser fire a move with the same coordinates; letting it through would take the active row away from the keys.
 * The first event only records the position.
 */
export function createPointerGate(): (e: { clientX: number; clientY: number }) => boolean {
  let last: { x: number; y: number } | null = null;
  return (e) => {
    const moved = last !== null && (last.x !== e.clientX || last.y !== e.clientY);
    last = { x: e.clientX, y: e.clientY };
    return moved;
  };
}
