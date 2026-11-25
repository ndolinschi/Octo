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
