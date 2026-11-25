import { matchScore } from "./match";

/** How `text` matches: at a word start (incl. the very start), mid-word, as a loose subsequence, or not at all. */
export type MatchKind = "word" | "inside" | "fuzzy" | null;

export function matchKind(query: string, text: string): MatchKind {
  if (matchScore(query, text) < 0) return null;
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  const at = t.indexOf(q);
  if (at < 0) return "fuzzy";
  // Any occurrence at a word start counts, not only the first one.
  for (let i = at; i >= 0; i = t.indexOf(q, i + 1)) if (i === 0 || /[\s\-_/.:(]/.test(t.charAt(i - 1))) return "word";
  return "inside";
}

const KIND_RANK: Record<Exclude<MatchKind, null>, number> = { word: 0, inside: 1, fuzzy: 2 };

/**
 * Orders result groups for a query (the palette): a group whose best row matches at a word start comes before one
 * whose best row only matches mid-word or loosely — so "integr" finds "Open integrations" (Actions) before a project
 * named "Infrastructure…" that only matches letter by letter. Ties keep the groups' own order. Empty query: unchanged.
 */
export function rankGroups<G>(query: string, groups: readonly G[], labels: (g: G) => readonly string[]): G[] {
  if (!query.trim()) return [...groups];
  const best = (g: G) => {
    let rank = 3;
    let score = -1;
    for (const l of labels(g)) {
      const k = matchKind(query, l);
      if (k === null) continue;
      const r = KIND_RANK[k];
      const sc = matchScore(query, l);
      if (r < rank || (r === rank && sc > score)) {
        rank = r;
        score = sc;
      }
    }
    return rank;
  };
  return groups
    .map((g, i) => ({ g, i, rank: best(g) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.g);
}
