import { jsonCodec } from "../lib/storage";

/**
 * The file view's tree column: resizable 200–480 (decision 94a). Until someone drags it the width is `TREE_DEFAULT` (0,
 * "follow the view": `lib/treeLayout` gives it 40% of the file view, 220–360), and a double-click on its edge goes back to
 * that. 220 was the fixed default before (2026-11-19) and is what every untouched project has stored, so it reads as the default too.
 */
export const TREE_DEFAULT = 0;
export const TREE_MIN = 200;
export const TREE_MAX = 480;
const TREE_OLD_DEFAULT = 220;

export type Stored = { open: boolean; width: number };

export const clamp = (w: number) => Math.round(Math.min(TREE_MAX, Math.max(TREE_MIN, w)));

/** A width to store: the default stays the default, any other is clamped to the bounds. */
export const columnWidth = (w: number) => (w === TREE_DEFAULT ? TREE_DEFAULT : clamp(w));

/** Stored as `{"open": boolean, "width": number}` (`octo.fileTree.{projectId}`: the last values any group used, which a group without its own starts from), read field by field; anything missing or malformed reads as the defaults. */
export const treePrefCodec = jsonCodec<Stored>((v) => {
  const o: { open?: unknown; width?: unknown } = typeof v === "object" && v !== null ? v : {};
  const width = typeof o.width === "number" && Number.isFinite(o.width) && o.width !== TREE_OLD_DEFAULT ? columnWidth(o.width) : TREE_DEFAULT;
  return { open: typeof o.open === "boolean" ? o.open : true, width };
});

/** The stored tree preference as text. */
export function parseTreePref(raw: string | null): Stored {
  return treePrefCodec.parse(raw);
}
