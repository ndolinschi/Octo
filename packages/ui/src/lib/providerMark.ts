/**
 * 6f: the neutral provider mark's initial in whole pixels, never under 9px: `null` (the shape alone) below a 20px mark,
 * where the letter would be 7.5px or less; else the pixel size and the font size in the mark's 16-unit viewBox.
 */
export function markInitial(size: number): { px: number; units: number } | null {
  const px = Math.round((7.5 * size) / 16);
  if (px < 9) return null;
  return { px, units: (px * 16) / size };
}
