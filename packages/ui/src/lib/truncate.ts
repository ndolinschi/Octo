/**
 * Middle truncation without a character budget (the CSS does the cutting): the label is split into a head that may shrink
 * with an ellipsis and a tail that never does, so "product-configura…nager" keeps its last characters. A short label is one
 * plain span (null). Used by `MiddleText` (chips, list rows, file-tree roots, the status bar, the sidebar's project meta).
 *
 * With `siblings` (the other names shown beside it: a project's folders), the tail is the part that tells this name apart:
 * everything after the longest head it shares with a sibling, from the word break before it. "product-configuration-
 * management-system" beside "product-configuration-facade-service" splits after "product-configuration-", so the two read
 * "product-con…management-system" and "product-con…facade-service" instead of one "product-configuration-ma…" twice.
 * Lengths count code points, so a cut never splits a surrogate pair.
 */
export const MIDDLE_MIN_LENGTH = 14;
const MIDDLE_TAIL_MAX = 8;
/** A shared head shorter than this is no reason to cut: the start already tells the names apart. */
const SHARED_MIN = 6;

export type MiddleSplit = { head: string; tail: string; distinct?: true };

export function middleSplit(text: string, siblings: readonly string[] = []): MiddleSplit | null {
  const chars = Array.from(text);
  const shared = sharedHead(chars, siblings);
  if (shared >= SHARED_MIN && shared < chars.length) return { ...cut(chars, shared), distinct: true };
  if (chars.length <= MIDDLE_MIN_LENGTH) return null;
  return cut(chars, chars.length - Math.min(MIDDLE_TAIL_MAX, Math.floor(chars.length / 3)));
}

function cut(chars: string[], at: number): MiddleSplit {
  const head = chars.slice(0, at).join("");
  const tail = chars.slice(at).join("");
  // A space at the cut would collapse at the edge of either span ("Claude Code ·Sonnet"): it moves to the tail's start as
  // a no-break space, which keeps its width.
  if (!/\s$/.test(head) && !/^\s/.test(tail)) return { head, tail };
  return { head: head.trimEnd(), tail: ` ${tail.trimStart()}` };
}

/** Code points of the longest head `chars` shares with any sibling, moved back to just after a word break (- _ . / space). */
function sharedHead(chars: string[], siblings: readonly string[]): number {
  let longest = 0;
  for (const s of siblings) {
    const other = Array.from(s);
    if (other.length === chars.length && other.every((c, i) => c === chars[i])) continue;
    let n = 0;
    while (n < chars.length && n < other.length && chars[n] === other[n]) n++;
    longest = Math.max(longest, n);
  }
  if (longest === 0) return 0;
  // Back to the last break inside the shared head ("product-configuration-ma" → "product-configuration-").
  for (let i = longest; i > 0; i--) if (/[-_./\s]/u.test(chars[i - 1] ?? "")) return i;
  return longest;
}
