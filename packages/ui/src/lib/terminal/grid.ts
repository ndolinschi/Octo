/**
 * The terminal's columns and rows for a box, computed the way xterm's fit addon does (the box minus the scrollbar, divided
 * by the cell), from a cell measured without xterm. The tab starts the shell with this before xterm is built, so the
 * session request does not wait for the construction; the fit that follows corrects an estimate that is one off.
 */
export type GridBox = { width: number; height: number; cellWidth: number; cellHeight: number; scrollbar: number };

/** xterm's `ViewportConstants.DEFAULT_SCROLL_BAR_WIDTH`, which the fit addon subtracts when there is scrollback. */
export const XTERM_SCROLLBAR = 14;

export function estimateGrid(box: GridBox): { cols: number; rows: number } | null {
  if (!(box.cellWidth > 0) || !(box.cellHeight > 0) || !(box.width > 0) || !(box.height > 0)) return null;
  return {
    cols: Math.max(2, Math.floor((box.width - box.scrollbar) / box.cellWidth)),
    rows: Math.max(1, Math.floor(box.height / box.cellHeight)),
  };
}

/** One cell of a monospace font, as xterm measures it (32 glyphs wide; the height of a line at `normal`, times the line height). */
export function measureCell(font: string, fontSize: number, lineHeight: number): { width: number; height: number } | null {
  if (typeof document === "undefined") return null;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return null;
  ctx.font = `${fontSize}px ${font}`;
  const m = ctx.measureText("W".repeat(32));
  const line = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
  if (!(line > 0)) return null;
  return { width: m.width / 32, height: Math.floor(line * lineHeight) };
}
