import { jsonCodec } from "../lib/storage";

/** The file view's tree column: 220px by default, resizable 200–480 (decision 94a; was 280). */
export const TREE_DEFAULT = 220;
export const TREE_MIN = 200;
export const TREE_MAX = 480;

export type Stored = { open: boolean; width: number };

export const clamp = (w: number) => Math.round(Math.min(TREE_MAX, Math.max(TREE_MIN, w)));

/** Stored as `{"open": boolean, "width": number}` (`octo.fileTree.{projectId}`: the last values any group used, which a group without its own starts from), read field by field; anything missing or malformed reads as the defaults. */
export const treePrefCodec = jsonCodec<Stored>((v) => {
  const o: { open?: unknown; width?: unknown } = typeof v === "object" && v !== null ? v : {};
  return {
    open: typeof o.open === "boolean" ? o.open : true,
    width: typeof o.width === "number" && Number.isFinite(o.width) ? clamp(o.width) : TREE_DEFAULT,
  };
});

/** The stored tree preference as text. */
export function parseTreePref(raw: string | null): Stored {
  return treePrefCodec.parse(raw);
}
