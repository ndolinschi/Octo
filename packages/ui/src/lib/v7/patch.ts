/** Parity B2/B4: the unified diff an edit approval carries (`detail.patch`), split into lines the card colours. */

export type PatchLine = { kind: "add" | "del" | "hunk" | "meta" | "context"; text: string };

/** Lines of a unified diff; the `---` / `+++` file header counts as meta, and a trailing newline adds no empty line. */
export function patchLines(patch: string): PatchLine[] {
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((text): PatchLine => {
    if (text.startsWith("+++") || text.startsWith("---") || text.startsWith("diff ") || text.startsWith("index ")) return { kind: "meta", text };
    if (text.startsWith("@@")) return { kind: "hunk", text };
    if (text.startsWith("+")) return { kind: "add", text };
    if (text.startsWith("-")) return { kind: "del", text };
    return { kind: "context", text };
  });
}

/** Added and removed line counts of a patch. */
export function patchCounts(lines: readonly PatchLine[]): { added: number; removed: number } {
  return { added: lines.filter((l) => l.kind === "add").length, removed: lines.filter((l) => l.kind === "del").length };
}

/** The host of a fetch URL for the network card; the whole text when it does not parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    // Not a URL the card can split: it shows the text as given.
    return url;
  }
}
