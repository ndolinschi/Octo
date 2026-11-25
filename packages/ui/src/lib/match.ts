/**
 * Ranks `text` against `query`: a substring scores by how early (and whether at a word start) it
 * appears; otherwise the query's characters in order (fuzzy) score lower. -1 = no match.
 */
export function matchScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  const at = t.indexOf(q);
  if (at >= 0) {
    const wordStart = at === 0 || /[\s\-_/.:(]/.test(t.charAt(at - 1));
    return 1000 - Math.min(at, 500) + (wordStart ? 200 : 0);
  }
  let pos = 0;
  let gaps = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const next = t.indexOf(ch, pos);
    if (next < 0) return -1;
    gaps += next - pos;
    pos = next + 1;
  }
  return Math.max(1, 500 - gaps);
}

/**
 * How an item with a label and a second text (a description, keywords) matches: `sub` when the whole query is a substring
 * of the label, or every word of it is somewhere in label + second text (the second text ranks below any label hit);
 * otherwise a loose letter-by-letter match of the label (`sub` false, score -1 for none).
 */
export function fieldScore(query: string, label: string, more: string | undefined = ""): { score: number; sub: boolean } {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, sub: false };
  const l = label.toLowerCase();
  const own = matchScore(q, label);
  if (l.includes(q)) return { score: own, sub: true };
  const words = q.split(/\s+/);
  if (words.every((w) => `${l} ${more.toLowerCase()}`.includes(w))) return { score: words.every((w) => l.includes(w)) ? 400 : 200, sub: true };
  return { score: own, sub: false };
}

/**
 * The best `limit` of `items` for `query`, best first (ties keep their order); an empty query keeps the first `limit`. With
 * `strict` the loose letter-by-letter matches are dropped (the caller passes it when any item anywhere is a real hit).
 */
export function rankMatches<T>(
  query: string,
  items: readonly T[],
  fields: (i: T) => readonly [string, (string | undefined)?],
  limit: number,
  strict = false,
): T[] {
  if (!query.trim()) return items.slice(0, limit);
  return items
    .map((item, i) => ({ item, i, ...fieldScore(query, ...fields(item)) }))
    .filter((x) => (strict ? x.sub : x.score >= 0))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.item);
}
