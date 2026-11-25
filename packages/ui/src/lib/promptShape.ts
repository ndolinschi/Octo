/**
 * The request bubble's shape (one line: a pill; more than eight lines: "Show more"), measured after layout by Transcript's
 * `UserPrompt`. A bubble that mounts with the wrong guess is measured, re-rendered and laid out again before its first paint;
 * the turn window mounts turns while the reader scrolls, so the guess is what one costs. The guess never decides what shows:
 * the measurement does.
 */
export type PromptShape = { oneLine: boolean; overflows: boolean };

/** Characters that fit one line of the narrowest bubble (80 % of a phone's column at 16px), before anything is measured. */
const ONE_LINE_CHARS = 32;
const KEEP = 500;

const shapes = new Map<string, PromptShape>();
/** The longest text without a break that fits one line, learned from the bubbles measured (it follows the column's width). */
let fits = ONE_LINE_CHARS;

/** A first mount's guess: a text without a line break no longer than the longest one seen to fit. */
export function guessOneLine(text: string): boolean {
  return text.length > 0 && text.length <= fits && !text.includes("\n");
}

export function promptShape(text: string): PromptShape | undefined {
  return shapes.get(text);
}

/** The last measured shape of `text` (the oldest are forgotten past `KEEP`); a text without a break teaches the guess. */
export function rememberPromptShape(text: string, shape: PromptShape): void {
  shapes.delete(text);
  shapes.set(text, shape);
  if (shapes.size > KEEP) {
    const oldest = shapes.keys().next();
    if (!oldest.done) shapes.delete(oldest.value);
  }
  if (!text.includes("\n")) fits = shape.oneLine ? Math.max(fits, text.length) : Math.min(fits, text.length - 1);
}
