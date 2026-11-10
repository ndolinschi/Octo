/** The file view's tree column: 280px by default, resizable 200–480 (contract v6 decision 4). */
export const TREE_DEFAULT = 280;
export const TREE_MIN = 200;
export const TREE_MAX = 480;

export type Stored = { open: boolean; width: number };

export const clamp = (w: number) => Math.round(Math.min(TREE_MAX, Math.max(TREE_MIN, w)));

/** The stored tree preference; anything missing or malformed reads as the defaults. */
export function parseTreePref(raw: string | null): Stored {
  try {
    const parsed = JSON.parse(raw ?? "null") as Partial<Stored> | null;
    return {
      open: typeof parsed?.open === "boolean" ? parsed.open : true,
      width: typeof parsed?.width === "number" && Number.isFinite(parsed.width) ? clamp(parsed.width) : TREE_DEFAULT,
    };
  } catch {
    return { open: true, width: TREE_DEFAULT };
  }
}
