const LEAD_WS = /^[ \t]+/;

/**
 * Strips shared leading indentation across non-blank quoted lines (expanding leading tabs to two spaces) so deeply
 * indented lines sit cleanly next to their line numbers while preserving relative indentation in multi-line quotes.
 */
export function dedentQuote(lines: readonly string[]): string[] {
  if (lines.length === 0) return [];
  const expanded = lines.map((line) => {
    const match = LEAD_WS.exec(line);
    if (!match) return line;
    return match[0].replace(/\t/g, "  ") + line.slice(match[0].length);
  });
  let minIndent = Infinity;
  for (const line of expanded) {
    if (line.trim() === "") continue;
    const lead = line.length - line.trimStart().length;
    if (lead < minIndent) minIndent = lead;
    if (minIndent === 0) break;
  }
  if (!Number.isFinite(minIndent) || minIndent === 0) return expanded.map((l) => (l.trim() === "" ? "" : l));
  return expanded.map((l) => (l.trim() === "" ? "" : l.slice(minIndent)));
}
