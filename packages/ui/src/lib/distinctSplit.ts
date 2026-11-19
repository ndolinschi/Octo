import { cutAt, middleSplit, type MiddleSplit } from "./truncate";

/** A shared head shorter than this is no reason to cut: the start already tells the names apart. */
const SHARED_MIN = 6;
/** The longest last segment (with its slash) a path keeps whole at its end. */
const PATH_TAIL_MAX = 24;

/**
 * `middleSplit` for a name that must stay distinguishable (2026-11-19). With `siblings` (the other names shown beside it: a
 * project's folders) the tail is everything after the longest head it shares with one of them, from the word break before
 * the difference: "product-configuration-management-system" beside "product-configuration-facade-service" reads
 * "product-con…management-system" / "product-con…facade-service", not "product-configuration-ma…" twice. A path without
 * spaces (a compact folder chain: "src/main/java", or a Java package "com.wsgc.….subsystem") keeps its last segment whole.
 * Otherwise the plain middle cut.
 */
export function distinctSplit(text: string, siblings: readonly string[] = []): MiddleSplit | null {
  const chars = Array.from(text);
  const shared = sharedHead(chars, siblings);
  if (shared >= SHARED_MIN && shared < chars.length) return { ...cutAt(chars, shared), distinct: true };
  const slash = Math.max(chars.lastIndexOf("/"), chars.lastIndexOf("."));
  if (chars.length > 14 && slash > 0 && !chars.some((c) => /\s/.test(c)) && chars.length - slash <= PATH_TAIL_MAX) return cutAt(chars, slash);
  return middleSplit(text);
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
  for (let i = longest; i > 0; i--) if (/[-_./\s]/u.test(chars[i - 1] ?? "")) return i;
  return longest;
}
