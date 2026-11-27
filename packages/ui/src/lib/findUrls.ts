import { stripAnsi } from "./commands/format";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
/** An operating-system command (a window title, an OSC 8 link): `ESC ] … BEL` or `ESC ] … ESC \`. */
const OSC = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g");
const URL_RE = /https?:\/\/[^\s"'<>`\]]+/gi;

/**
 * The `http(s)` links in a terminal's output, in the order they appear, each once (colour codes, cursor codes and links
 * of an OSC 8 sequence removed first; trailing punctuation of a sentence is not part of the link). A login prints the
 * address to open and sometimes prints it again: the last one is the newest (`newestUrl`).
 */
export function findUrls(output: string): string[] {
  if (!output) return [];
  const clean = stripAnsi(output.replace(OSC, ""));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of clean.matchAll(URL_RE)) {
    const raw = m[0].replace(/[.,;:!?)}]+$/, "");
    try {
      const url = new URL(raw);
      if (!url.hostname) continue;
    } catch {
      continue;
    }
    if (seen.has(raw)) {
      // Printed again: it is the newest now.
      out.splice(out.indexOf(raw), 1);
    }
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/** The most recently printed link of `output`, or null. */
export function newestUrl(output: string): string | null {
  const all = findUrls(output);
  return all.length > 0 ? (all[all.length - 1] ?? null) : null;
}
