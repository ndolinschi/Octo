/** Keyboard contract of every popup list (decision 95): which row a key makes active. Pure, so it is tested without a DOM. */

/**
 * The id a list key moves to among the enabled row ids: ↓ and ↑ wrap at both ends, Home and End jump; with no active row ↓ lands on
 * the first and ↑ on the last. Null for any other key or an empty list.
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
