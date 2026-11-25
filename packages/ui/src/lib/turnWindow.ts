/**
 * Stress P1-6: a long conversation mounts only the turns near the viewport (`components/chat/useTurnWindow.ts`); every other
 * turn is an empty `<section>` of its remembered height, or of the estimate here until it has been seen. Pure helpers.
 */

/** Characters per line of the reading column (max-w-measure at 14px), for estimates only. */
const COLUMN_CHARS = 90;
const PROSE_LINE = 24;
const CODE_LINE = 20;
/** The prompt bubble's padding and the reply's head and footer rows, roughly. */
const PROMPT_CHROME = 32;
const REPLY_CHROME = 56;
const CODE_CHROME = 56;
/** A prompt shows at most eight lines until expanded. */
const PROMPT_MAX_LINES = 8;
const TOOL_ROW = 32;

/** Wrapped lines of `text` in the column. */
export function wrappedLines(text: string): number {
  if (!text) return 0;
  let lines = 0;
  for (const line of text.split("\n")) lines += Math.max(1, Math.ceil(line.length / COLUMN_CHARS));
  return lines;
}

/** Height of a reply's Markdown, roughly: prose lines at 24, fenced code lines at 20 inside a card. */
export function estimateReplyHeight(text: string): number {
  if (!text) return 0;
  let h = 0;
  const parts = text.split(/^```.*$/m);
  parts.forEach((part, i) => {
    // Odd parts are inside a fence.
    if (i % 2 === 1) h += CODE_CHROME + part.replace(/^\n|\n$/g, "").split("\n").length * CODE_LINE;
    else h += wrappedLines(part.trim()) * PROSE_LINE;
  });
  return h;
}

/** A turn's height before it has been laid out: its prompt bubble, its reply and its tool rows. */
export function estimateTurnHeight(prompt: string, reply: string, toolRows: number): number {
  const promptH = prompt ? PROMPT_CHROME + Math.min(PROMPT_MAX_LINES, wrappedLines(prompt)) * PROSE_LINE : 0;
  return Math.round(promptH + REPLY_CHROME + estimateReplyHeight(reply) + toolRows * TOOL_ROW);
}

/** How many screens of turns at the end are mounted from the start (the conversation opens at its end). */
export const TAIL_SCREENS = 2.5;
/** The newest turns are always mounted, whatever their height (the live one, scroll-on-send, the plan card). */
export const TAIL_MIN_TURNS = 3;
/** Turns within this distance of the viewport are mounted. */
export const MOUNT_MARGIN_PX = 1200;
/** Mounted turns further than this give their DOM back (the gap to the mount margin keeps a reader scrolling back and forth from remounting). */
export const UNMOUNT_MARGIN_PX = 4000;

/** Index of the first turn of the tail: from the end, turns until `screens` viewport heights are covered (at least `min`). */
export function tailStart(heights: readonly number[], viewport: number, screens = TAIL_SCREENS, min = TAIL_MIN_TURNS): number {
  let i = heights.length;
  let covered = 0;
  while (i > 0 && (heights.length - i < min || covered < viewport * screens)) {
    i--;
    covered += heights[i] ?? 0;
  }
  return i;
}

/** The keys of `keys[index]` and its `around` neighbours on each side (a jump target with the turns next to it). */
export function keysAround(keys: readonly string[], index: number, around = 1): string[] {
  const out: string[] = [];
  for (let i = Math.max(0, index - around); i <= Math.min(keys.length - 1, index + around); i++) {
    const k = keys[i];
    if (k !== undefined) out.push(k);
  }
  return out;
}
