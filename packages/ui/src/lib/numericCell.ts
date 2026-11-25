/**
 * A table cell that holds a number: 1,284 · €2,418,903.17 · 12% · 3.1k · −4 · 240ms (an empty cell or "—" passes). Its own
 * module: Markdown (initial bundle) needs only this, not the table parser (`table.ts`, lazy).
 */
export const NUMERIC_CELL = /^(?:[-+−]?[$€£]?\s?\d[\d,.\s]*(?:%|k|K|M|B|ms|s|x|×)?|—|–|-|)$/;
