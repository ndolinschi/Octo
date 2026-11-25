// The turn rail (a lazy chunk) is the only reader: apart from `transcript`, which the entry imports.
/**
 * The request rail's tick pitch and list height (decision 57, N7). With room the pitch grows to 16; a tick's target stays
 * at least 12 tall as long as the conversation's height holds the ticks at that pitch (the rail may then pass its 60% share);
 * only past that do the cells shrink (to 6 at least, each the part of the rail nearest its tick) and the rail scroll.
 * `maxHeight` is the room beside the conversation; `edge` the padding above the first and below the last tick.
 */
export function railLayout(n: number, maxHeight: number, edge: number): { pitch: number; height: number } {
  const count = Math.max(1, n);
  const share = Math.max(RAIL_MIN_PITCH * 3, Math.floor(maxHeight * RAIL_SHARE));
  const full = Math.max(share, maxHeight - 2 * edge);
  const fit = Math.floor(share / count);
  const pitch =
    fit >= RAIL_MIN_TARGET
      ? Math.min(RAIL_MAX_PITCH, fit)
      : count * RAIL_MIN_TARGET <= full
        ? RAIL_MIN_TARGET
        : Math.max(RAIL_MIN_PITCH, Math.floor(full / count));
  return { pitch, height: Math.min(pitch >= RAIL_MIN_TARGET ? Math.max(share, pitch * count) : full, pitch * count) + 2 * edge };
}
const RAIL_MIN_PITCH = 6;
const RAIL_MIN_TARGET = 12;
const RAIL_MAX_PITCH = 16;
const RAIL_SHARE = 0.6;
