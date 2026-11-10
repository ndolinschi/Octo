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
