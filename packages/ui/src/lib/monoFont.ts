/**
 * The `--font-mono` token (styles.css) as a font string, for the code surfaces that take one instead of CSS: the editor and
 * the diff editors (Monaco) and the terminal (xterm). One stack everywhere; the literal is the token's value, used before
 * the stylesheet is in (or outside a browser).
 */
export const MONO_FALLBACK = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

export function monoFont(root: { getPropertyValue(name: string): string } | null = readRoot()): string {
  const value = root?.getPropertyValue("--font-mono").trim() ?? "";
  return value === "" ? MONO_FALLBACK : value;
}

function readRoot(): CSSStyleDeclaration | null {
  return typeof document === "undefined" ? null : getComputedStyle(document.documentElement);
}
