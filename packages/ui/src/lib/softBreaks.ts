/**
 * P2-13: a single newline inside a Markdown paragraph is a line break when the paragraph reads as lines ("one per line"
 * answers, addresses, short items), and stays a space when it reads as prose hard-wrapped at a column (commit messages,
 * models that wrap at 80). A break is a wrap when the line before it is long and does not end a sentence; one such break
 * keeps the whole paragraph as prose (CommonMark, as before).
 */

/** The mdast nodes this pass reads and writes (a `break` renders as `<br>`). */
export type MdNode = { type: string; value?: string; children?: MdNode[] };

/** A line at least this long that does not end a sentence is taken as wrapped at a column (wraps are 72–100 wide). */
export const WRAP_MIN = 50;
const ENDS_SENTENCE = /[.!?:;…]["'”’)\]]*$/u;

/** True when the newlines between `lines` read as line breaks, false when they read as hard-wrapped prose. */
export function readsAsLines(lines: readonly string[]): boolean {
  for (let i = 0; i < lines.length - 1; i++) {
    const line = (lines[i] ?? "").trimEnd();
    if (line.length >= WRAP_MIN && !ENDS_SENTENCE.test(line)) return false;
  }
  return true;
}

const textOf = (n: MdNode): string => (n.type === "text" || n.type === "inlineCode" ? (n.value ?? "") : (n.children ?? []).map(textOf).join(""));

/** Splits each text node at its newlines into text and `break` nodes (inline code and nested emphasis included). */
function splitBreaks(n: MdNode): void {
  if (!n.children) return;
  n.children = n.children.flatMap((c): MdNode[] => {
    if (c.type !== "text" || !c.value?.includes("\n")) {
      splitBreaks(c);
      return [c];
    }
    return c.value.split("\n").flatMap((part, i, all) => {
      const start = i > 0 ? part.trimStart() : part;
      const value = i < all.length - 1 ? start.trimEnd() : start;
      const out: MdNode[] = value ? [{ type: "text", value }] : [];
      return i < all.length - 1 ? [...out, { type: "break" }] : out;
    });
  });
}

/** The pass over a whole tree: every paragraph whose newlines read as lines gets them as breaks. */
export function softBreaks(tree: MdNode): void {
  if (tree.type === "paragraph") {
    const lines = textOf(tree).split("\n");
    if (lines.length > 1 && readsAsLines(lines)) splitBreaks(tree);
    return;
  }
  tree.children?.forEach(softBreaks);
}

/** The remark plugin. */
export function remarkSoftBreaks() {
  return (tree: MdNode) => softBreaks(tree);
}
