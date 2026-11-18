/** Longest automatic title, in characters, before the ellipsis (the harness's `projectstore.SessionTitle`). */
const MAX = 80;

/**
 * A session's title from its first request, as the harness makes it (`projectstore.SessionTitle`): the first line; a longer
 * one is cut at the last space at or before 80 characters (at 80 when the first word is longer) and ends with "…"; an empty
 * one is "New session".
 */
export function titleFromRequest(request: string): string {
  let line = (request.trim().split(/\r|\n/)[0] ?? "").trim();
  // Characters as the harness counts them (runes: code points), so a cut never splits a surrogate pair.
  const chars = Array.from(line);
  if (chars.length > MAX) {
    let cut = MAX;
    for (let i = MAX; i > 0; i--) {
      if (/\s/u.test(chars[i] ?? "")) {
        cut = i;
        break;
      }
    }
    line = `${chars
      .slice(0, cut)
      .join("")
      .replace(/[\s\p{P}]+$/u, "")}…`;
  }
  return line === "" ? "New session" : line;
}
