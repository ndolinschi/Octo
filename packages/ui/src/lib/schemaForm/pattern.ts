/**
 * `pattern` on the client (spec 2026-11-15 §A.3). The harness compiles patterns with Go `regexp` (RE2, linear time) and
 * is the judge; the browser's engine backtracks, so a hostile pattern could hang the tab. The client therefore runs a
 * pattern only when it is plainly safe and the value is at most 1 KB; otherwise the service decides on submit.
 */

export const PATTERN_MAX_BYTES = 256;
export const PATTERN_VALUE_MAX_BYTES = 1024;

const bytes = (s: string) => new TextEncoder().encode(s).length;

/**
 * Why the schema must be refused for this pattern, or null. RE2 has no look-around and no back-references, so a pattern
 * using them would not compile in the harness either; the rest of RE2's syntax is close enough to JavaScript's that the
 * harness has the last word on anything subtler.
 */
export function patternProblem(pattern: string): string | null {
  if (bytes(pattern) > PATTERN_MAX_BYTES) return "pattern is longer than 256 bytes";
  if (/\(\?<?[=!]/.test(pattern)) return "pattern uses look-around, which Octo's local service does not support";
  if (/\\[1-9]|\\k</.test(pattern)) return "pattern uses a back-reference, which Octo's local service does not support";
  return null;
}

type Group = { inner: boolean; alternation: boolean };

/**
 * True when the browser may run the pattern without risk of catastrophic backtracking: no quantified group that contains
 * a quantifier or an alternation (`(a+)+`, `(a|aa)*`), at most two unbounded quantifiers in all (`\d*\d*` is quadratic on
 * 1 KB, fine; three is not), and it compiles here.
 */
export function patternRunnable(pattern: string): boolean {
  if (patternProblem(pattern)) return false;
  const stack: Group[] = [];
  let unbounded = 0;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c === "(") {
      stack.push({ inner: false, alternation: false });
      continue;
    }
    if (c === "|") {
      const top = stack.at(-1);
      if (top) top.alternation = true;
      continue;
    }
    if (c === ")") {
      const g = stack.pop();
      if (!g) return false;
      const q = quantifierAt(pattern, i + 1);
      if (q) {
        if (g.inner || g.alternation) return false;
        if (q.unbounded) unbounded++;
      }
      // A group that holds a quantifier makes its parents hold one too.
      const parent = stack.at(-1);
      if (parent && (g.inner || q)) parent.inner = true;
      continue;
    }
    const q = quantifierAt(pattern, i);
    if (q) {
      if (q.unbounded) unbounded++;
      const top = stack.at(-1);
      if (top) top.inner = true;
      i += q.length - 1;
    }
  }
  if (stack.length > 0 || unbounded > 2) return false;
  return compiles(pattern);
}

function quantifierAt(p: string, i: number): { unbounded: boolean; length: number } | null {
  const c = p[i];
  if (c === "*" || c === "+") return { unbounded: true, length: p[i + 1] === "?" ? 2 : 1 };
  if (c === "?") return { unbounded: false, length: 1 };
  if (c === "{") {
    const m = /^\{(\d+)(,(\d*))?\}\??/.exec(p.slice(i));
    if (!m) return null;
    return { unbounded: m[2] !== undefined && m[3] === "", length: m[0].length };
  }
  return null;
}

function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern, "u");
    return true;
  } catch {
    // Not valid in the browser's dialect (an RE2-only spelling): the harness decides on submit.
    return false;
  }
}

/**
 * The client's verdict on a value: true (matches), false (does not), or null when the client does not run this pattern
 * (unsafe, too long a value, or not compilable here) and leaves it to the service. Unanchored, as in JSON Schema.
 */
export function patternMatches(pattern: string, value: string): boolean | null {
  if (bytes(value) > PATTERN_VALUE_MAX_BYTES || !patternRunnable(pattern)) return null;
  return new RegExp(pattern, "u").test(value);
}
