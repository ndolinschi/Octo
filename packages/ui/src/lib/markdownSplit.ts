const CONTINUATION_LINE = /^\s*(?:[-*+]|\d+[.)]|>|\||={2,}|-{2,}| {4}|\t)/;

/**
 * Splits completed leading Markdown blocks away from the active trailing block while streaming so ReactMarkdown only
 * re-parses the actively growing paragraph/code block on each animation frame. Preserves 1:1 text concatenation.
 */
export function splitStableMarkdown(text: string): { stable: string[]; tail: string } {
  if (!text.includes("\n\n")) return { stable: [], tail: text };
  const stable: string[] = [];
  let blockStart = 0;
  let pos = 0;
  let fence: string | null = null;
  let lastNonEmpty = "";
  let inBlankRun = false;
  let splitCandidate = -1;

  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    const end = nl < 0 ? text.length : nl + 1;
    const line = (nl < 0 ? text.slice(pos) : text.slice(pos, nl)).replace(/\r$/, "");

    const wasInFence = fence !== null;
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    const marker = fenceMatch?.[1];
    if (fenceMatch && marker) {
      if (fence === null) fence = marker;
      else if (marker.startsWith(fence.charAt(0)) && marker.length >= fence.length && line.slice(fenceMatch[0].length).trim() === "") fence = null;
    }

    if (!wasInFence && fence === null && line.trim() === "") {
      if (!inBlankRun && lastNonEmpty !== "" && !CONTINUATION_LINE.test(lastNonEmpty)) {
        splitCandidate = end;
      } else if (splitCandidate >= 0) {
        splitCandidate = end;
      }
      inBlankRun = true;
    } else {
      if (inBlankRun && splitCandidate > blockStart && !wasInFence && !CONTINUATION_LINE.test(line)) {
        stable.push(text.slice(blockStart, splitCandidate));
        blockStart = splitCandidate;
      }
      inBlankRun = false;
      splitCandidate = -1;
      if (line.trim() !== "") lastNonEmpty = line;
    }
    pos = end;
  }

  return { stable, tail: text.slice(blockStart) };
}

const REF_DEF = /^ {0,3}\[[^\]]+\]:\s+\S/m;
const HEADING_START = /^ {0,3}#{1,6}\s/;

/**
 * Groups a long static Markdown document into ~`minChars`-sized sections so each section can use
 * `content-visibility: auto` during scrolling. Returns null for short documents or documents with
 * reference-style link definitions (which can span sections).
 */
export function splitMarkdownSections(text: string, minChars = 2400): string[] | null {
  if (text.length < minChars * 1.5 || REF_DEF.test(text)) return null;
  const { stable, tail } = splitStableMarkdown(text);
  const blocks = tail ? [...stable, tail] : stable;
  if (blocks.length < 2) return null;
  const sections: string[] = [];
  let buf = "";
  for (const block of blocks) {
    if (buf.length > 0 && (buf.length >= minChars || (buf.length >= minChars / 2 && HEADING_START.test(block)))) {
      sections.push(buf);
      buf = block;
    } else {
      buf += block;
    }
  }
  if (buf) sections.push(buf);
  return sections.length > 1 ? sections : null;
}
