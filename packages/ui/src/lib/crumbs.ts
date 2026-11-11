import { middleTruncate } from "./format";

/** Measured widths (px) of a breadcrumb's parts, each crumb including its own padding. */
export type CrumbWidths = {
  folder: number;
  dirs: readonly number[];
  /** The file crumb: icon + gap + name + padding. */
  file: number;
  /** The file crumb without its name. */
  fileChrome: number;
  sep: number;
  ellipsis: number;
  gap: number;
};

/**
 * Which crumbs show (P1 of the v6.1 review: collapse by measured fit, never by a fixed count). Tried in order, the
 * first that fits wins: everything · `folder › … › parent › file` · `… › parent › file` · `… › file` · the file alone.
 * `hidden` lists what the "…" crumb stands for (-1 = the folder, else a directory index), `nameChars` is set when even
 * the file alone does not fit: the name is shortened once, in the middle, to about that many characters.
 */
export type CrumbPlan = { folder: boolean; dirs: number[]; hidden: number[]; nameChars: number | null };

export function fitCrumbs(w: CrumbWidths, available: number, charWidth = 7): CrumbPlan {
  const n = w.dirs.length;
  const all = Array.from({ length: n }, (_, i) => i);
  const size = (folder: boolean, dirs: number[], ellipsis: boolean) => {
    const parts = [...(folder ? [w.folder] : []), ...(ellipsis ? [w.ellipsis] : []), ...dirs.map((i) => w.dirs[i] ?? 0), w.file];
    // Separators between parts (each sits between two gaps).
    return parts.reduce((a, b) => a + b, 0) + (parts.length - 1) * (w.sep + 2 * w.gap);
  };
  const last = n > 0 ? [n - 1] : [];
  const candidates: { folder: boolean; dirs: number[]; hidden: number[] }[] = [
    { folder: true, dirs: all, hidden: [] },
    ...(n >= 2 ? [{ folder: true, dirs: last, hidden: all.slice(0, -1) }] : []),
    ...(n >= 1 ? [{ folder: false, dirs: last, hidden: [-1, ...all.slice(0, -1)] }] : []),
    { folder: false, dirs: [], hidden: [-1, ...all] },
  ];
  for (const c of candidates) {
    if (size(c.folder, c.dirs, c.hidden.length > 0) <= available) return { ...c, nameChars: null };
  }
  const room = available - w.ellipsis - w.sep - 2 * w.gap;
  const base = { folder: false, dirs: [], hidden: [-1, ...all] };
  return { ...base, nameChars: Math.max(6, Math.floor((room - w.fileChrome) / charWidth)) };
}

/** The file crumb's text: the name, or shortened once in the middle (the extension stays). */
export function crumbName(name: string, plan: CrumbPlan): string {
  return plan.nameChars === null ? name : middleTruncate(name, plan.nameChars);
}
