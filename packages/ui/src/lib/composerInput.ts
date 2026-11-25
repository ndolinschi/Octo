/**
 * Stress P1-5 / P2-6: what the composer works out from its text on every keystroke, kept proportional to the edit (the
 * words at the caret), not to the whole value — a pasted log or minified file can be megabytes long.
 */

/**
 * A long unbroken "word" (a log line, base64, minified code) is shaped as one run; with Inter's kerning on, Chromium re-shapes
 * it for every line it breaks and every relayout, in time that grows faster than its length (50k characters: 2–7 s per
 * keystroke; a plain `<textarea>` with kerning off: ~20 ms). Text with such a word is set without kerning
 * (`[data-long-word]` in styles.css), and the tint layer (decision 70), a `<div>` repeating the text, stays empty above
 * these sizes: a mention in a pasted log is still sent, just not tinted.
 */
export const HIGHLIGHT_MAX_CHARS = 20_000;
export const LONG_WORD_CHARS = 1_000;

/** JavaScript's `\\s`, by code unit. */
function isSpace(c: number): boolean {
  return (
    c === 0x20 ||
    (c >= 0x09 && c <= 0x0d) ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** Above this length the text is set without kerning whatever its words (2.4 MB: ~30% of each keystroke's layout). */
export const PLAIN_SHAPING_CHARS = 100_000;

/** Whether the composer sets `text` without kerning (`[data-long-word]`): a long word in it, or a very long text. */
export function plainShaping(text: string): boolean {
  return text.length > PLAIN_SHAPING_CHARS || hasLongWord(text);
}

/** Whether `text` holds a word of `LONG_WORD_CHARS` or more (one pass; a regex took 60 ms on 2.4 MB). */
export function hasLongWord(text: string): boolean {
  if (text.length < LONG_WORD_CHARS) return false;
  let run = 0;
  for (let i = 0; i < text.length; i++) {
    if (isSpace(text.charCodeAt(i))) run = 0;
    else if (++run >= LONG_WORD_CHARS) return true;
  }
  return false;
}

/** Whether the tint layer may mirror `text` (short enough, and no word long enough to stall layout). */
export function highlightable(text: string): boolean {
  return text.length <= HIGHLIGHT_MAX_CHARS && !hasLongWord(text);
}

/** How far back from the caret the inline menu's trigger is looked for (a longer "query" is not one). */
export const TRIGGER_WINDOW = 256;
const TRIGGER = /(^|\s)([/@])([^\s/@]*)$/;

/**
 * `/` or `@` at the start of a word, up to the caret: the "+" menu's inline query and where its sigil sits. Reads only the
 * last `TRIGGER_WINDOW` characters before the caret.
 */
export function triggerAt(text: string, caret: number): { start: number; query: string } | null {
  const from = Math.max(0, caret - TRIGGER_WINDOW);
  const m = TRIGGER.exec(text.slice(from, caret));
  if (!m) return null;
  // Cut by the window: the match's own start of string is not the text's, so it needs a space before it.
  if (from > 0 && m[1] === "" && m.index === 0 && !/\s/.test(text.charAt(from - 1))) return null;
  const query = m[3] ?? "";
  return { start: caret - query.length - 1, query };
}

/**
 * The harness refuses a request body over 1 MiB (`maxBody` in apps/harness/internal/bridge/bridge.go); the message's text
 * travels JSON-encoded in it, beside a few small fields (mode, attachment ids) that the envelope allows for.
 */
export const MESSAGE_MAX_BYTES = 1 << 20;
export const MESSAGE_ENVELOPE_BYTES = 4096;
/** The quiet counter shows from this share of the limit. */
export const MESSAGE_COUNTER_FROM = 0.75;

/** Whether `text` may be near the limit (a character takes at most 6 bytes in JSON); below, nothing is counted. */
export function mayNearLimit(text: string): boolean {
  return text.length * 6 >= (MESSAGE_MAX_BYTES - MESSAGE_ENVELOPE_BYTES) * MESSAGE_COUNTER_FROM;
}
